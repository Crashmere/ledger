// ============================================================
// backup.test.ts —— S8 云备份单测（Vitest + Node 内存库）
// ============================================================
// 覆盖 S8 任务书 §六 DoD 关键项：
//   - 往返一致性：导出快照 → 恢复 → 各表条数与内容一致，金额（整数分）无漂移。
//   - setting 过滤：导出快照剔除 sync.github.*（Token 等凭据不进备份）。
//   - 配置保全：恢复后本机 sync.github.* 依然在（setting 只 UPSERT，绝不清表）。
//   - base64 UTF-8 往返（含中文）。
//   - 校验：app/formatVersion/dbUserVersion 不符时拒绝、不写库。
// 复用真实备份 JSON 建库（4/16/468），保证与生产数据同形。
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { BetterSqliteAdapter, makeTestAdapter } from './better-sqlite-adapter';
import { importLegacyBackup, persistImport, type LegacyBackup } from '../src/services/import/legacyBackup';
import {
  exportSnapshot,
  serializeSnapshot,
  parseSnapshot,
  validateSnapshot,
  restoreSnapshot,
  snapshotCounts,
} from '../src/services/backup/snapshot';
import { utf8ToBase64, base64ToUtf8 } from '../src/services/backup/github';
import { SYNC_KEYS, isSyncKey } from '../src/services/backup/keys';

const BACKUP_PATH = fileURLToPath(
  new URL('../新记账系统-交接资料/参考数据-旧应用真实备份.json', import.meta.url),
);
const backup = JSON.parse(readFileSync(BACKUP_PATH, 'utf-8')) as LegacyBackup;
const NOW = 1_754_700_000_000;

/** COUNT(*) 小工具。 */
async function count(adapter: BetterSqliteAdapter, table: string): Promise<number> {
  const row = await adapter.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return row?.n ?? 0;
}

/** 建一个已导入真实数据、并带若干 setting（含 sync.github.*）的库。 */
async function seededAdapter(): Promise<BetterSqliteAdapter> {
  const adapter = await makeTestAdapter();
  const r = importLegacyBackup(backup, NOW);
  await persistImport(adapter, r, { mode: 'replace' });
  // 造几个标签与关联，覆盖 tag/txn_tag 往返。
  await adapter.run(`INSERT INTO tag(id,name,color,icon,order_num,created_at) VALUES(?,?,?,?,?,?)`, [
    'tag-1',
    '日常',
    123,
    null,
    0,
    NOW,
  ]);
  const firstTxn = await adapter.get<{ id: string }>('SELECT id FROM txn LIMIT 1');
  await adapter.run(`INSERT INTO txn_tag(txn_id,tag_id) VALUES(?,?)`, [firstTxn!.id, 'tag-1']);
  // 普通业务 setting（应进快照）+ 本机凭据 setting（不应进快照）。
  await adapter.run(`INSERT INTO setting(key,value) VALUES(?,?)`, ['ui.theme', 'dark']);
  await adapter.run(`INSERT INTO setting(key,value) VALUES(?,?)`, [SYNC_KEYS.owner, 'me']);
  await adapter.run(`INSERT INTO setting(key,value) VALUES(?,?)`, [SYNC_KEYS.repo, 'ivy_bak']);
  await adapter.run(`INSERT INTO setting(key,value) VALUES(?,?)`, [SYNC_KEYS.token, 'ghp_secret_TOKEN']);
  return adapter;
}

describe('exportSnapshot（导出快照）', () => {
  let adapter: BetterSqliteAdapter;
  beforeEach(async () => {
    adapter = await seededAdapter();
  });
  afterEach(() => adapter.close());

  it('覆盖 6 张表，业务表条数与库一致', async () => {
    const snap = await exportSnapshot(adapter);
    const c = snapshotCounts(snap);
    expect(c.account).toBe(4);
    expect(c.category).toBe(16);
    expect(c.txn).toBe(468);
    expect(c.tag).toBe(1);
    expect(c.txn_tag).toBe(1);
    expect(snap.app).toBe('ivy-wallet');
    expect(snap.formatVersion).toBe(1);
    expect(snap.dbUserVersion).toBe(1);
  });

  it('setting 剔除所有 sync.github.*（Token 不进快照）', async () => {
    const snap = await exportSnapshot(adapter);
    const keys = snap.tables.setting.map((s) => String(s.key));
    // 业务 setting 保留。
    expect(keys).toContain('ui.theme');
    // 本机配置一律剔除。
    for (const k of keys) expect(isSyncKey(k)).toBe(false);
    // 序列化后的 JSON 文本里绝不能出现 token 值。
    const text = serializeSnapshot(snap);
    expect(text).not.toContain('ghp_secret_TOKEN');
    expect(text).not.toContain('sync.github.');
  });
});

describe('往返一致性（导出 → 恢复 → 计数与内容一致）', () => {
  let src: BetterSqliteAdapter;
  let dst: BetterSqliteAdapter;
  beforeEach(async () => {
    src = await seededAdapter();
    dst = await makeTestAdapter();
  });
  afterEach(() => {
    src.close();
    dst.close();
  });

  it('恢复到空库后各表条数一致', async () => {
    const snap = await exportSnapshot(src);
    await restoreSnapshot(dst, snap);
    expect(await count(dst, 'account')).toBe(4);
    expect(await count(dst, 'category')).toBe(16);
    expect(await count(dst, 'txn')).toBe(468);
    expect(await count(dst, 'tag')).toBe(1);
    expect(await count(dst, 'txn_tag')).toBe(1);
  });

  it('金额（整数分）无漂移，抽查行字段一致', async () => {
    const snap = await exportSnapshot(src);
    await restoreSnapshot(dst, snap);

    const srcSum = await src.get<{ s: number }>('SELECT COALESCE(SUM(amount),0) AS s FROM txn');
    const dstSum = await dst.get<{ s: number }>('SELECT COALESCE(SUM(amount),0) AS s FROM txn');
    expect(dstSum?.s).toBe(srcSum?.s);

    // 抽一笔转账，核对保留原 id 且字段一致。
    const t = await src.get<Record<string, unknown>>(`SELECT * FROM txn WHERE type='transfer' LIMIT 1`);
    const t2 = await dst.get<Record<string, unknown>>('SELECT * FROM txn WHERE id=?', [t!.id]);
    expect(t2).toEqual(t);
  });

  it('恢复对已有数据的库也稳定（先清空再写回，不叠加）', async () => {
    const snap = await exportSnapshot(src);
    // dst 先塞入一份别的数据，再恢复，应被完全覆盖为快照内容。
    const r = importLegacyBackup(backup, NOW);
    await persistImport(dst, r, { mode: 'replace' });
    await restoreSnapshot(dst, snap);
    expect(await count(dst, 'account')).toBe(4);
    expect(await count(dst, 'txn')).toBe(468);
  });
});

describe('配置保全（恢复不覆盖本机 sync.github.*）', () => {
  it('恢复后本机 owner/repo/token 依然在，且被恢复的业务 setting 生效', async () => {
    const src = await seededAdapter();
    const dst = await makeTestAdapter();
    // dst 是「本机」：已配置好 GitHub（含 token）。
    await dst.run(`INSERT INTO setting(key,value) VALUES(?,?)`, [SYNC_KEYS.owner, 'local-owner']);
    await dst.run(`INSERT INTO setting(key,value) VALUES(?,?)`, [SYNC_KEYS.token, 'local-token']);

    const snap = await exportSnapshot(src); // 快照含 ui.theme，但不含 sync.*
    await restoreSnapshot(dst, snap);

    // 本机凭据保全（未被清空/覆盖）。
    const owner = await dst.get<{ value: string }>('SELECT value FROM setting WHERE key=?', [SYNC_KEYS.owner]);
    const token = await dst.get<{ value: string }>('SELECT value FROM setting WHERE key=?', [SYNC_KEYS.token]);
    expect(owner?.value).toBe('local-owner');
    expect(token?.value).toBe('local-token');
    // 快照里的业务 setting 已写入。
    const theme = await dst.get<{ value: string }>('SELECT value FROM setting WHERE key=?', ['ui.theme']);
    expect(theme?.value).toBe('dark');

    src.close();
    dst.close();
  });
});

describe('base64 UTF-8 往返（含中文）', () => {
  it('中文 / emoji / 换行 编解码无损', () => {
    const cases = ['晚饭 🍚', '备注：转账到工资卡\n第二行', 'ASCII only', '分类·生活费'];
    for (const s of cases) {
      expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
    }
  });

  it('容忍 GitHub 返回 base64 里的换行', () => {
    const s = '{"a":"中文值"}';
    const b64 = utf8ToBase64(s);
    // 模拟 GitHub 每 60 字符插入 \n。
    const withNewlines = b64.replace(/(.{4})/g, '$1\n');
    expect(base64ToUtf8(withNewlines)).toBe(s);
  });

  it('整份快照 JSON 经 base64 往返后可再次解析', async () => {
    const adapter = await seededAdapter();
    const snap = await exportSnapshot(adapter);
    const text = serializeSnapshot(snap);
    const round = base64ToUtf8(utf8ToBase64(text));
    const parsed = parseSnapshot(round, 1);
    expect(parsed.ok).toBe(true);
    expect(snapshotCounts(parsed.snapshot!).txn).toBe(468);
    adapter.close();
  });
});

describe('校验（非法快照拒绝，不写库）', () => {
  it('app 字段不符 → 拒绝', () => {
    const r = validateSnapshot({ app: 'other', formatVersion: 1, dbUserVersion: 1, tables: {} }, 1);
    expect(r.ok).toBe(false);
  });

  it('dbUserVersion 不一致 → 拒绝', () => {
    const good = {
      app: 'ivy-wallet',
      formatVersion: 1,
      dbUserVersion: 2,
      exportedAt: 0,
      tables: { account: [], category: [], txn: [], tag: [], txn_tag: [], setting: [] },
    };
    expect(validateSnapshot(good, 1).ok).toBe(false);
  });

  it('缺表 → 拒绝', () => {
    const bad = {
      app: 'ivy-wallet',
      formatVersion: 1,
      dbUserVersion: 1,
      exportedAt: 0,
      tables: { account: [], category: [] },
    };
    expect(validateSnapshot(bad, 1).ok).toBe(false);
  });

  it('非法 JSON 文本 → 拒绝', () => {
    expect(parseSnapshot('not json {', 1).ok).toBe(false);
  });

  it('恢复失败整体回滚（写回中途约束冲突不留脏数据）', async () => {
    const dst = await makeTestAdapter();
    // 先放入一份正常数据。
    const r = importLegacyBackup(backup, NOW);
    await persistImport(dst, r, { mode: 'replace' });
    const before = await count(dst, 'txn');

    // 构造非法快照：category 引用不存在的 account（触发外键失败）。
    const badSnap = {
      app: 'ivy-wallet' as const,
      formatVersion: 1 as const,
      dbUserVersion: 1,
      exportedAt: 0,
      tables: {
        account: [] as Record<string, unknown>[],
        category: [
          { id: 'c1', account_id: 'nonexistent', name: 'X', color: 1, icon: null, order_num: 0, created_at: NOW },
        ] as Record<string, unknown>[],
        txn: [] as Record<string, unknown>[],
        tag: [] as Record<string, unknown>[],
        txn_tag: [] as Record<string, unknown>[],
        setting: [] as Record<string, unknown>[],
      },
    };
    await expect(restoreSnapshot(dst, badSnap)).rejects.toBeTruthy();
    // 回滚后原数据仍在（未被清空）。
    expect(await count(dst, 'txn')).toBe(before);
    dst.close();
  });
});
