// ============================================================
// sqlConsole.test.ts —— SQL 控制台纯解析逻辑单测（S12）
// ============================================================
// 覆盖读写判定「从严」原则、多语句切分、高危分级、自动 LIMIT。
// 这些是安全的唯一防线（adapter 不区分读写），务必测牢。
// ============================================================
import { describe, expect, it } from 'vitest';
import {
  classifyStatement,
  ensureLimit,
  firstKeyword,
  planBatch,
  splitStatements,
} from '../src/pages/sqlConsole';

describe('firstKeyword 取首关键词', () => {
  it('普通语句', () => {
    expect(firstKeyword('SELECT * FROM account')).toBe('SELECT');
    expect(firstKeyword('  update txn set x=1')).toBe('UPDATE');
  });
  it('跳过行注释与块注释', () => {
    expect(firstKeyword('-- 注释\nSELECT 1')).toBe('SELECT');
    expect(firstKeyword('/* 块注释 */ delete from txn')).toBe('DELETE');
  });
  it('空 / 无关键词', () => {
    expect(firstKeyword('')).toBe('');
    expect(firstKeyword('   ')).toBe('');
    expect(firstKeyword('123')).toBe('');
  });
});

describe('splitStatements 分号切分', () => {
  it('多条语句切分并去空', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('末尾分号 / 空行不算一条', () => {
    expect(splitStatements('SELECT 1;\n\n;  ;')).toEqual(['SELECT 1']);
  });
  it('纯注释语句被剔除', () => {
    expect(splitStatements('SELECT 1; -- 注释only')).toEqual(['SELECT 1']);
  });
  it('空输入返回空数组', () => {
    expect(splitStatements('   ')).toEqual([]);
  });
});

describe('classifyStatement 读写判定', () => {
  it('只读关键词判为读、非高危', () => {
    for (const s of ['SELECT * FROM txn', 'WITH x AS (SELECT 1) SELECT * FROM x', 'PRAGMA table_info(txn)', 'EXPLAIN SELECT 1']) {
      const c = classifyStatement(s);
      expect(c.kind).toBe('read');
      expect(c.danger).toBe(false);
    }
  });

  it('普通写：INSERT、带 WHERE 的 UPDATE/DELETE 不高危', () => {
    expect(classifyStatement("INSERT INTO tag(id,name) VALUES('a','b')")).toMatchObject({
      kind: 'write',
      danger: false,
    });
    expect(classifyStatement("UPDATE txn SET note='x' WHERE id='1'")).toMatchObject({
      kind: 'write',
      danger: false,
    });
    expect(classifyStatement("DELETE FROM txn WHERE id='1'")).toMatchObject({
      kind: 'write',
      danger: false,
    });
  });

  it('高危：无 WHERE 的 UPDATE/DELETE', () => {
    expect(classifyStatement("UPDATE txn SET note='x'")).toMatchObject({
      kind: 'write',
      danger: true,
    });
    expect(classifyStatement('DELETE FROM txn')).toMatchObject({
      kind: 'write',
      danger: true,
    });
  });

  it('高危：DDL / 破坏性维护', () => {
    for (const s of ['DROP TABLE txn', 'ALTER TABLE txn ADD COLUMN x TEXT', 'VACUUM']) {
      expect(classifyStatement(s).danger).toBe(true);
    }
  });

  it('高危：任何写到 setting 表（含 token 等敏感配置）', () => {
    const c = classifyStatement("UPDATE setting SET value='x' WHERE key='k'");
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true); // 即便带 WHERE，写 setting 也算高危
    expect(c.reason).toContain('setting');
  });

  it('从严：识别不出的关键词一律当写并高危', () => {
    const c = classifyStatement('FOOBAR nonsense statement');
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
  });

  it('从严：注释后夹带的写语句仍判为写', () => {
    const c = classifyStatement("-- 看起来像查询\nDELETE FROM txn");
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
  });
});

describe('planBatch 批次判定', () => {
  it('全只读：无写、无高危', () => {
    const p = planBatch('SELECT 1; SELECT 2');
    expect(p.hasWrite).toBe(false);
    expect(p.hasDanger).toBe(false);
    expect(p.statements).toHaveLength(2);
  });

  it('写语句夹在查询里：整批标记为含写', () => {
    const p = planBatch("SELECT 1; DELETE FROM txn WHERE id='1'");
    expect(p.hasWrite).toBe(true);
    expect(p.hasDanger).toBe(false);
  });

  it('含高危：hasDanger 为真', () => {
    const p = planBatch('SELECT 1; DROP TABLE txn');
    expect(p.hasWrite).toBe(true);
    expect(p.hasDanger).toBe(true);
  });
});

describe('ensureLimit 自动限行', () => {
  it('无 LIMIT 的 SELECT 追加 LIMIT 500', () => {
    const r = ensureLimit('SELECT * FROM txn');
    expect(r.added).toBe(true);
    expect(r.sql).toBe('SELECT * FROM txn LIMIT 500');
  });
  it('已有 LIMIT 的 SELECT 不改动', () => {
    const r = ensureLimit('SELECT * FROM txn LIMIT 10');
    expect(r.added).toBe(false);
    expect(r.sql).toBe('SELECT * FROM txn LIMIT 10');
  });
  it('WITH（CTE）同样追加', () => {
    const r = ensureLimit('WITH x AS (SELECT 1) SELECT * FROM x');
    expect(r.added).toBe(true);
    expect(r.sql).toContain('LIMIT 500');
  });
  it('PRAGMA / EXPLAIN 不加 LIMIT', () => {
    expect(ensureLimit('PRAGMA table_info(txn)').added).toBe(false);
    expect(ensureLimit('EXPLAIN SELECT 1').added).toBe(false);
  });
  it('写语句不加 LIMIT', () => {
    expect(ensureLimit("DELETE FROM txn WHERE id='1'").added).toBe(false);
  });
});

// ============================================================
// 返工补测（S12 确认机制绕过 · P0 + P2）
// ============================================================

describe('P0 修复 · CTE 前缀写语句判为写（不能因首关键词 WITH 就判读）', () => {
  it('WITH ... DELETE：判写（主语句带 WHERE 不高危，但必须走确认）', () => {
    const c = classifyStatement(
      'WITH x AS (SELECT id FROM txn) DELETE FROM txn WHERE id IN (SELECT id FROM x)',
    );
    expect(c.kind).toBe('write');
    expect(c.keyword).toBe('WITH');
  });

  it('WITH ... UPDATE 无 WHERE：判写 + 高危', () => {
    const c = classifyStatement("WITH a AS (SELECT 1) UPDATE account SET name='x'");
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
    expect(c.reason).toContain('WHERE');
  });

  it('WITH ... INSERT：判写', () => {
    const c = classifyStatement(
      "WITH x AS (SELECT 1 v) INSERT INTO tag(id,name,color) SELECT 'h','h','#fff' FROM x",
    );
    expect(c.kind).toBe('write');
  });

  it('CTE body 内的嵌套括号 / WHERE 不算主语句的 WHERE（按括号配平跳过）', () => {
    // 主语句是无 WHERE 的全表 DELETE；CTE 体内的 WHERE / 嵌套子查询都不能被误当成主语句 WHERE。
    const c = classifyStatement(
      'WITH x AS (SELECT id FROM txn WHERE id IN (SELECT id FROM account)) DELETE FROM txn',
    );
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
  });

  it('多个 CTE 定义后接写语句：仍判写 + 高危', () => {
    const c = classifyStatement('WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM txn');
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
  });

  it('CTE 括号不配平 / 解析不动：从严当写 + 高危', () => {
    const c = classifyStatement('WITH x AS (SELECT 1');
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
  });

  it('CTE 写触及 setting 表：高危', () => {
    const c = classifyStatement("WITH a AS (SELECT 1) UPDATE setting SET value='x' WHERE key='k'");
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
    expect(c.reason).toContain('setting');
  });
});

describe('P0 修复 · CTE-SELECT 不误伤（真只读仍判读）', () => {
  it('WITH ... SELECT：判读、非高危', () => {
    const c = classifyStatement('WITH x AS (SELECT 1 AS v) SELECT * FROM x');
    expect(c.kind).toBe('read');
    expect(c.danger).toBe(false);
  });

  it('WITH RECURSIVE ... SELECT：判读', () => {
    const c = classifyStatement(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION SELECT x+1 FROM c WHERE x<5) SELECT * FROM c',
    );
    expect(c.kind).toBe('read');
  });

  it('planBatch：CTE 写混入只读批次 → hasWrite 为真', () => {
    const p = planBatch(
      'SELECT 1; WITH x AS (SELECT id FROM txn) DELETE FROM txn WHERE id IN (SELECT id FROM x)',
    );
    expect(p.hasWrite).toBe(true);
  });
});

describe('P0 修复 · PRAGMA 读写细化', () => {
  it('赋值式 PRAGMA（改状态）→ 写 + 高危', () => {
    for (const s of ['PRAGMA user_version = 5', 'PRAGMA foreign_keys = OFF', 'PRAGMA foreign_keys=OFF']) {
      const c = classifyStatement(s);
      expect(c.kind).toBe('write');
      expect(c.danger).toBe(true);
    }
  });

  it('查询式 PRAGMA（读值 / introspection）→ 读、不高危', () => {
    for (const s of ["PRAGMA table_info('txn')", 'PRAGMA foreign_keys', "PRAGMA foreign_key_list('txn')"]) {
      const c = classifyStatement(s);
      expect(c.kind).toBe('read');
      expect(c.danger).toBe(false);
    }
  });

  it('动作型 PRAGMA（非白名单）→ 从严当写', () => {
    for (const s of ['PRAGMA optimize', 'PRAGMA shrink_memory', 'PRAGMA wal_checkpoint(FULL)']) {
      expect(classifyStatement(s).kind).toBe('write');
    }
  });
});

describe('P2 修复 · 字符串内假 WHERE 不得降级高危', () => {
  it("UPDATE 全表、值里含 where → 仍判高危（真·无 WHERE 子句）", () => {
    const c = classifyStatement("UPDATE txn SET note='where are you'");
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(true);
  });

  it("UPDATE 全表、值里含大写 WHERE → 仍判高危", () => {
    const c = classifyStatement("UPDATE account SET icon='go to WHERE page'");
    expect(c.danger).toBe(true);
  });

  it('真 WHERE 子句 + 字符串里也含 where → 不误伤（非高危）', () => {
    const c = classifyStatement("DELETE FROM tag WHERE name='where'");
    expect(c.kind).toBe('write');
    expect(c.danger).toBe(false);
  });
});

describe('ensureLimit 修复 · 仅对主语句为结果集查询追加 LIMIT', () => {
  it('CTE 前缀写语句：绝不追加 LIMIT', () => {
    const r = ensureLimit(
      'WITH x AS (SELECT id FROM txn) DELETE FROM txn WHERE id IN (SELECT id FROM x)',
    );
    expect(r.added).toBe(false);
    expect(r.sql).not.toContain('LIMIT');
  });

  it('写型 PRAGMA：不追加 LIMIT', () => {
    expect(ensureLimit('PRAGMA user_version = 5').added).toBe(false);
  });

  it('CTE-SELECT：仍追加 LIMIT', () => {
    const r = ensureLimit('WITH x AS (SELECT 1 AS v) SELECT * FROM x');
    expect(r.added).toBe(true);
    expect(r.sql).toContain('LIMIT 500');
  });
});
