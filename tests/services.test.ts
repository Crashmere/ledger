// ============================================================
// services.test.ts —— S1 领域服务层单测（Vitest + Node 内存库）
// ============================================================
// 覆盖 S1 任务书 §五 必测用例：
//   - yuanToCents 回归（含 9.28/35.35/0.1 等截断会错的值）
//   - 转账双向计入余额、转账不进 summary、balance 手算核对
//   - 删账户 RESTRICT、删分类 SET NULL、删标签 CASCADE
//   - listByAccount 只返回本账户分类（红线）
//   - create 校验（金额≤0 / transfer 缺 toAccountId / toAccountId==accountId / 分类不属该账户）
// 每个用例用独立内存库（beforeEach 新建），互不污染。
// ============================================================

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { BetterSqliteAdapter, makeTestAdapter } from './better-sqlite-adapter';
import {
  AccountServiceImpl,
  CategoryServiceImpl,
  SettingServiceImpl,
  StatsServiceImpl,
  TagServiceImpl,
  TxnServiceImpl,
  yuanToCents,
} from '../src/services';
import { AppError } from '../src/services/contract';

let adapter: BetterSqliteAdapter;
let accounts: AccountServiceImpl;
let categories: CategoryServiceImpl;
let tags: TagServiceImpl;
let txns: TxnServiceImpl;
let stats: StatsServiceImpl;
let settings: SettingServiceImpl;

beforeEach(async () => {
  adapter = await makeTestAdapter();
  accounts = new AccountServiceImpl(adapter);
  categories = new CategoryServiceImpl(adapter);
  tags = new TagServiceImpl(adapter);
  txns = new TxnServiceImpl(adapter);
  stats = new StatsServiceImpl(adapter);
  settings = new SettingServiceImpl(adapter);
});

afterEach(() => {
  adapter.close();
});

// 断言抛出指定 code 的 AppError。
async function expectAppError(fn: () => Promise<unknown>, code: AppError['code']): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ name: 'AppError', code });
}

// ------------------------------------------------------------
// 金额转换回归
// ------------------------------------------------------------
describe('money.yuanToCents 回归', () => {
  it('含小数值不因截断出错', () => {
    expect(yuanToCents(9.28)).toBe(928);
    expect(yuanToCents(35.35)).toBe(3535);
    expect(yuanToCents(0.1)).toBe(10);
    expect(yuanToCents('7.8')).toBe(780);
    expect(yuanToCents(0)).toBe(0);
    expect(yuanToCents(100)).toBe(10000);
  });
});

// ------------------------------------------------------------
// AccountService: balance / RESTRICT
// ------------------------------------------------------------
describe('AccountService', () => {
  it('balance = 初始 + 收入 − 支出 + 转入 − 转出（手算核对）', async () => {
    const a = await accounts.create({ name: 'A', color: 1, initialBalance: 1000 });
    const b = await accounts.create({ name: 'B', color: 2, initialBalance: 500 });

    await txns.create({ type: 'income', amount: 300, accountId: a.id });
    await txns.create({ type: 'expense', amount: 120, accountId: a.id });
    await txns.create({ type: 'transfer', amount: 200, accountId: a.id, toAccountId: b.id });

    // A: 1000 + 300 − 120 − 200(转出) = 980
    expect(await accounts.balance(a.id)).toBe(980);
    // B: 500 + 200(转入) = 700
    expect(await accounts.balance(b.id)).toBe(700);
  });

  it('转账双向计入余额，二者变化互为相反数', async () => {
    const a = await accounts.create({ name: 'A', color: 1, initialBalance: 1000 });
    const b = await accounts.create({ name: 'B', color: 2, initialBalance: 1000 });

    const beforeA = await accounts.balance(a.id);
    const beforeB = await accounts.balance(b.id);

    await txns.create({ type: 'transfer', amount: 250, accountId: a.id, toAccountId: b.id });

    const afterA = await accounts.balance(a.id);
    const afterB = await accounts.balance(b.id);

    expect(afterA - beforeA).toBe(-250);
    expect(afterB - beforeB).toBe(250);
    expect(afterA - beforeA).toBe(-(afterB - beforeB));
  });

  it('删账户 RESTRICT：账户下有交易时抛 AppError(RESTRICT)', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    await txns.create({ type: 'income', amount: 100, accountId: a.id });
    await expectAppError(() => accounts.remove(a.id), 'RESTRICT');
  });

  it('删账户 RESTRICT：账户下有分类时也抛 AppError(RESTRICT)', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    await categories.create({ accountId: a.id, name: '餐饮', color: 1 });
    await expectAppError(() => accounts.remove(a.id), 'RESTRICT');
  });

  it('remove 不存在的账户抛 NOT_FOUND', async () => {
    await expectAppError(() => accounts.remove('nope'), 'NOT_FOUND');
  });

  it('create 默认值：initialBalance=0, includeInBalance=true, orderNum 追加末尾', async () => {
    const a1 = await accounts.create({ name: 'A', color: 1 });
    const a2 = await accounts.create({ name: 'B', color: 2 });
    expect(a1.initialBalance).toBe(0);
    expect(a1.includeInBalance).toBe(true);
    expect(a2.orderNum).toBeGreaterThan(a1.orderNum);
    // 往返读回 boolean 正确
    const got = await accounts.get(a1.id);
    expect(got?.includeInBalance).toBe(true);
  });

  it('update includeInBalance=false 存储/读回一致', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const updated = await accounts.update(a.id, { includeInBalance: false });
    expect(updated.includeInBalance).toBe(false);
    expect((await accounts.get(a.id))?.includeInBalance).toBe(false);
  });
});

// ------------------------------------------------------------
// CategoryService: listByAccount 红线 / SET NULL
// ------------------------------------------------------------
describe('CategoryService', () => {
  it('listByAccount 只返回本账户分类（红线）', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await categories.create({ accountId: a.id, name: 'A-餐饮', color: 1 });
    await categories.create({ accountId: a.id, name: 'A-交通', color: 1 });
    await categories.create({ accountId: b.id, name: 'B-购物', color: 1 });

    const listA = await categories.listByAccount(a.id);
    const listB = await categories.listByAccount(b.id);
    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
    expect(listA.every((c) => c.accountId === a.id)).toBe(true);
    expect(listB[0].name).toBe('B-购物');
  });

  it('create 账户不存在抛 VALIDATION', async () => {
    await expectAppError(
      () => categories.create({ accountId: 'ghost', name: 'x', color: 1 }),
      'VALIDATION',
    );
  });

  it('删分类 SET NULL：其交易仍在、categoryId 变 null', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const cat = await categories.create({ accountId: a.id, name: '餐饮', color: 1 });
    const t = await txns.create({
      type: 'expense',
      amount: 100,
      accountId: a.id,
      categoryId: cat.id,
    });

    await categories.remove(cat.id);

    const got = await txns.get(t.id);
    expect(got).not.toBeNull();
    expect(got?.categoryId).toBeNull();
  });
});

// ------------------------------------------------------------
// TagService: CASCADE
// ------------------------------------------------------------
describe('TagService', () => {
  it('删标签（软删）：交易上的该标签消失、交易仍在、txn_tag 关联行物理保留', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const tag = await tags.create({ name: '出差', color: 1 });
    const t = await txns.create({
      type: 'expense',
      amount: 100,
      accountId: a.id,
      tagIds: [tag.id],
    });

    // 建成时确实带上了该标签
    const before = await txns.get(t.id);
    expect(before?.tags.map((x) => x.id)).toContain(tag.id);

    await tags.remove(tag.id);

    // 交易仍在，但读取时已过滤掉软删标签
    const after = await txns.get(t.id);
    expect(after).not.toBeNull();
    expect(after?.tags).toHaveLength(0);
    // 标签本体软删：不再出现在 list，但物理行仍在（deleted_at 被写）
    expect(await tags.list()).toHaveLength(0);
    const tagRow = await adapter.get<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM tag WHERE id = ?`,
      [tag.id],
    );
    expect(tagRow?.deleted_at).not.toBeNull();
    // txn_tag 关联行物理保留（跟随父 txn 合并，不做级联物理删除）
    const links = await adapter.all(`SELECT * FROM txn_tag WHERE tag_id = ?`, [tag.id]);
    expect(links).toHaveLength(1);
  });
});

// ------------------------------------------------------------
// TxnService: create 校验
// ------------------------------------------------------------
describe('TxnService create 校验', () => {
  it('金额 ≤ 0 抛 VALIDATION', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    await expectAppError(
      () => txns.create({ type: 'expense', amount: 0, accountId: a.id }),
      'VALIDATION',
    );
    await expectAppError(
      () => txns.create({ type: 'expense', amount: -50, accountId: a.id }),
      'VALIDATION',
    );
  });

  it('transfer 缺 toAccountId 抛 VALIDATION', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    await expectAppError(
      () => txns.create({ type: 'transfer', amount: 100, accountId: a.id }),
      'VALIDATION',
    );
  });

  it('transfer 的 toAccountId == accountId 抛 VALIDATION', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    await expectAppError(
      () => txns.create({ type: 'transfer', amount: 100, accountId: a.id, toAccountId: a.id }),
      'VALIDATION',
    );
  });

  it('分类不属该账户抛 VALIDATION', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    const catB = await categories.create({ accountId: b.id, name: 'B-购物', color: 1 });
    await expectAppError(
      () => txns.create({ type: 'expense', amount: 100, accountId: a.id, categoryId: catB.id }),
      'VALIDATION',
    );
  });

  it('非转账带 toAccountId 抛 VALIDATION', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await expectAppError(
      () => txns.create({ type: 'income', amount: 100, accountId: a.id, toAccountId: b.id }),
      'VALIDATION',
    );
  });

  it('正常记一笔（分类属本账户）成功', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const cat = await categories.create({ accountId: a.id, name: '餐饮', color: 1 });
    const t = await txns.create({
      type: 'expense',
      amount: 928,
      accountId: a.id,
      categoryId: cat.id,
      title: '午餐',
    });
    expect(t.amount).toBe(928);
    expect(t.categoryId).toBe(cat.id);
    expect(t.toAccountId).toBeNull();
  });
});

// ------------------------------------------------------------
// TxnService: tagIds 事务 / query 过滤
// ------------------------------------------------------------
describe('TxnService tagIds 与 query', () => {
  it('create/update 的 tagIds 在事务内维护 txn_tag', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const t1 = await tags.create({ name: 't1', color: 1 });
    const t2 = await tags.create({ name: 't2', color: 1 });
    const t3 = await tags.create({ name: 't3', color: 1 });

    const txn = await txns.create({
      type: 'expense',
      amount: 100,
      accountId: a.id,
      tagIds: [t1.id, t2.id],
    });
    expect((await txns.get(txn.id))?.tags.map((x) => x.id).sort()).toEqual(
      [t1.id, t2.id].sort(),
    );

    // update 全量替换关联
    await txns.update(txn.id, { tagIds: [t3.id] });
    expect((await txns.get(txn.id))?.tags.map((x) => x.id)).toEqual([t3.id]);
  });

  it('create 带不存在的 tagId 时整体回滚（交易也不落库）', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    await expect(
      txns.create({ type: 'expense', amount: 100, accountId: a.id, tagIds: ['ghost-tag'] }),
    ).rejects.toBeTruthy();
    const all = await txns.query({});
    expect(all).toHaveLength(0);
  });

  it('query 过滤：types/keyword/amount/time/tag/account', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    const tagX = await tags.create({ name: 'x', color: 1 });

    await txns.create({ type: 'income', amount: 1000, accountId: a.id, title: '工资', time: 100 });
    await txns.create({
      type: 'expense',
      amount: 200,
      accountId: a.id,
      title: '咖啡',
      time: 200,
      tagIds: [tagX.id],
    });
    await txns.create({ type: 'expense', amount: 5000, accountId: b.id, note: '房租', time: 300 });
    await txns.create({ type: 'transfer', amount: 300, accountId: a.id, toAccountId: b.id, time: 400 });

    expect(await txns.query({ types: ['income'] })).toHaveLength(1);
    expect(await txns.query({ keyword: '咖啡' })).toHaveLength(1);
    expect(await txns.query({ keyword: '房租' })).toHaveLength(1);
    expect(await txns.query({ amountMin: 1000 })).toHaveLength(2); // 1000 + 5000
    expect(await txns.query({ amountMax: 300 })).toHaveLength(2); // 200 + 300(transfer)
    expect(await txns.query({ timeFrom: 200, timeTo: 300 })).toHaveLength(2);
    expect(await txns.query({ tagIds: [tagX.id] })).toHaveLength(1);
    // account 维度：转账在转出/转入两账户都体现 → b 命中 房租 + 转账
    expect(await txns.query({ accountIds: [b.id] })).toHaveLength(2);

    // 排序
    const asc = await txns.query({ sortBy: 'amount', sortDir: 'asc' });
    expect(asc.map((t) => t.amount)).toEqual([200, 300, 1000, 5000]);
    const desc = await txns.query({ sortBy: 'time', sortDir: 'desc' });
    expect(desc.map((t) => t.time)).toEqual([400, 300, 200, 100]);

    // 分页
    const page = await txns.query({ sortBy: 'time', sortDir: 'asc', limit: 2, offset: 1 });
    expect(page.map((t) => t.time)).toEqual([200, 300]);
  });

  it('remove 删交易（软删）：交易不再可见、txn_tag 关联行保留、标签本体仍在', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const tag = await tags.create({ name: 't', color: 1 });
    const t = await txns.create({
      type: 'expense',
      amount: 100,
      accountId: a.id,
      tagIds: [tag.id],
    });
    await txns.remove(t.id);
    expect(await txns.get(t.id)).toBeNull();
    // 软删：交易物理行仍在（deleted_at 被写），txn_tag 关联行随父 txn 保留
    const txnRow = await adapter.get<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM txn WHERE id = ?`,
      [t.id],
    );
    expect(txnRow?.deleted_at).not.toBeNull();
    const links = await adapter.all(`SELECT * FROM txn_tag WHERE txn_id = ?`, [t.id]);
    expect(links).toHaveLength(1);
    // 标签本体仍在
    expect(await tags.list()).toHaveLength(1);
  });

  it('update 改类型为 transfer 需带合法 toAccountId', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    const t = await txns.create({ type: 'expense', amount: 100, accountId: a.id });
    // 只改 type 不给 toAccountId → VALIDATION
    await expectAppError(() => txns.update(t.id, { type: 'transfer' }), 'VALIDATION');
    // 同时给合法 toAccountId → 成功
    const updated = await txns.update(t.id, { type: 'transfer', toAccountId: b.id });
    expect(updated.type).toBe('transfer');
    expect(updated.toAccountId).toBe(b.id);
  });
});

// ------------------------------------------------------------
// StatsService: summary 转账不计入
// ------------------------------------------------------------
describe('StatsService.summary', () => {
  it('转账不进 summary：仅 1 笔转账时 income/expense/net 全为 0', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await txns.create({ type: 'transfer', amount: 500, accountId: a.id, toAccountId: b.id });

    const s = await stats.summary();
    expect(s).toEqual({ income: 0, expense: 0, net: 0 });
  });

  it('summary 收支/net 正确，且转账被排除', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await txns.create({ type: 'income', amount: 1000, accountId: a.id });
    await txns.create({ type: 'expense', amount: 300, accountId: a.id });
    await txns.create({ type: 'transfer', amount: 9999, accountId: a.id, toAccountId: b.id });

    const s = await stats.summary();
    expect(s).toEqual({ income: 1000, expense: 300, net: 700 });
  });

  it('summary 支持 accountIds / 时间过滤', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await txns.create({ type: 'income', amount: 1000, accountId: a.id, time: 100 });
    await txns.create({ type: 'income', amount: 500, accountId: b.id, time: 200 });

    expect((await stats.summary({ accountIds: [a.id] })).income).toBe(1000);
    expect((await stats.summary({ timeFrom: 150 })).income).toBe(500);
  });
});

// ------------------------------------------------------------
// 专项账户（v3 kind='project'）：字段往返 + 全局统计默认排除
// 攻击面：专项交易泄漏进日常收支/趋势/分类分布，或显式选专项时被误排除
// ------------------------------------------------------------
describe('专项账户 kind 与 excludeProjects 排除', () => {
  it('create/get：kind/period/archived 字段往返一致', async () => {
    const p = await accounts.create({
      name: '云南之旅',
      color: 1,
      kind: 'project',
      periodStart: 100,
      periodEnd: 200,
      includeInBalance: false,
    });
    expect(p.kind).toBe('project');
    expect(p.periodStart).toBe(100);
    expect(p.periodEnd).toBe(200);
    expect(p.includeInBalance).toBe(false);

    const got = await accounts.get(p.id);
    expect(got?.kind).toBe('project');
    expect(got?.periodStart).toBe(100);
    expect(got?.periodEnd).toBe(200);
    expect(got?.archivedAt).toBeNull();

    // 普通账户 kind 归一为 'normal'（存储层存 NULL）
    const n = await accounts.create({ name: '现金', color: 2 });
    expect(n.kind).toBe('normal');
    const nRow = await adapter.get<{ kind: string | null }>(
      `SELECT kind FROM account WHERE id = ?`,
      [n.id],
    );
    expect(nRow?.kind).toBeNull();
  });

  it('update：普通账户可改成专项并写入时间段/归档', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const up = await accounts.update(a.id, {
      kind: 'project',
      periodStart: 10,
      periodEnd: 20,
      archivedAt: 30,
    });
    expect(up.kind).toBe('project');
    expect(up.periodStart).toBe(10);
    expect(up.archivedAt).toBe(30);
    // 改回普通：存储层落 NULL
    const back = await accounts.update(a.id, { kind: 'normal' });
    expect(back.kind).toBe('normal');
    const row = await adapter.get<{ kind: string | null }>(
      `SELECT kind FROM account WHERE id = ?`,
      [a.id],
    );
    expect(row?.kind).toBeNull();
  });

  it('txn.query excludeProjects：默认收全部，置位后排除专项账户交易（含转账两端）', async () => {
    const normal = await accounts.create({ name: '日常', color: 1 });
    const proj = await accounts.create({ name: '旅行', color: 2, kind: 'project' });

    await txns.create({ type: 'expense', amount: 100, accountId: normal.id });
    await txns.create({ type: 'expense', amount: 300, accountId: proj.id });
    // 从日常转入专项：转账一端命中专项，excludeProjects 时应排除
    await txns.create({ type: 'transfer', amount: 50, accountId: normal.id, toAccountId: proj.id });

    expect(await txns.query({})).toHaveLength(3);
    const filtered = await txns.query({ excludeProjects: true });
    // 只剩那笔纯日常支出
    expect(filtered).toHaveLength(1);
    expect(filtered[0].accountId).toBe(normal.id);
    expect(filtered[0].type).toBe('expense');
  });

  it('stats.summary/breakdown/trend excludeProjects：专项支出不进日常口径', async () => {
    const normal = await accounts.create({ name: '日常', color: 1 });
    const proj = await accounts.create({ name: '旅行', color: 2, kind: 'project' });
    const catN = await categories.create({ accountId: normal.id, name: '餐饮', color: 1 });
    const catP = await categories.create({ accountId: proj.id, name: '住宿', color: 1 });

    await txns.create({ type: 'expense', amount: 100, accountId: normal.id, categoryId: catN.id, time: 1000 });
    await txns.create({ type: 'expense', amount: 900, accountId: proj.id, categoryId: catP.id, time: 1000 });

    // 不排除：支出合计 1000
    expect((await stats.summary()).expense).toBe(1000);
    // 排除专项：只剩 100
    expect((await stats.summary({ excludeProjects: true })).expense).toBe(100);

    // 分类分布：排除后不含「住宿」
    const bd = await stats.breakdownByCategory({ excludeProjects: true });
    expect(bd.map((r) => r.categoryName)).not.toContain('住宿');
    expect(bd.reduce((s, r) => s + r.amount, 0)).toBe(100);

    // 趋势：排除后支出合计只剩 100
    const tr = await stats.trend({ granularity: 'day', excludeProjects: true });
    expect(tr.reduce((s, p) => s + p.expense, 0)).toBe(100);
  });

  it('显式选中专项账户 accountIds 时不排除：能查看该专项自身数据', async () => {
    const normal = await accounts.create({ name: '日常', color: 1 });
    const proj = await accounts.create({ name: '旅行', color: 2, kind: 'project' });
    await txns.create({ type: 'expense', amount: 900, accountId: proj.id });

    // 报告页语义：显式选中专项账户时不传 excludeProjects，仍能按 accountIds 命中
    const rows = await txns.query({ accountIds: [proj.id] });
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(proj.id);
    expect((await stats.summary({ accountIds: [proj.id] })).expense).toBe(900);
    void normal;
  });
});

// ------------------------------------------------------------
// SettingService
// ------------------------------------------------------------
describe('SettingService', () => {
  it('set/get/all/remove 往返', async () => {
    expect(await settings.get('theme')).toBeNull();
    await settings.set('theme', 'dark');
    expect(await settings.get('theme')).toBe('dark');
    // 覆盖
    await settings.set('theme', 'light');
    expect(await settings.get('theme')).toBe('light');

    await settings.set('lang', 'zh');
    expect(await settings.all()).toEqual({ theme: 'light', lang: 'zh' });

    await settings.remove('theme');
    expect(await settings.get('theme')).toBeNull();
    expect(await settings.all()).toEqual({ lang: 'zh' });
  });
});

// ------------------------------------------------------------
// 软删除（v2）不变量：已删记录必须从所有视图消失，且写操作 bump updated_at
// 攻击面：删除后仍出现在 query / balance / stats / breakdown 都算数据泄漏
// ------------------------------------------------------------
describe('软删除不变量（L2 基建）', () => {
  it('软删交易后：query 不返回、余额排除、summary/trend/breakdown 排除', async () => {
    const a = await accounts.create({ name: 'A', color: 1, initialBalance: 1000 });
    const cat = await categories.create({ accountId: a.id, name: '餐饮', color: 1 });
    const keep = await txns.create({ type: 'expense', amount: 100, accountId: a.id, categoryId: cat.id });
    const gone = await txns.create({ type: 'expense', amount: 300, accountId: a.id, categoryId: cat.id });

    // 删前：两笔都在，余额 1000-100-300=600，支出合计 400
    expect(await txns.query({})).toHaveLength(2);
    expect(await accounts.balance(a.id)).toBe(600);
    expect((await stats.summary()).expense).toBe(400);

    await txns.remove(gone.id);

    // 删后：只剩 keep；余额回到 1000-100=900；支出只剩 100
    const rows = await txns.query({});
    expect(rows.map((t) => t.id)).toEqual([keep.id]);
    expect(await accounts.balance(a.id)).toBe(900);
    expect((await stats.summary()).expense).toBe(100);
    // breakdown 也只剩 100
    const bd = await stats.breakdownByCategory({});
    expect(bd.reduce((s, r) => s + r.amount, 0)).toBe(100);
    // trend 汇总同样只剩 100
    const tr = await stats.trend({ granularity: 'day' });
    expect(tr.reduce((s, p) => s + p.expense, 0)).toBe(100);
  });

  it('软删账户后：list 不返回、get 为 null，且不能在其下建分类/交易', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await accounts.remove(a.id);

    expect((await accounts.list()).map((x) => x.id)).toEqual([b.id]);
    expect(await accounts.get(a.id)).toBeNull();
    // 已删账户不能再挂新分类 / 新交易
    await expectAppError(() => categories.create({ accountId: a.id, name: 'x', color: 1 }), 'VALIDATION');
    await expectAppError(() => txns.create({ type: 'expense', amount: 10, accountId: a.id }), 'VALIDATION');
  });

  it('账户 RESTRICT 仅看未删子记录：删掉全部子交易后账户可删', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const t = await txns.create({ type: 'income', amount: 100, accountId: a.id });
    // 有未删交易 → 拒删
    await expectAppError(() => accounts.remove(a.id), 'RESTRICT');
    // 软删该交易后，账户不再有未删子记录 → 可删
    await txns.remove(t.id);
    await expect(accounts.remove(a.id)).resolves.toBeUndefined();
    expect(await accounts.get(a.id)).toBeNull();
  });

  it('转账的转入账户也算子记录：对端账户在被引用时不可删', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const b = await accounts.create({ name: 'B', color: 2 });
    await txns.create({ type: 'transfer', amount: 200, accountId: a.id, toAccountId: b.id });
    // b 作为 to_account_id 被引用 → 不可删
    await expectAppError(() => accounts.remove(b.id), 'RESTRICT');
  });

  it('软删分类：SET NULL 语义等价——交易仍在、categoryId 变 null 且交易 updated_at 被 bump', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const cat = await categories.create({ accountId: a.id, name: '餐饮', color: 1 });
    const t = await txns.create({ type: 'expense', amount: 100, accountId: a.id, categoryId: cat.id });

    const beforeRow = await adapter.get<{ updated_at: number }>(
      `SELECT updated_at FROM txn WHERE id = ?`,
      [t.id],
    );

    await new Promise((r) => setTimeout(r, 2)); // 让时间戳可区分
    await categories.remove(cat.id);

    const got = await txns.get(t.id);
    expect(got).not.toBeNull();
    expect(got?.categoryId).toBeNull();
    // 分类从 listByAccount 消失
    expect(await categories.listByAccount(a.id)).toHaveLength(0);
    // 交易 updated_at 被 bump（参与后续合并）
    const afterRow = await adapter.get<{ updated_at: number }>(
      `SELECT updated_at FROM txn WHERE id = ?`,
      [t.id],
    );
    expect(afterRow!.updated_at).toBeGreaterThan(beforeRow!.updated_at);
  });

  it('create/update 都写 updated_at：create 时 =created_at，update 后 > created_at', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const t = await txns.create({ type: 'expense', amount: 100, accountId: a.id });

    const row1 = await adapter.get<{ created_at: number; updated_at: number }>(
      `SELECT created_at, updated_at FROM txn WHERE id = ?`,
      [t.id],
    );
    expect(row1!.updated_at).toBe(row1!.created_at);

    await new Promise((r) => setTimeout(r, 2));
    await txns.update(t.id, { amount: 200 });

    const row2 = await adapter.get<{ created_at: number; updated_at: number }>(
      `SELECT created_at, updated_at FROM txn WHERE id = ?`,
      [t.id],
    );
    expect(row2!.updated_at).toBeGreaterThan(row2!.created_at);
  });

  it('已软删标签不参与 tagIds 过滤：按已删标签查不到交易', async () => {
    const a = await accounts.create({ name: 'A', color: 1 });
    const tag = await tags.create({ name: 'x', color: 1 });
    await txns.create({ type: 'expense', amount: 100, accountId: a.id, tagIds: [tag.id] });

    expect(await txns.query({ tagIds: [tag.id] })).toHaveLength(1);
    await tags.remove(tag.id);
    // 标签软删后，按它过滤应查不到（关联行还在，但标签已删）
    expect(await txns.query({ tagIds: [tag.id] })).toHaveLength(0);
  });
});
