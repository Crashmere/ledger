// ============================================================
// sqlConsole.ts —— SQL 控制台的纯前端解析逻辑（S12）
// ============================================================
// 本文件只放**纯函数**：语句切分、读写/高危判定、自动 LIMIT。
// 红线：绝不 import adapter / db / 任何有副作用的模块——保持可单测、零副作用。
//
// 背景：底层 adapter 的 all / run 都是同一个 exec，SQLite 不区分读写，
// 所以「这条 SQL 是读还是写」只能靠前端解析判断。判定务必**从严**：
// 识别不出、解析不动、拿不准的，一律当作「写 + 高危」，走二次确认，绝不放过潜在写操作。
//
// ⚠ 两个曾被 SQL 语法绕过的坑（本文件已修）：
//   1. CTE 前缀写：`WITH x AS (...) DELETE/UPDATE/INSERT ...` 首关键词是 WITH，
//      不能因此判读——必须按括号配平跳过 CTE 定义，拿到「主语句关键词」再判定。
//   2. 假 WHERE：`UPDATE txn SET note='where are you'` 字符串里含 where，
//      不能算真 WHERE 子句——判 WHERE 前先剥离字符串字面量与注释，只在「代码骨架」上匹配。
// ============================================================

/** 单条语句的分类结果。 */
export interface StatementClass {
  /** 原始语句文本（已去首尾空白，不含末尾分号）。 */
  sql: string;
  /** 读 / 写。识别不出的关键词一律当「写」（从严）。 */
  kind: 'read' | 'write';
  /** 是否高危写操作（无 WHERE 的全表改删、DDL、写 setting 表、写型 PRAGMA、解析不动等）。 */
  danger: boolean;
  /** 语句首关键词（大写）；空语句为 ''。 */
  keyword: string;
  /** 高危原因（仅 danger 为 true 时给出，用于确认窗展示）。 */
  reason?: string;
}

/** 已知写关键词（用于「非只读关键词」判定与提示文案）。 */
const KNOWN_WRITE = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'VACUUM',
]);

/**
 * 纯查询型（introspection）PRAGMA：函数式 `PRAGMA name(args)` 与裸写 `PRAGMA name`
 * 都只读取信息、不改状态。它们的函数式调用可安全判读。
 */
const INTROSPECT_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'foreign_key_check',
  'database_list',
  'collation_list',
  'function_list',
  'module_list',
  'pragma_list',
  'compile_options',
  'integrity_check',
  'quick_check',
]);

/**
 * 可设置、但**裸写形式**（无 `=`、无括号）只是读取当前值的标量 PRAGMA。
 * 仅裸写形式判读；带 `=` 或函数式 `name(value)` 都是设置 → 从严判写。
 */
const SCALAR_READ_PRAGMAS = new Set([
  'foreign_keys',
  'user_version',
  'schema_version',
  'application_id',
  'data_version',
  'page_count',
  'page_size',
  'freelist_count',
  'cache_size',
  'journal_mode',
  'synchronous',
  'auto_vacuum',
  'encoding',
  'secure_delete',
  'temp_store',
  'mmap_size',
  'busy_timeout',
  'wal_autocheckpoint',
  'locking_mode',
  'max_page_count',
  'recursive_triggers',
  'read_uncommitted',
]);

/**
 * 把字符串字面量与注释替换成空格，得到用于关键字 / 结构（括号配平、WHERE）匹配的
 * 「代码骨架」。这样字符串里的 where / ( ) / AS 等不会干扰读写与结构判定。
 * 处理：
 *   - 单引号、双引号、反引号字符串（闭合符出现两次表示转义）、方括号标识符；
 *   - 行注释（保留换行）、C 风格块注释。
 * 被剥离的整段替换为一个空格，避免误粘连相邻 token。
 */
function toSkeleton(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // 三种成对引号字符串 / 标识符：闭合符出现两次表示转义（[] 除外，无转义）。
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // 转义，留在串内
            continue;
          }
          i += 1; // 闭合
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < n && sql[i] !== ']') i += 1;
      if (i < n) i += 1; // 吃掉 ]
      out += ' ';
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      out += ' ';
      if (nl === -1) {
        i = n;
      } else {
        out += '\n'; // 保留换行，便于其余逻辑读取
        i = nl + 1;
      }
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 去掉语句开头的空白与注释（-- 行注释 / C 风格块注释），
 * 以便正确取到「第一个真正的关键词」。
 * 只处理开头，够用即可（个人自用工具）。
 */
function stripLeading(sql: string): string {
  let s = sql;
  // 反复剥离，直到开头既不是空白也不是注释。
  // 防御性上限，避免异常输入造成的极端循环。
  for (let i = 0; i < 100; i += 1) {
    const before = s;
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end === -1 ? '' : s.slice(end + 2);
    }
    if (s === before) break;
  }
  return s;
}

/** 取语句首关键词（大写）。无有效内容时返回 ''。 */
export function firstKeyword(sql: string): string {
  const s = stripLeading(sql);
  const m = s.match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : '';
}

/**
 * 把整段输入按分号切分成多条语句。
 * - 去掉纯空白 / 纯注释的空语句（末尾分号、空行不算一条）。
 * - 不处理「字符串字面量里含分号」这种极端情况（个人自用工具，够用即可；
 *   若切出的某条语法错，执行时 SQLite 自会报错，可接受）。
 */
export function splitStatements(input: string): string[] {
  return input
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && stripLeading(s).length > 0);
}

/**
 * 判断「代码骨架」是否含 WHERE 子句（词边界、大小写不敏感）。
 * 入参必须是已剥离字符串 / 注释的骨架（见 toSkeleton），否则字符串里的 where 会误判。
 */
function hasWhere(skeleton: string): boolean {
  return /\bWHERE\b/i.test(skeleton);
}

/** 判断骨架是否可能写到 / 触及 setting 表（含 GitHub token 等敏感配置）。 */
function touchesSetting(skeleton: string): boolean {
  return /\bsetting\b/i.test(skeleton);
}

/**
 * 从 openIdx 处的 `(` 起做括号配平，返回匹配的 `)` 下标；不配平返回 -1。
 * 入参应为骨架（已无字符串），故括号计数可靠。
 */
function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 在骨架 s 中找到「深度 0」处的独立单词 `AS`，返回其起始下标；找不到返回 -1。 */
function findTopLevelAs(s: string): number {
  let depth = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(s[j])) j += 1;
      if (s.slice(i, j).toUpperCase() === 'AS') return i;
      i = j;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * 解析 CTE：跳过 `WITH [RECURSIVE] name [(cols)] AS [ [NOT] MATERIALIZED ] ( body )` 的
 * 一个或多个定义（按括号配平跳过 body，body 内的嵌套括号 / WHERE / 分号不受影响），
 * 拿到 CTE 列表之后「主语句」的关键词与其骨架文本。
 * 入参 skel 必须是骨架（已剥离字符串 / 注释）。解析不动一律返回 null（调用方从严当写 + 高危）。
 */
function parseCTE(skel: string): { keyword: string; mainSkel: string } | null {
  let s = skel.replace(/^\s+/, '');
  const wm = s.match(/^WITH\b/i);
  if (!wm) return null;
  s = s.slice(wm[0].length).replace(/^\s+/, '');
  const rm = s.match(/^RECURSIVE\b/i);
  if (rm) s = s.slice(rm[0].length).replace(/^\s+/, '');

  // 逐个 CTE 定义；防御性上限避免异常输入死循环。
  for (let guard = 0; guard < 200; guard += 1) {
    const asIdx = findTopLevelAs(s);
    if (asIdx === -1) return null; // 找不到 AS：解析不动
    let rest = s.slice(asIdx + 2).replace(/^\s+/, '');
    const nm = rest.match(/^(NOT\s+)?MATERIALIZED\b/i);
    if (nm) rest = rest.slice(nm[0].length).replace(/^\s+/, '');
    if (rest[0] !== '(') return null; // AS 后不是 CTE body 开括号
    const close = matchParen(rest, 0);
    if (close === -1) return null; // 括号不配平
    const after = rest.slice(close + 1).replace(/^\s+/, '');
    if (after[0] === ',') {
      s = after.slice(1).replace(/^\s+/, ''); // 还有下一个 CTE
      continue;
    }
    const km = after.match(/^[A-Za-z]+/);
    if (!km) return null; // CTE 之后无主语句关键词
    return { keyword: km[0].toUpperCase(), mainSkel: after };
  }
  return null;
}

/**
 * 由「有效关键词 + 骨架」构造一个写判定结果，逐项判定高危原因：
 *   - DELETE / UPDATE 且主语句骨架无 WHERE（全表改删）；
 *   - DROP / ALTER / TRUNCATE / VACUUM（DDL / 破坏性维护）；
 *   - 任何触及 setting 表的语句（改错会影响云备份凭据）；
 *   - 非已知写关键词（识别不出，从严）。
 * @param trimmed        原始语句（用于回填 sql 字段）
 * @param skel           整条语句骨架（用于 setting 检测）
 * @param effKeyword     有效判定关键词（普通语句=首关键词；CTE=主语句关键词）
 * @param displayKeyword 展示用首关键词（普通语句=首关键词；CTE 固定为 'WITH'）
 * @param whereSkel      判 WHERE 用的骨架（普通语句=整句骨架；CTE=主语句骨架）
 */
function buildWrite(
  trimmed: string,
  skel: string,
  effKeyword: string,
  displayKeyword: string,
  whereSkel: string,
): StatementClass {
  const reasons: string[] = [];
  if ((effKeyword === 'DELETE' || effKeyword === 'UPDATE') && !hasWhere(whereSkel)) {
    reasons.push(`${effKeyword} 未带 WHERE（将影响整表）`);
  }
  if (
    effKeyword === 'DROP' ||
    effKeyword === 'ALTER' ||
    effKeyword === 'TRUNCATE' ||
    effKeyword === 'VACUUM'
  ) {
    reasons.push(`${effKeyword} 结构 / 破坏性操作`);
  }
  if (touchesSetting(skel)) {
    reasons.push('写入 setting 表（含云备份等敏感配置）');
  }
  if (effKeyword === '') {
    reasons.push('无法识别的语句，从严按写操作处理');
  } else if (!KNOWN_WRITE.has(effKeyword)) {
    reasons.push(`无法识别的语句（${effKeyword}），从严按写操作处理`);
  }
  return {
    sql: trimmed,
    kind: 'write',
    danger: reasons.length > 0,
    keyword: displayKeyword,
    reason: reasons.length > 0 ? reasons.join('；') : undefined,
  };
}

/**
 * PRAGMA 读写细化（从严）：
 *   - 出现 `=`（赋值式，如 `PRAGMA user_version = 5`、`PRAGMA foreign_keys=OFF`）→ 写；
 *   - 函数式 `PRAGMA name(args)`：仅 introspection 白名单判读，其余（如 `wal_checkpoint(...)`、
 *     `foreign_keys(OFF)`）从严判写；
 *   - 裸写 `PRAGMA name`：introspection 或标量读白名单判读，其余（如 `shrink_memory`、
 *     `optimize`、`wal_checkpoint`）从严判写；
 *   - 拿不准一律判写。写型 PRAGMA 会改数据库状态（关约束、篡改版本号等），标记高危。
 */
function classifyPragma(trimmed: string, skel: string): StatementClass {
  // 支持可选的 `schema.` 前缀，取最后一个标识符为 pragma 名。
  const m = skel.match(
    /^\s*PRAGMA\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)/i,
  );
  const name = m ? m[1].toLowerCase() : '';
  // pragma 名之后的部分，用于判断 = / 括号。
  const tail = m ? skel.slice(skel.indexOf(m[0]) + m[0].length) : skel;
  const hasAssign = /=/.test(tail);
  const hasArgs = /^\s*\(/.test(tail);

  let isRead: boolean;
  if (hasAssign) {
    isRead = false; // 赋值式一律写
  } else if (hasArgs) {
    isRead = INTROSPECT_PRAGMAS.has(name); // 函数式：仅 introspection 判读
  } else {
    isRead = INTROSPECT_PRAGMAS.has(name) || SCALAR_READ_PRAGMAS.has(name); // 裸写：白名单判读
  }

  if (isRead) {
    return { sql: trimmed, kind: 'read', danger: false, keyword: 'PRAGMA' };
  }
  return {
    sql: trimmed,
    kind: 'write',
    danger: true,
    keyword: 'PRAGMA',
    reason: 'PRAGMA 会修改数据库状态（设置版本号 / 关外键约束等），从严按高危写处理',
  };
}

/**
 * 分类单条语句：读 / 写 + 是否高危。
 *
 * 读：SELECT / EXPLAIN（EXPLAIN 只解释不执行，任意后缀都安全）；
 *     WITH 主语句为 SELECT 的 CTE 查询；纯查询型 PRAGMA。
 * 写：INSERT / UPDATE / DELETE / REPLACE / CREATE / DROP / ALTER / TRUNCATE /
 *     VACUUM，CTE 前缀写语句，赋值式 / 动作型 PRAGMA，及**一切非只读关键词**（从严）。
 */
export function classifyStatement(sql: string): StatementClass {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  const skel = toSkeleton(trimmed);
  const keyword = firstKeyword(trimmed);

  // SELECT / EXPLAIN：无条件只读（EXPLAIN 仅返回执行计划，从不落库）。
  if (keyword === 'SELECT' || keyword === 'EXPLAIN') {
    return { sql: trimmed, kind: 'read', danger: false, keyword };
  }

  // WITH（CTE）：解析到主语句关键词再判定；解析不动 → 从严当写 + 高危。
  if (keyword === 'WITH') {
    const cte = parseCTE(skel);
    if (cte === null) {
      return {
        sql: trimmed,
        kind: 'write',
        danger: true,
        keyword: 'WITH',
        reason: 'WITH（CTE）主语句无法解析，从严按高危写处理',
      };
    }
    if (cte.keyword === 'SELECT') {
      // CTE 后是查询：真只读。
      return { sql: trimmed, kind: 'read', danger: false, keyword: 'WITH' };
    }
    // CTE 后是写语句：按主关键词套用写 / 高危判定（WHERE 只看主语句骨架）。
    return buildWrite(trimmed, skel, cte.keyword, 'WITH', cte.mainSkel);
  }

  // PRAGMA：赋值 / 动作型判写，查询型判读。
  if (keyword === 'PRAGMA') {
    return classifyPragma(trimmed, skel);
  }

  // 其余：一律当写（普通语句 WHERE 看整句骨架）。
  return buildWrite(trimmed, skel, keyword, keyword, skel);
}

/** 一批语句的整体判定摘要。 */
export interface BatchPlan {
  statements: StatementClass[];
  /** 是否含任意写语句（含则需二次确认）。 */
  hasWrite: boolean;
  /** 是否含任意高危写语句（含则需手输确认词）。 */
  hasDanger: boolean;
}

/** 对整段输入切分 + 逐条分类，得到执行前的判定摘要。 */
export function planBatch(input: string): BatchPlan {
  const statements = splitStatements(input).map(classifyStatement);
  return {
    statements,
    hasWrite: statements.some((s) => s.kind === 'write'),
    hasDanger: statements.some((s) => s.danger),
  };
}

/**
 * 结果集查询语句若未显式写 LIMIT，则自动追加 ` LIMIT 500`，避免误查全表卡死渲染。
 * **只对「主语句确为 SELECT / WITH-SELECT 的只读结果集查询」追加**（复用 classifyStatement 的
 * 主关键词解析）；CTE 前缀写（`WITH ... DELETE/INSERT/UPDATE`）、PRAGMA、EXPLAIN、写语句一律不动。
 * 返回 { sql, added }：added 标记是否发生了自动追加（用于结果区提示）。
 */
export function ensureLimit(sql: string, cap = 500): { sql: string; added: boolean } {
  const trimmed = sql.trim().replace(/;+\s*$/, '');
  const c = classifyStatement(trimmed);
  // 仅 SELECT（普通）与 WITH（此时 classify 已确认主语句为 SELECT 才判 read）可追加。
  const limitable = c.kind === 'read' && (c.keyword === 'SELECT' || c.keyword === 'WITH');
  if (!limitable) {
    return { sql: trimmed, added: false };
  }
  // 只看骨架里是否已有 LIMIT，避免字符串里的 "limit" 误判。
  if (/\bLIMIT\b/i.test(toSkeleton(trimmed))) {
    return { sql: trimmed, added: false };
  }
  return { sql: `${trimmed} LIMIT ${cap}`, added: true };
}
