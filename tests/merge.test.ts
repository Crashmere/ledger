// ============================================================
// merge.test.ts —— L2 记录级无损合并纯函数单测
// ============================================================
// 覆盖 merge.ts 的核心不变量：
//   - 两台都新增未同步（both-new）→ 并集，谁的都不丢（这是做 L2 的初衷）
//   - 同一 id 两侧都改 → updated_at 后写胜（LWW）
//   - 一方删、一方改 → 谁最后动谁赢；墓碑随赢家保留、防复活
//   - txn_tag 跟随父 txn：哪侧 txn 赢就用哪侧标签集
//   - setting 并集，本地优先
//   - v1 快照兼容（缺 updated_at/deleted_at）
//   - 合并可交换性：merge(a,b) 与 merge(b,a) 对每个 id 结论一致
// ============================================================

import { describe, expect, it } from 'vitest';
import { mergeSnapshots, MERGED_DB_USER_VERSION } from '../src/services/sync/merge';
import type { BackupSnapshot } from '../src/services/backup/snapshot';

// ------------------------------------------------------------
// 构造快照的便捷工具
// ------------------------------------------------------------
type Row = Record<string, unknown>;

function snap(tables: Partial<BackupSnapshot['tables']>): BackupSnapshot {
  return {
    app: 'ivy-wallet',
    formatVersion: 1,
    dbUserVersion: 2,
    exportedAt: Date.now(),
    tables: {
      account: tables.account ?? [],
      category: tables.category ?? [],
      txn: tables.txn ?? [],
      tag: tables.tag ?? [],
      txn_tag: tables.txn_tag ?? [],
      setting: tables.setting ?? [],
    },
  };
}

function txnRow(over: Row): Row {
  return {
    id: 'txn-x',
    type: 'expense',
    amount: 100,
    account_id: 'acc-1',
    to_account_id: null,
    category_id: null,
    time: 1000,
    title: null,
    note: null,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...over,
  };
}

function acctRow(over: Row): Row {
  return {
    id: 'acc-1',
    name: 'A',
    color: 1,
    icon: null,
    initial_balance: 0,
    include_in_balance: 1,
    order_num: 0,
    created_at: 1000,
    updated_at: 1000,
    deleted_at: null,
    ...over,
  };
}

const idsOf = (rows: Row[]) => rows.map((r) => String(r.id)).sort();

// ------------------------------------------------------------
// both-new：两台都新增、都没同步 —— L2 的核心目标
// ------------------------------------------------------------
describe('both-new：两侧各自新增，合并后并集不丢', () => {
  it('本地有 txn a、远端有 txn b → 合并后 a、b 都在', () => {
    const local = snap({ txn: [txnRow({ id: 'a', amount: 100 })] });
    const remote = snap({ txn: [txnRow({ id: 'b', amount: 200 })] });

    const { merged, report } = mergeSnapshots(local, remote);
    expect(idsOf(merged.tables.txn)).toEqual(['a', 'b']);
    expect(report.txn.fromLocalOnly).toBe(1);
    expect(report.txn.fromRemoteOnly).toBe(1);
    expect(merged.dbUserVersion).toBe(MERGED_DB_USER_VERSION);
  });
});

// ------------------------------------------------------------
// LWW：同 id 两侧都改，updated_at 大者胜
// ------------------------------------------------------------
describe('LWW：同 id 冲突按 updated_at 后写胜', () => {
  it('远端 updated_at 更大 → 取远端版本', () => {
    const local = snap({ txn: [txnRow({ id: 'x', amount: 100, updated_at: 5000 })] });
    const remote = snap({ txn: [txnRow({ id: 'x', amount: 999, updated_at: 8000 })] });

    const { merged, report } = mergeSnapshots(local, remote);
    expect(merged.tables.txn).toHaveLength(1);
    expect(merged.tables.txn[0].amount).toBe(999);
    expect(report.txn.remoteWon).toBe(1);
  });

  it('本地 updated_at 更大 → 取本地版本', () => {
    const local = snap({ txn: [txnRow({ id: 'x', amount: 100, updated_at: 9000 })] });
    const remote = snap({ txn: [txnRow({ id: 'x', amount: 999, updated_at: 8000 })] });

    const { merged, report } = mergeSnapshots(local, remote);
    expect(merged.tables.txn[0].amount).toBe(100);
    expect(report.txn.localWon).toBe(1);
  });
});

// ------------------------------------------------------------
// 删/改冲突：谁最后动谁赢，墓碑防复活
// ------------------------------------------------------------
describe('删除 vs 修改：LWW 解决，墓碑随赢家保留', () => {
  it('远端删得更晚（deleted_at 大）→ 结果为软删（墓碑保留，不复活）', () => {
    // 本地在 t=5000 改了金额；远端在 t=8000 删除
    const local = snap({ txn: [txnRow({ id: 'x', amount: 100, updated_at: 5000, deleted_at: null })] });
    const remote = snap({ txn: [txnRow({ id: 'x', amount: 100, updated_at: 8000, deleted_at: 8000 })] });

    const { merged, report } = mergeSnapshots(local, remote);
    expect(merged.tables.txn).toHaveLength(1);
    expect(merged.tables.txn[0].deleted_at).toBe(8000); // 墓碑保留
    expect(report.txn.remoteWon).toBe(1);
    expect(report.tombstones.txn).toBe(1);
  });

  it('本地改得更晚 → 记录复活为本地改后版本（删除被后来的修改覆盖）', () => {
    // 远端在 t=5000 删除；本地在 t=8000 又改了它
    const local = snap({ txn: [txnRow({ id: 'x', amount: 777, updated_at: 8000, deleted_at: null })] });
    const remote = snap({ txn: [txnRow({ id: 'x', amount: 100, updated_at: 5000, deleted_at: 5000 })] });

    const { merged } = mergeSnapshots(local, remote);
    expect(merged.tables.txn[0].deleted_at).toBeNull();
    expect(merged.tables.txn[0].amount).toBe(777);
  });
});

// ------------------------------------------------------------
// txn_tag 跟随父 txn
// ------------------------------------------------------------
describe('txn_tag 跟随父 txn', () => {
  it('远端 txn 版本胜出 → 采用远端该 txn 的标签集', () => {
    const local = snap({
      txn: [txnRow({ id: 'x', updated_at: 5000 })],
      txn_tag: [{ txn_id: 'x', tag_id: 'tag-old' }],
    });
    const remote = snap({
      txn: [txnRow({ id: 'x', updated_at: 8000 })],
      txn_tag: [
        { txn_id: 'x', tag_id: 'tag-new1' },
        { txn_id: 'x', tag_id: 'tag-new2' },
      ],
    });

    const { merged } = mergeSnapshots(local, remote);
    const tagIds = merged.tables.txn_tag.map((r) => r.tag_id).sort();
    expect(tagIds).toEqual(['tag-new1', 'tag-new2']);
  });

  it('本地 txn 版本胜出 → 采用本地该 txn 的标签集（远端标签不混入）', () => {
    const local = snap({
      txn: [txnRow({ id: 'x', updated_at: 9000 })],
      txn_tag: [{ txn_id: 'x', tag_id: 'keep' }],
    });
    const remote = snap({
      txn: [txnRow({ id: 'x', updated_at: 8000 })],
      txn_tag: [{ txn_id: 'x', tag_id: 'drop' }],
    });

    const { merged } = mergeSnapshots(local, remote);
    expect(merged.tables.txn_tag.map((r) => r.tag_id)).toEqual(['keep']);
  });

  it('both-new 的两笔 txn 各自带标签 → 两组标签都保留', () => {
    const local = snap({
      txn: [txnRow({ id: 'a' })],
      txn_tag: [{ txn_id: 'a', tag_id: 't1' }],
    });
    const remote = snap({
      txn: [txnRow({ id: 'b' })],
      txn_tag: [{ txn_id: 'b', tag_id: 't2' }],
    });

    const { merged } = mergeSnapshots(local, remote);
    const pairs = merged.tables.txn_tag.map((r) => `${r.txn_id}:${r.tag_id}`).sort();
    expect(pairs).toEqual(['a:t1', 'b:t2']);
  });
});

// ------------------------------------------------------------
// setting 并集，本地优先
// ------------------------------------------------------------
describe('setting 并集，本地优先', () => {
  it('同 key 冲突取本地值；各自独有的 key 都保留', () => {
    const local = snap({
      setting: [
        { key: 'theme', value: 'dark' },
        { key: 'onlyLocal', value: 'L' },
      ],
    });
    const remote = snap({
      setting: [
        { key: 'theme', value: 'light' },
        { key: 'onlyRemote', value: 'R' },
      ],
    });

    const { merged } = mergeSnapshots(local, remote);
    const map = new Map(merged.tables.setting.map((r) => [String(r.key), r.value]));
    expect(map.get('theme')).toBe('dark'); // 本地优先
    expect(map.get('onlyLocal')).toBe('L');
    expect(map.get('onlyRemote')).toBe('R');
  });
});

// ------------------------------------------------------------
// v1 兼容：缺 updated_at / deleted_at
// ------------------------------------------------------------
describe('v1 快照兼容', () => {
  it('缺 updated_at 的行 → 回落 created_at 参与比较', () => {
    // 本地 v2：updated_at=5000；远端 v1：无 updated_at，created_at=8000
    const local = snap({ txn: [txnRow({ id: 'x', amount: 1, updated_at: 5000 })] });
    const remoteV1: BackupSnapshot = snap({});
    remoteV1.tables.txn = [
      { id: 'x', type: 'expense', amount: 2, account_id: 'acc-1', to_account_id: null, category_id: null, time: 1, title: null, note: null, created_at: 8000 },
    ];

    const { merged } = mergeSnapshots(local, remoteV1);
    // 远端 created_at=8000 > 本地 updated_at=5000 → 远端胜
    expect(merged.tables.txn[0].amount).toBe(2);
    // 输出补齐 deleted_at 字段
    expect(merged.tables.txn[0].deleted_at ?? null).toBeNull();
  });

  it('输出恒为 v3（dbUserVersion=3）', () => {
    const { merged } = mergeSnapshots(snap({}), snap({}));
    expect(merged.dbUserVersion).toBe(3);
  });
});

// ------------------------------------------------------------
// 专项账户（v3）降级防护：updated_at 相等时，结构列更完整的一方胜出
// ------------------------------------------------------------
// 背景 bug：旧字典序 tie-break 下，`"kind":null` > `"kind":"project"`，
//   一台"降级客户端"（把 kind/period/archived 抹成 NULL 却沿用原 updated_at 回推）
//   会在同毫秒并发里赢下 tie-break，把专项账户悄悄降级成普通账户，并全设备扩散。
describe('专项账户降级防护：同 updated_at 时保留信息更多的一方', () => {
  it('本地专项(kind=project) vs 远端被抹平(kind=null)、updated_at 相等 → 保留专项', () => {
    const local = snap({
      account: [acctRow({ id: 'acc-p', updated_at: 1000, kind: 'project', period_start: 500, period_end: 900 })],
    });
    // 远端同 id、同 updated_at，但 v3 列缺失（降级客户端 restore 往返后 kind 被抹成 NULL）。
    const remote = snap({ account: [acctRow({ id: 'acc-p', updated_at: 1000 })] });

    const ab = mergeSnapshots(local, remote).merged;
    const ba = mergeSnapshots(remote, local).merged; // 交换入参，结论必须一致

    expect(ab.tables.account[0].kind).toBe('project');
    expect(ab.tables.account[0].period_start).toBe(500);
    expect(ba.tables.account[0].kind).toBe('project');
    expect(ba.tables.account[0].period_start).toBe(500);
  });

  it('专项↔普通的真实改动会 bump updated_at → 仍按 LWW 后写胜（本闸不干扰正常改动）', () => {
    // 用户后来把它从专项改回普通：updated_at 更大 → 普通版本应胜（kind=null）。
    const proj = snap({ account: [acctRow({ id: 'acc-p', updated_at: 1000, kind: 'project' })] });
    const demotedLater = snap({ account: [acctRow({ id: 'acc-p', updated_at: 2000, kind: null })] });

    const merged = mergeSnapshots(proj, demotedLater).merged;
    expect(merged.tables.account[0].updated_at).toBe(2000);
    expect(merged.tables.account[0].kind ?? null).toBeNull();
  });
});

// ------------------------------------------------------------
// 可交换性：merge(a,b) 与 merge(b,a) 对每个 id 结论一致
// ------------------------------------------------------------
describe('可交换性（对每个 id 的赢家一致）', () => {
  it('多表混合场景下，交换 base/other 后每个 id 的最终行相同', () => {
    const A = snap({
      account: [acctRow({ id: 'acc-1', name: 'A-local', updated_at: 5000 })],
      txn: [
        txnRow({ id: 't1', amount: 100, updated_at: 9000 }),
        txnRow({ id: 't-localonly', amount: 50, updated_at: 3000 }),
      ],
    });
    const B = snap({
      account: [acctRow({ id: 'acc-1', name: 'A-remote', updated_at: 7000 })],
      txn: [
        txnRow({ id: 't1', amount: 999, updated_at: 6000 }),
        txnRow({ id: 't-remoteonly', amount: 70, updated_at: 4000 }),
      ],
    });

    const ab = mergeSnapshots(A, B).merged;
    const ba = mergeSnapshots(B, A).merged;

    const byId = (rows: Row[]) => new Map(rows.map((r) => [String(r.id), JSON.stringify({ ...r, exportedAt: undefined })]));
    const abTxn = byId(ab.tables.txn);
    const baTxn = byId(ba.tables.txn);
    expect([...abTxn.keys()].sort()).toEqual([...baTxn.keys()].sort());
    for (const id of abTxn.keys()) {
      expect(abTxn.get(id)).toBe(baTxn.get(id));
    }

    // 账户：acc-1 两侧都在，remote updated_at=7000 更大 → 两个方向都取 remote 版本
    expect(ab.tables.account[0].name).toBe('A-remote');
    expect(ba.tables.account[0].name).toBe('A-remote');
  });
});
