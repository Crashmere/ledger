// ============================================================
// snapshot.ts —— JSON 快照：导出（6 表）+ 校验 + 恢复（事务清空+写回）
// ============================================================
// 权威来源：S8 任务书 §2、§5.1、§0.4/§0.5。
//
// 设计要点（务必保留）：
//   1. 走 JSON 快照，不碰二进制 importBytes、不改 db 层。恢复只用
//      getAdapter() 暴露的 all/run/transaction。
//   2. 导出：每张业务表 SELECT * 原样取列（snake_case），金额是整数分，
//      不做任何单位换算。setting 表剔除 `sync.github.*`（Token 等凭据不进备份）。
//   3. 恢复：复用 S7 persistImport 的范式 —— 一个事务内先反外键顺序清空，
//      再正外键顺序裸 INSERT 保留原 id；setting 表【只逐条 UPSERT、绝不 DELETE
//      全表】，否则会抹掉本机 sync.github.* 配置（自毁）。
//   4. 全程一个 adapter.transaction，任一步失败整体回滚，绝不留半吊子数据。
//
// 本文件不依赖 Vue，仅依赖 SqliteAdapter 接口，可脱离 UI 单测。
// ============================================================

import type { SqliteAdapter } from '../../db/adapter';
import { isSyncKey } from './keys';

// ------------------------------------------------------------
// 快照结构（本文件自己的格式版本，与 DB schema 版本区分）
// ------------------------------------------------------------
export interface BackupSnapshot {
  app: 'ivy-wallet';
  formatVersion: 1; // 快照格式版本
  dbUserVersion: number; // 导出时的 PRAGMA user_version（=1），恢复时校验
  exportedAt: number; // epoch ms
  tables: {
    account: Record<string, unknown>[];
    category: Record<string, unknown>[];
    txn: Record<string, unknown>[];
    tag: Record<string, unknown>[];
    txn_tag: Record<string, unknown>[];
    setting: Record<string, unknown>[]; // 已剔除 sync.github.* 配置
  };
}

/** 当前支持的快照格式版本。 */
export const SNAPSHOT_FORMAT_VERSION = 1 as const;

/** 快照覆盖的业务表（不含 setting，setting 单独 UPSERT 处理）。 */
const BUSINESS_TABLES = ['account', 'category', 'txn', 'tag', 'txn_tag'] as const;

// ------------------------------------------------------------
// 导出：把本机 6 张表整体读出为一份快照对象。
//   - setting 剔除 sync.github.*（Token 等凭据不进备份）。
//   - 其它表 SELECT * 原样，金额整数分不换算。
// ------------------------------------------------------------
export async function exportSnapshot(adapter: SqliteAdapter): Promise<BackupSnapshot> {
  const [account, category, txn, tag, txn_tag] = await Promise.all([
    adapter.all('SELECT * FROM account'),
    adapter.all('SELECT * FROM category'),
    adapter.all('SELECT * FROM txn'),
    adapter.all('SELECT * FROM tag'),
    adapter.all('SELECT * FROM txn_tag'),
  ]);

  // setting：读全量后过滤掉「本机配置」（sync.github.*）。
  const settingRows = await adapter.all<{ key: string; value: string | null }>(
    'SELECT key, value FROM setting',
  );
  const setting = settingRows.filter((r) => !isSyncKey(r.key));

  const dbUserVersion = await adapter.getUserVersion();

  return {
    app: 'ivy-wallet',
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    dbUserVersion,
    exportedAt: Date.now(),
    tables: { account, category, txn, tag, txn_tag, setting },
  };
}

/** 序列化为便于在 GitHub 上 diff 的美化 JSON（2 空格缩进）。 */
export function serializeSnapshot(snap: BackupSnapshot): string {
  return JSON.stringify(snap, null, 2);
}

// ------------------------------------------------------------
// 校验：结构化检查，通不过就拒绝、不写库。
// ------------------------------------------------------------
export interface ParseSnapshotResult {
  ok: boolean;
  snapshot?: BackupSnapshot;
  error?: string;
}

/**
 * 解析并校验一份（可能来自远端/本地文件的）JSON 文本为快照。
 * - JSON 非法 / 顶层非对象 → 报错。
 * - app / formatVersion / tables 结构不符 → 报错。
 * - dbUserVersion 与当前库不一致 → 报错（避免结构错配写坏库）。
 */
export function parseSnapshot(text: string, currentDbUserVersion: number): ParseSnapshotResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '不是有效的 JSON，无法识别为备份快照。' };
  }
  return validateSnapshot(data, currentDbUserVersion);
}

/** 校验一个已解析的对象是否为合法快照。 */
export function validateSnapshot(data: unknown, currentDbUserVersion: number): ParseSnapshotResult {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: '快照顶层不是对象。' };
  }
  const obj = data as Record<string, unknown>;

  if (obj.app !== 'ivy-wallet') {
    return { ok: false, error: '不是本应用的备份快照（app 字段不匹配）。' };
  }
  if (obj.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      error: `快照格式版本不支持（期望 ${SNAPSHOT_FORMAT_VERSION}，实际 ${String(obj.formatVersion)}）。`,
    };
  }
  if (typeof obj.dbUserVersion !== 'number' || obj.dbUserVersion !== currentDbUserVersion) {
    return {
      ok: false,
      error: `数据库版本不一致（快照 ${String(obj.dbUserVersion)}，当前 ${currentDbUserVersion}），拒绝恢复以免结构错配。`,
    };
  }

  const tables = obj.tables;
  if (typeof tables !== 'object' || tables === null) {
    return { ok: false, error: '快照缺少 tables 字段。' };
  }
  const t = tables as Record<string, unknown>;
  for (const name of [...BUSINESS_TABLES, 'setting']) {
    if (!Array.isArray(t[name])) {
      return { ok: false, error: `快照缺少表或格式非法：${name}。` };
    }
  }

  return { ok: true, snapshot: obj as unknown as BackupSnapshot };
}

/** 快照各表条数（预览用）。 */
export interface SnapshotCounts {
  account: number;
  category: number;
  txn: number;
  tag: number;
  txn_tag: number;
  setting: number;
}

export function snapshotCounts(snap: BackupSnapshot): SnapshotCounts {
  return {
    account: snap.tables.account.length,
    category: snap.tables.category.length,
    txn: snap.tables.txn.length,
    tag: snap.tables.tag.length,
    txn_tag: snap.tables.txn_tag.length,
    setting: snap.tables.setting.length,
  };
}

// ------------------------------------------------------------
// 恢复：在一个事务里清空并写回（复用 persistImport 范式）。
//   - 反外键顺序清空：txn_tag → txn → category → account → tag。
//   - 正外键顺序写回：account → category → txn → tag → txn_tag（裸 INSERT 保留原 id）。
//   - setting：只逐条 UPSERT 快照里的键，绝不 DELETE 全表 —— 保全本机 sync.github.*。
//   - 用显式列名参数化 INSERT，不依赖 SELECT * 的列序做 positional 插入。
//   - 整体包在 adapter.transaction：任一步失败全回滚。
// ------------------------------------------------------------
export async function restoreSnapshot(
  adapter: SqliteAdapter,
  snap: BackupSnapshot,
): Promise<void> {
  const { account, category, txn, tag, txn_tag, setting } = snap.tables;

  await adapter.transaction(async (tx) => {
    // 1) 反外键顺序清空业务表（不动 setting）。
    await tx.run('DELETE FROM txn_tag');
    await tx.run('DELETE FROM txn');
    await tx.run('DELETE FROM category');
    await tx.run('DELETE FROM account');
    await tx.run('DELETE FROM tag');

    // 2) 正外键顺序写回（显式列名，保留原 id）。
    for (const a of account) {
      await tx.run(
        `INSERT INTO account(id,name,color,icon,initial_balance,include_in_balance,order_num,created_at)
         VALUES(?,?,?,?,?,?,?,?)`,
        [
          a.id,
          a.name,
          a.color,
          a.icon ?? null,
          a.initial_balance,
          a.include_in_balance,
          a.order_num,
          a.created_at,
        ],
      );
    }

    for (const c of category) {
      await tx.run(
        `INSERT INTO category(id,account_id,name,color,icon,order_num,created_at)
         VALUES(?,?,?,?,?,?,?)`,
        [c.id, c.account_id, c.name, c.color, c.icon ?? null, c.order_num, c.created_at],
      );
    }

    for (const t of txn) {
      await tx.run(
        `INSERT INTO txn(id,type,amount,account_id,to_account_id,category_id,time,title,note,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [
          t.id,
          t.type,
          t.amount,
          t.account_id,
          t.to_account_id ?? null,
          t.category_id ?? null,
          t.time,
          t.title ?? null,
          t.note ?? null,
          t.created_at,
        ],
      );
    }

    for (const g of tag) {
      await tx.run(
        `INSERT INTO tag(id,name,color,icon,order_num,created_at) VALUES(?,?,?,?,?,?)`,
        [g.id, g.name, g.color, g.icon ?? null, g.order_num, g.created_at],
      );
    }

    for (const r of txn_tag) {
      await tx.run(`INSERT INTO txn_tag(txn_id,tag_id) VALUES(?,?)`, [r.txn_id, r.tag_id]);
    }

    // 3) setting：只逐条 UPSERT 快照里的键，绝不清空整表（保全本机 sync.github.*）。
    for (const s of setting) {
      // 双保险：即便快照混入了 sync.* 也跳过，绝不覆盖本机凭据配置。
      if (isSyncKey(String(s.key))) continue;
      await tx.run(
        `INSERT INTO setting(key,value) VALUES(?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [s.key, s.value ?? null],
      );
    }
  });
}
