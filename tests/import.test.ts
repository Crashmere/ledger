// ============================================================
// import.test.ts —— S7 数据导入单测（Vitest + Node 内存库）
// ============================================================
// 覆盖 S7 任务书 §四 验收基线与 §六 DoD 关键项：
//   - importLegacyBackup 对真实备份 JSON 得 4/16/468/0 失败/0 孤儿；
//     类型分布 支出433·收入32·转账3；收支类 4 笔无分类（置 null 保留）。
//   - 金额元->分抽查（round，非 trunc）。
//   - persistImport 写库后计数正确、保留原 id、满足外键；转账双向影响余额。
//   - clearFirst 二次导入仍 4/16/468，不叠加（先清空再插入）。
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { BetterSqliteAdapter, makeTestAdapter } from './better-sqlite-adapter';
import {
  importLegacyBackup,
  persistImport,
  yuanToCents,
  type LegacyBackup,
} from '../src/services/import/legacyBackup';

// 真实备份 JSON（468 笔版本）——用 fs 读取，避免打进构建产物。
const BACKUP_PATH = fileURLToPath(
  new URL('../新记账系统-交接资料/参考数据-旧应用真实备份.json', import.meta.url),
);
const backup = JSON.parse(readFileSync(BACKUP_PATH, 'utf-8')) as LegacyBackup;

// 固定 now，保证 createdAt 可断言、可复现。
const NOW = 1_754_700_000_000;

describe('importLegacyBackup 映射（对真实备份的验收基线）', () => {
  const r = importLegacyBackup(backup, NOW);

  it('账户 4 / 分类 16 / 交易 468 / 0 失败 / 0 孤儿', () => {
    expect(r.stats.accountCount).toBe(4);
    expect(r.stats.categoryCount).toBe(16);
    expect(r.stats.txnOk).toBe(468);
    expect(r.stats.txnFailed).toBe(0);
    expect(r.stats.orphanCategories).toBe(0);
    expect(r.failures).toHaveLength(0);
  });

  it('类型分布：支出 433 · 收入 32 · 转账 3', () => {
    expect(r.stats.byType).toEqual({ expense: 433, income: 32, transfer: 3 });
  });

  it('收支类中 4 笔无分类（categoryId 置 null 保留，不算失败）', () => {
    expect(r.stats.txnNoCategory).toBe(4);
    const nullCat = r.txns.filter((t) => t.type !== 'transfer' && t.categoryId === null);
    expect(nullCat).toHaveLength(4);
  });

  it('每个分类都归属某账户（反向构建 account_id 无遗漏）', () => {
    const accIds = new Set(r.accounts.map((a) => a.id));
    for (const c of r.categories) {
      expect(accIds.has(c.accountId)).toBe(true);
    }
  });

  it('转账均带合法 toAccountId 且 != accountId，且不带分类', () => {
    const transfers = r.txns.filter((t) => t.type === 'transfer');
    expect(transfers).toHaveLength(3);
    const accIds = new Set(r.accounts.map((a) => a.id));
    for (const t of transfers) {
      expect(t.toAccountId).toBeTruthy();
      expect(accIds.has(t.toAccountId as string)).toBe(true);
      expect(t.toAccountId).not.toBe(t.accountId);
      expect(t.categoryId).toBeNull();
    }
  });

  it('非转账交易 toAccountId 一律为 null（与 CHECK 约束对齐）', () => {
    for (const t of r.txns) {
      if (t.type !== 'transfer') expect(t.toAccountId).toBeNull();
    }
  });

  it('金额一律正数分', () => {
    for (const t of r.txns) {
      expect(Number.isInteger(t.amount)).toBe(true);
      expect(t.amount).toBeGreaterThan(0);
    }
  });
});

describe('yuanToCents 元->分（四舍五入，非截断）', () => {
  it('抽查含小数金额', () => {
    expect(yuanToCents(7.8)).toBe(780);
    expect(yuanToCents(2.99)).toBe(299);
    expect(yuanToCents(15.8)).toBe(1580);
    expect(yuanToCents(85.14)).toBe(8514);
    expect(yuanToCents(6690.0)).toBe(669000);
    expect(yuanToCents(9.29)).toBe(929); // trunc 会得 928
  });
});

describe('persistImport 写库（保留原 id / 计数 / 幂等）', () => {
  let adapter: BetterSqliteAdapter;

  beforeEach(async () => {
    adapter = await makeTestAdapter();
  });
  afterEach(() => {
    adapter.close();
  });

  it('纯净库导入后 account/category/txn 计数与基线一致', async () => {
    const r = importLegacyBackup(backup, NOW);
    await persistImport(adapter, r);

    const ac = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM account');
    const cc = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM category');
    const tc = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
    expect(ac?.n).toBe(4);
    expect(cc?.n).toBe(16);
    expect(tc?.n).toBe(468);
  });

  it('保留旧 JSON 原 id（转账引用不错乱）', async () => {
    const r = importLegacyBackup(backup, NOW);
    await persistImport(adapter, r);

    // 原始 JSON 里的转账，其 accountId/toAccountId 应原样落库。
    const legacyTransfer = (backup.transactions ?? []).find((t) => t.type === 'TRANSFER');
    expect(legacyTransfer).toBeTruthy();
    const row = await adapter.get<{ account_id: string; to_account_id: string }>(
      'SELECT account_id, to_account_id FROM txn WHERE id = ?',
      [legacyTransfer!.id],
    );
    expect(row?.account_id).toBe(legacyTransfer!.accountId);
    expect(row?.to_account_id).toBe(legacyTransfer!.toAccountId);
  });

  it('clearFirst（replace 模式）二次导入仍 4/16/468，不叠加', async () => {
    const r = importLegacyBackup(backup, NOW);
    await persistImport(adapter, r, { mode: 'replace' });
    await persistImport(adapter, r, { mode: 'replace' });

    const ac = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM account');
    const cc = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM category');
    const tc = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
    expect(ac?.n).toBe(4);
    expect(cc?.n).toBe(16);
    expect(tc?.n).toBe(468);
  });

  it('merge 模式二次导入按原 id 幂等，不重复行', async () => {
    const r = importLegacyBackup(backup, NOW);
    await persistImport(adapter, r, { mode: 'merge' });
    await persistImport(adapter, r, { mode: 'merge' });

    const ac = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM account');
    const cc = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM category');
    const tc = await adapter.get<{ n: number }>('SELECT COUNT(*) AS n FROM txn');
    expect(ac?.n).toBe(4);
    expect(cc?.n).toBe(16);
    expect(tc?.n).toBe(468);
  });

  it('导入的转账双向影响账户余额（转出 - / 转入 +）', async () => {
    const r = importLegacyBackup(backup, NOW);
    await persistImport(adapter, r);

    // 用一笔已知转账核对：转出账户余额含 -amount、转入账户含 +amount。
    const transfer = r.txns.find((t) => t.type === 'transfer')!;
    const from = transfer.accountId;
    const to = transfer.toAccountId as string;

    // 账户余额 = initial(0) + 收入 - 支出 + 转入 - 转出（全期口径，手工聚合核对）。
    const balanceOf = async (accId: string): Promise<number> => {
      const income = await sum(adapter, `type='income' AND account_id=?`, [accId]);
      const expense = await sum(adapter, `type='expense' AND account_id=?`, [accId]);
      const inTransfer = await sum(adapter, `type='transfer' AND to_account_id=?`, [accId]);
      const outTransfer = await sum(adapter, `type='transfer' AND account_id=?`, [accId]);
      return income - expense + inTransfer - outTransfer;
    };

    const balFrom = await balanceOf(from);
    const balTo = await balanceOf(to);
    // 断言转账确实进入了双方的口径：转出方包含该笔流出、转入方包含该笔流入。
    const outFrom = await sum(adapter, `type='transfer' AND account_id=?`, [from]);
    const inTo = await sum(adapter, `type='transfer' AND to_account_id=?`, [to]);
    expect(outFrom).toBeGreaterThanOrEqual(transfer.amount);
    expect(inTo).toBeGreaterThanOrEqual(transfer.amount);
    expect(Number.isInteger(balFrom)).toBe(true);
    expect(Number.isInteger(balTo)).toBe(true);
  });
});

/** 聚合某条件下 txn.amount 之和（分）。 */
async function sum(
  adapter: BetterSqliteAdapter,
  where: string,
  params: unknown[],
): Promise<number> {
  const row = await adapter.get<{ s: number | null }>(
    `SELECT COALESCE(SUM(amount),0) AS s FROM txn WHERE ${where}`,
    params,
  );
  return row?.s ?? 0;
}
