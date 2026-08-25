// ============================================================
// merge.ts —— L2 记录级无损合并（纯函数，无副作用、可脱离 DB 单测）
// ============================================================
// 目标：把两份快照（本地 local + 远端 remote）合并成一份"谁的都不丢"的结果。
//
// 算法（对 4 张版本化表 account/category/txn/tag 各自执行）：
//   1. 按 id 求并集。
//   2. 某 id 只在一侧 → 直接取该侧行。
//   3. 某 id 两侧都有 → 比 updated_at，大者胜（LWW 后写胜）；
//      updated_at 相等 → 用「按键名排序后的 JSON」字典序做确定性 tie-break，
//      与入参顺序无关（保证 merge(a,b) 与 merge(b,a) 对同一 id 结论一致）。
//   4. 软删也是一次"写"，remove 时同样 bump 了 updated_at；因此
//      "一方删、一方改" 谁最后动谁赢，天然由 updated_at 比较解决，
//      墓碑（deleted_at）随赢家一起保留，防止已删记录在对端复活。
//
// txn_tag（无独立版本列、复合主键）不单独合并，而是"跟随父 txn"：
//   哪一侧的 txn 行赢了，就整体采用那一侧该 txn 的标签集合。
//   （与 services 层 update 全量替换 txn_tag 的语义一致。）
//
// setting（无版本列）：按 key 求并集，冲突时 base（本地）优先，保住本机偏好。
//   注意：快照里本就不含 sync.github.*（凭据），此处不特殊处理。
//
// 兼容：容忍 v1/v2 形状的行（缺 updated_at/deleted_at 或缺 v3 account 列）——
//   归一化时 updated_at 回落到 created_at、deleted_at 视为 null，
//   v3 account 列（kind/period_*/archived_at）缺失时补 null（=普通账户）。
//   输出恒为 v3 形状（dbUserVersion=3）。
// ============================================================

import type { BackupSnapshot } from '../backup/snapshot';
import { SNAPSHOT_FORMAT_VERSION } from '../backup/snapshot';

/** 合并输出的目标 DB 版本（软删+时间戳 v2、专项账户 v3 落地后的 schema 版本）。 */
export const MERGED_DB_USER_VERSION = 3 as const;

/** 一条快照行（snake_case 列，值可为任意标量）。 */
type Row = Record<string, unknown>;

/** 合并报告：便于 UI / 日志展示"这次合并动了什么"。 */
export interface MergeReport {
  account: TableMergeStat;
  category: TableMergeStat;
  txn: TableMergeStat;
  tag: TableMergeStat;
  /** 合并后仍处于软删（deleted_at 非空）的记录数，按表统计。 */
  tombstones: { account: number; category: number; txn: number; tag: number };
}

export interface TableMergeStat {
  /** 合并结果总行数（含软删行）。 */
  total: number;
  /** 只在本地存在、被直接纳入的行数。 */
  fromLocalOnly: number;
  /** 只在远端存在、被直接纳入的行数。 */
  fromRemoteOnly: number;
  /** 两侧都有、本地版本胜出的行数。 */
  localWon: number;
  /** 两侧都有、远端版本胜出的行数。 */
  remoteWon: number;
}

export interface MergeResult {
  merged: BackupSnapshot;
  report: MergeReport;
}

// ------------------------------------------------------------
// 对外主函数：合并本地与远端两份快照。
//   base = 本地快照（setting 冲突时本地优先）；other = 远端快照。
// ------------------------------------------------------------
export function mergeSnapshots(base: BackupSnapshot, other: BackupSnapshot): MergeResult {
  const local = normalizeTables(base);
  const remote = normalizeTables(other);

  // 1) 三张纯版本化表：并集 + LWW。
  const accountM = mergeVersionedTable(local.account, remote.account);
  const categoryM = mergeVersionedTable(local.category, remote.category);
  const tagM = mergeVersionedTable(local.tag, remote.tag);

  // 2) txn：同样 LWW，但要记录每个 id 的赢家来源，供 txn_tag 跟随。
  const txnM = mergeVersionedTable(local.txn, remote.txn);

  // 3) txn_tag 跟随父 txn：按赢家来源，取对应侧该 txn 的标签集合。
  const txn_tag = mergeTxnTag(txnM.winnerSide, local.txn_tag, remote.txn_tag);

  // 4) setting：并集，本地（base）优先。
  const setting = mergeSetting(local.setting, remote.setting);

  const merged: BackupSnapshot = {
    app: 'ivy-wallet',
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    dbUserVersion: MERGED_DB_USER_VERSION,
    exportedAt: Date.now(),
    tables: {
      account: accountM.rows,
      category: categoryM.rows,
      txn: txnM.rows,
      tag: tagM.rows,
      txn_tag,
      setting,
    },
  };

  const report: MergeReport = {
    account: accountM.stat,
    category: categoryM.stat,
    txn: txnM.stat,
    tag: tagM.stat,
    tombstones: {
      account: countTombstones(accountM.rows),
      category: countTombstones(categoryM.rows),
      txn: countTombstones(txnM.rows),
      tag: countTombstones(tagM.rows),
    },
  };

  return { merged, report };
}

// ------------------------------------------------------------
// 归一化：把一份快照的各表行补齐 updated_at / deleted_at（兼容 v1）。
//   updated_at 缺失 → 回落 created_at；deleted_at 缺失 → null。
// ------------------------------------------------------------
interface NormalizedTables {
  account: Row[];
  category: Row[];
  txn: Row[];
  tag: Row[];
  txn_tag: Row[];
  setting: Row[];
}

function normalizeTables(snap: BackupSnapshot): NormalizedTables {
  const t = snap.tables;
  return {
    account: (t.account ?? []).map(normalizeVersionedRow),
    category: (t.category ?? []).map(normalizeVersionedRow),
    txn: (t.txn ?? []).map(normalizeVersionedRow),
    tag: (t.tag ?? []).map(normalizeVersionedRow),
    txn_tag: (t.txn_tag ?? []) as Row[],
    setting: (t.setting ?? []) as Row[],
  };
}

/** 补齐单行的 updated_at / deleted_at（不修改原对象，返回浅拷贝）。 */
function normalizeVersionedRow(row: Row): Row {
  const out: Row = { ...row };
  if (out.updated_at === undefined || out.updated_at === null) {
    out.updated_at = out.created_at ?? 0;
  }
  if (out.deleted_at === undefined) {
    out.deleted_at = null;
  }
  // v3 account 列：v1/v2 快照缺这些列。归一为 null（=普通账户），
  // 使跨版本快照在 snapshotDataEquals/LWW tie-break 时不因“缺列 vs 显式 null”误判。
  // 非 account 行本就没有这些键，补 null 不改变其语义（对比时两侧同样补齐）。
  if (out.kind === undefined) out.kind = null;
  if (out.period_start === undefined) out.period_start = null;
  if (out.period_end === undefined) out.period_end = null;
  if (out.archived_at === undefined) out.archived_at = null;
  return out;
}

// ------------------------------------------------------------
// 版本化表合并：并集 + LWW，返回合并行、每 id 赢家来源、统计。
// ------------------------------------------------------------
interface VersionedMerge {
  rows: Row[];
  /** id -> 'local' | 'remote'：该 id 最终采用了哪一侧的行。 */
  winnerSide: Map<string, 'local' | 'remote'>;
  stat: TableMergeStat;
}

function mergeVersionedTable(localRows: Row[], remoteRows: Row[]): VersionedMerge {
  const localById = indexById(localRows);
  const remoteById = indexById(remoteRows);
  const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);

  const rows: Row[] = [];
  const winnerSide = new Map<string, 'local' | 'remote'>();
  const stat: TableMergeStat = {
    total: 0,
    fromLocalOnly: 0,
    fromRemoteOnly: 0,
    localWon: 0,
    remoteWon: 0,
  };

  for (const id of allIds) {
    const l = localById.get(id);
    const r = remoteById.get(id);

    if (l && !r) {
      rows.push(l);
      winnerSide.set(id, 'local');
      stat.fromLocalOnly += 1;
    } else if (!l && r) {
      rows.push(r);
      winnerSide.set(id, 'remote');
      stat.fromRemoteOnly += 1;
    } else if (l && r) {
      const side = pickWinnerSide(l, r);
      rows.push(side === 'local' ? l : r);
      winnerSide.set(id, side);
      if (side === 'local') stat.localWon += 1;
      else stat.remoteWon += 1;
    }
  }

  stat.total = rows.length;
  return { rows, winnerSide, stat };
}

/**
 * 决定同一 id 的两行谁胜：
 *   1) updated_at 大者胜（LWW 后写胜）。
 *   2) updated_at 相等（极罕见的真·同毫秒并发，或**降级客户端回灌**造成的伪并发）：
 *      先比 v3 结构列完整度——保留信息更多的一方胜。这道闸专门挡住
 *      "旧版本客户端（如未更新到 v3 的缓存 PWA）把 v3 账户经其无
 *      kind/period/archived 列的 restore 往返后，kind 被抹成 NULL、却仍沿用原
 *      updated_at 回推"的场景：否则 `"kind":null` 的 canonical JSON 字典序大于
 *      `"kind":"project"`，会让被抹平的行赢下 tie-break，把专项账户悄悄降级成普通
 *      账户并全设备扩散。合法的"专项↔普通"改动会 bump updated_at，走第 1 步正常
 *      胜出，不受本闸影响。
 *   3) 完整度也相同 → 回退键名排序后的 canonical JSON 字典序（确定性、与入参顺序无关）。
 */
function pickWinnerSide(local: Row, remote: Row): 'local' | 'remote' {
  const lu = toNum(local.updated_at);
  const ru = toNum(remote.updated_at);
  if (lu > ru) return 'local';
  if (ru > lu) return 'remote';
  // updated_at 相等：先按 v3 结构列完整度裁决，保留信息更多的一方胜。
  const lc = v3StructuralScore(local);
  const rc = v3StructuralScore(remote);
  if (lc > rc) return 'local';
  if (rc > lc) return 'remote';
  // 完整度相同：按 canonical JSON 字典序，大者胜。
  const ls = canonicalJson(local);
  const rs = canonicalJson(remote);
  if (ls === rs) return 'local'; // 内容全等：取谁都一样，固定取 local。
  return rs > ls ? 'remote' : 'local';
}

/**
 * v3 账户结构列的"信息完整度"评分：统计 kind / period_start / period_end /
 * archived_at 中的非空列数。仅用于 updated_at 相等时的 tie-break，挡住降级客户端
 * 把这些列抹成 NULL 后回灌造成的静默降级。非 account 行本就没有这些列（归一化后
 * 一律为 null），两侧评分恒为 0，落到 canonical JSON 兜底，行为与旧逻辑一致。
 */
function v3StructuralScore(row: Row): number {
  let n = 0;
  if (row.kind !== null && row.kind !== undefined) n += 1;
  if (row.period_start !== null && row.period_start !== undefined) n += 1;
  if (row.period_end !== null && row.period_end !== undefined) n += 1;
  if (row.archived_at !== null && row.archived_at !== undefined) n += 1;
  return n;
}

// ------------------------------------------------------------
// txn_tag 跟随父 txn：对每个 txn id，取"赢家那一侧"该 txn 的关联行。
//   两侧都没有该 txn 的关联（无标签）→ 不产出任何行。
// ------------------------------------------------------------
function mergeTxnTag(
  winnerSide: Map<string, 'local' | 'remote'>,
  localLinks: Row[],
  remoteLinks: Row[],
): Row[] {
  const localByTxn = groupByTxnId(localLinks);
  const remoteByTxn = groupByTxnId(remoteLinks);

  const out: Row[] = [];
  for (const [txnId, side] of winnerSide) {
    const src = side === 'local' ? localByTxn : remoteByTxn;
    const links = src.get(txnId);
    if (links) out.push(...links);
  }
  return out;
}

// ------------------------------------------------------------
// setting 合并：按 key 求并集，冲突时 base（本地）优先。
// ------------------------------------------------------------
function mergeSetting(localRows: Row[], remoteRows: Row[]): Row[] {
  const byKey = new Map<string, Row>();
  // 先放远端，再用本地覆盖：本地优先。
  for (const r of remoteRows) byKey.set(String(r.key), r);
  for (const r of localRows) byKey.set(String(r.key), r);
  return Array.from(byKey.values());
}

// ------------------------------------------------------------
// 数据等价比较：忽略 exportedAt 与行顺序，只看"数据本身"是否一致。
//   用于同步编排判断"合并结果是否与远端相同 → 无本地新增 → 跳过 PUT"。
//   - 版本化表（account/category/txn/tag）先归一化（补齐 updated_at/deleted_at），
//     故 v1 远端与 v2 合并结果只要数据相同就判等（不会因缺列而误判"需推送"）。
//   - 每行做 canonical JSON、排序后比较，与列/行顺序无关；
//   - exportedAt / dbUserVersion 等元信息不参与比较。
// ------------------------------------------------------------
export function snapshotDataEquals(a: BackupSnapshot, b: BackupSnapshot): boolean {
  const na = normalizeTables(a);
  const nb = normalizeTables(b);
  const names: Array<keyof NormalizedTables> = [
    'account',
    'category',
    'txn',
    'tag',
    'txn_tag',
    'setting',
  ];
  for (const name of names) {
    if (!tableRowsEqual(na[name], nb[name])) return false;
  }
  return true;
}

/** 两组行是否等价（忽略顺序）：canonical JSON 排序后逐个比较。 */
function tableRowsEqual(a: Row[], b: Row[]): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map(canonicalJson).sort();
  const sb = b.map(canonicalJson).sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

// ------------------------------------------------------------
// 小工具
// ------------------------------------------------------------
function indexById(rows: Row[]): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows) m.set(String(r.id), r);
  return m;
}

function groupByTxnId(links: Row[]): Map<string, Row[]> {
  const m = new Map<string, Row[]>();
  for (const link of links) {
    const key = String(link.txn_id);
    const list = m.get(key) ?? [];
    list.push(link);
    m.set(key, list);
  }
  return m;
}

function countTombstones(rows: Row[]): number {
  let n = 0;
  for (const r of rows) if (r.deleted_at !== null && r.deleted_at !== undefined) n += 1;
  return n;
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 键名排序后的稳定 JSON，用于同毫秒 tie-break（与列/键插入顺序无关）。 */
function canonicalJson(row: Row): string {
  const keys = Object.keys(row).sort();
  const obj: Row = {};
  for (const k of keys) obj[k] = row[k];
  return JSON.stringify(obj);
}
