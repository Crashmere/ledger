// ============================================================
// sync-merge.integration.test.ts —— L2 端到端：两设备离线各改 → 合并 → 恢复
// ============================================================
// 用真实 SQLite（better-sqlite）跑通完整管线，证明"both-new 不丢数据"：
//   deviceA、deviceB 各自基于同一基线离线新增/修改/删除；
//   各自 exportSnapshot → mergeSnapshots → restoreSnapshot 到第三方空库；
//   断言两侧改动都在、软删记录从各视图消失、余额/统计口径正确。
// 这是"痛点2 时序覆盖"的最终验证：不再靠人肉保证同步顺序。
// ============================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BetterSqliteAdapter, makeTestAdapter } from './better-sqlite-adapter';
import { AccountServiceImpl, TxnServiceImpl, CategoryServiceImpl } from '../src/services';
import { exportSnapshot, restoreSnapshot } from '../src/services/backup/snapshot';
import { mergeSnapshots } from '../src/services/sync/merge';

let base: BetterSqliteAdapter;
let deviceA: BetterSqliteAdapter;
let deviceB: BetterSqliteAdapter;
let merged: BetterSqliteAdapter;

beforeEach(async () => {
  base = await makeTestAdapter();
  deviceA = await makeTestAdapter();
  deviceB = await makeTestAdapter();
  merged = await makeTestAdapter();
});

afterEach(() => {
  base.close();
  deviceA.close();
  deviceB.close();
  merged.close();
});

/** 把一份快照恢复到目标库，返回其上的 service 三件套。 */
async function restoreInto(adapter: BetterSqliteAdapter, snapJson: ReturnType<typeof cloneSnap>) {
  await restoreSnapshot(adapter, snapJson);
  return {
    accounts: new AccountServiceImpl(adapter),
    txns: new TxnServiceImpl(adapter),
    categories: new CategoryServiceImpl(adapter),
  };
}

/** 深拷贝一份快照对象（隔离各库互不影响）。 */
function cloneSnap<T>(snap: T): T {
  return JSON.parse(JSON.stringify(snap));
}

describe('L2 端到端：两设备离线各改后合并恢复', () => {
  it('both-new：A、B 各新增一笔，合并后两笔都在（谁的都不丢）', async () => {
    // 基线：一个账户，初始 1000。
    const ba = new AccountServiceImpl(base);
    const acc = await ba.create({ name: '现金', color: 1, initialBalance: 1000 });
    const baseSnap = await exportSnapshot(base);

    // A、B 都从同一基线出发（把基线快照恢复过去）。
    const A = await restoreInto(deviceA, cloneSnap(baseSnap));
    const B = await restoreInto(deviceB, cloneSnap(baseSnap));

    // A 离线新增支出 100，B 离线新增收入 500（都没同步）。
    await A.txns.create({ type: 'expense', amount: 100, accountId: acc.id });
    await B.txns.create({ type: 'income', amount: 500, accountId: acc.id });

    // 各自导出 → 合并 → 恢复到第三方空库。
    const snapA = await exportSnapshot(deviceA);
    const snapB = await exportSnapshot(deviceB);
    const { merged: mergedSnap, report } = mergeSnapshots(snapA, snapB);
    const M = await restoreInto(merged, cloneSnap(mergedSnap));

    // 两笔都在：合并库共 2 笔交易。
    const rows = await M.txns.query({});
    expect(rows).toHaveLength(2);
    expect(rows.some((t) => t.type === 'expense' && t.amount === 100)).toBe(true);
    expect(rows.some((t) => t.type === 'income' && t.amount === 500)).toBe(true);
    // 余额：1000 - 100 + 500 = 1400（两侧改动都算进去）。
    expect(await M.accounts.balance(acc.id)).toBe(1400);
    // 合并报告：各贡献一笔。
    expect(report.txn.fromLocalOnly + report.txn.fromRemoteOnly).toBe(2);
  });

  it('删/改冲突：A 删某笔、B 改同一笔，后动者胜且墓碑不复活', async () => {
    const ba = new AccountServiceImpl(base);
    const bt = new TxnServiceImpl(base);
    const acc = await ba.create({ name: '现金', color: 1, initialBalance: 0 });
    const t = await bt.create({ type: 'expense', amount: 100, accountId: acc.id });
    const baseSnap = await exportSnapshot(base);

    const A = await restoreInto(deviceA, cloneSnap(baseSnap));
    const B = await restoreInto(deviceB, cloneSnap(baseSnap));

    // B 先改（较早），A 后删（较晚）→ 删除应胜出。
    await B.txns.update(t.id, { amount: 777 });
    await new Promise((r) => setTimeout(r, 3));
    await A.txns.remove(t.id);

    const snapA = await exportSnapshot(deviceA);
    const snapB = await exportSnapshot(deviceB);
    const { merged: mergedSnap } = mergeSnapshots(snapB, snapA); // base=B，验证与顺序无关
    const M = await restoreInto(merged, cloneSnap(mergedSnap));

    // 该笔已被软删：任何视图都查不到，余额里也不算。
    expect(await M.txns.get(t.id)).toBeNull();
    expect(await M.txns.query({})).toHaveLength(0);
    expect(await M.accounts.balance(acc.id)).toBe(0);
    // 但物理行仍在且带墓碑（防止对端下次同步复活）。
    const row = await merged.get<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM txn WHERE id = ?`,
      [t.id],
    );
    expect(row?.deleted_at).not.toBeNull();
  });

  it('同一笔两侧都改：updated_at 后写胜', async () => {
    const ba = new AccountServiceImpl(base);
    const bt = new TxnServiceImpl(base);
    const acc = await ba.create({ name: '现金', color: 1, initialBalance: 0 });
    const t = await bt.create({ type: 'expense', amount: 100, accountId: acc.id });
    const baseSnap = await exportSnapshot(base);

    const A = await restoreInto(deviceA, cloneSnap(baseSnap));
    const B = await restoreInto(deviceB, cloneSnap(baseSnap));

    await A.txns.update(t.id, { amount: 200 });
    await new Promise((r) => setTimeout(r, 3));
    await B.txns.update(t.id, { amount: 300 }); // B 更晚 → 300 胜

    const snapA = await exportSnapshot(deviceA);
    const snapB = await exportSnapshot(deviceB);
    const { merged: mergedSnap } = mergeSnapshots(snapA, snapB);
    const M = await restoreInto(merged, cloneSnap(mergedSnap));

    const got = await M.txns.get(t.id);
    expect(got?.amount).toBe(300);
  });
});
