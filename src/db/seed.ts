// ============================================================
// seed.ts —— 临时开发种子（仅开发环境、且库为空时注入）
// ============================================================
// 权威来源：S2 任务书 §四.5。
// 约束：
//   - 仅 import.meta.env.DEV（开发环境）且库为空（无任何账户）时才注入；
//     生产构建与已有数据的库都不会被污染。
//   - 名称参考 参考数据-旧应用真实备份.json 的 accounts/categories（不必全量）。
//   - 分类归属账户（兑现"分类只列本账户"红线）。
// ⚠️ 这是临时开发数据，正式导入/新建流程属后续阶段，勿依赖此处数据形态。
// ============================================================

import { accountService, categoryService, tagService, txnService, yuanToCents } from '../services';
import type { Id } from '../services';

/** #RRGGBB -> 不透明 ARGB 整数（与 Account/Category 的 color 字段一致，正整数存储）。 */
function argb(hex: string): number {
  const rgb = parseInt(hex.replace('#', ''), 16);
  // 用加法而非位或，避免 0xff000000 触发 32 位有符号溢出成负数。
  return 0xff000000 + rgb;
}

/** 每个账户下的分类定义（名称参考旧备份）。 */
const SEED: Array<{
  account: { name: string; color: string };
  categories: Array<{ name: string; color: string }>;
}> = [
  {
    account: { name: '生活费', color: '#1e8e3e' }, // --acc-life
    categories: [
      { name: '食物', color: '#ea4335' },
      { name: '交通', color: '#4285f4' },
      { name: '日用', color: '#fbbc05' },
      { name: '娱乐', color: '#ab47bc' },
    ],
  },
  {
    account: { name: '消费', color: '#f29900' }, // --acc-consume
    categories: [
      { name: '购物', color: '#00acc1' },
      { name: '餐饮', color: '#ff7043' },
      { name: '订阅', color: '#6c5ce7' },
      { name: '健康', color: '#34a853' },
    ],
  },
  {
    account: { name: '工资', color: '#1a73e8' }, // --acc-salary
    categories: [
      { name: '工资', color: '#1e8e3e' },
      { name: '奖金', color: '#fbbc05' },
      { name: '报销', color: '#4285f4' },
    ],
  },
];

/** 标签（跨账户共用）。 */
const SEED_TAGS: Array<{ name: string; color: string }> = [
  { name: '买菜', color: '#34a853' },
  { name: '加班', color: '#ea4335' },
  { name: '固定', color: '#4285f4' },
  { name: '报销', color: '#f29900' },
];

/**
 * 若为开发环境且库为空，注入种子数据。幂等：库里只要已有账户就直接跳过。
 * 在 main.ts 于 initDb() 之后、mount 之前调用。
 */
export async function seedIfEmpty(): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }
  const existing = await accountService.list();
  if (existing.length > 0) {
    return; // 已有数据，不注入
  }

  // eslint-disable-next-line no-console
  console.info('[seed] 开发环境空库，注入临时种子数据…');

  // 账户名 -> id、"账户/分类名" -> 分类 id 的映射，供后面造交易引用。
  const accountIdByName = new Map<string, Id>();
  const categoryIdByKey = new Map<string, Id>();

  for (const group of SEED) {
    const account = await accountService.create({
      name: group.account.name,
      color: argb(group.account.color),
    });
    accountIdByName.set(group.account.name, account.id);
    for (const cat of group.categories) {
      const category = await categoryService.create({
        accountId: account.id,
        name: cat.name,
        color: argb(cat.color),
      });
      categoryIdByKey.set(`${group.account.name}/${cat.name}`, category.id);
    }
  }

  const tagIdByName = new Map<string, Id>();
  for (const tag of SEED_TAGS) {
    const created = await tagService.create({ name: tag.name, color: argb(tag.color) });
    tagIdByName.set(tag.name, created.id);
  }

  // 造若干示例交易，铺满当月不同日期，覆盖收入/支出/转账，供概览页有真实流水可看。
  await seedTxns(accountIdByName, categoryIdByKey, tagIdByName);
}

/**
 * 注入示例交易：日期用"当月内相对今天回退 N 天"生成（clamp 到当月 1 号~今天，绝不落未来/次月）。
 * 覆盖 收入/支出/转账 三类；转账用于验证概览三卡"转账不计入收支净额"。
 */
async function seedTxns(
  accountIdByName: Map<string, Id>,
  categoryIdByKey: Map<string, Id>,
  tagIdByName: Map<string, Id>,
): Promise<void> {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const today = now.getDate();

  /** 回退 daysAgo 天得到的当月时间戳；越界则夹到当月 1 号。小时给个固定值让同日多笔有先后。 */
  function timeOf(daysAgo: number, hour: number): number {
    const day = Math.max(1, today - daysAgo);
    return new Date(year, month, day, hour, 0, 0).getTime();
  }

  const life = accountIdByName.get('生活费')!;
  const consume = accountIdByName.get('消费')!;
  const salary = accountIdByName.get('工资')!;

  const plans: Array<{
    type: 'income' | 'expense' | 'transfer';
    amount: number; // 元
    accountId: Id;
    toAccountId?: Id;
    categoryId?: Id | null;
    title: string;
    note?: string;
    tags?: string[];
    daysAgo: number;
    hour: number;
  }> = [
    // —— 工资账户：一笔月初工资收入 ——
    {
      type: 'income',
      amount: 9000,
      accountId: salary,
      categoryId: categoryIdByKey.get('工资/工资'),
      title: '8月工资',
      note: '税后到账',
      tags: ['固定'],
      daysAgo: 6,
      hour: 9,
    },
    // —— 转账：工资 -> 生活费（验证三卡不计入）——
    {
      type: 'transfer',
      amount: 2000,
      accountId: salary,
      toAccountId: life,
      title: '每月生活费',
      daysAgo: 5,
      hour: 10,
    },
    // —— 生活费日常支出（多天）——
    {
      type: 'expense',
      amount: 128.5,
      accountId: life,
      categoryId: categoryIdByKey.get('生活费/食物'),
      title: '晚饭 + 水果',
      note: '和同事在楼下吃',
      tags: ['买菜'],
      daysAgo: 0,
      hour: 19,
    },
    {
      type: 'expense',
      amount: 12,
      accountId: life,
      categoryId: categoryIdByKey.get('生活费/交通'),
      title: '地铁通勤',
      daysAgo: 0,
      hour: 8,
    },
    {
      type: 'expense',
      amount: 76,
      accountId: life,
      categoryId: categoryIdByKey.get('生活费/日用'),
      title: '超市日用',
      daysAgo: 2,
      hour: 20,
    },
    // —— 消费账户支出 ——
    {
      type: 'expense',
      amount: 218,
      accountId: consume,
      categoryId: categoryIdByKey.get('消费/购物'),
      title: '连衣裙',
      daysAgo: 3,
      hour: 15,
    },
    {
      type: 'expense',
      amount: 28,
      accountId: consume,
      categoryId: categoryIdByKey.get('消费/订阅'),
      title: '音乐会员',
      note: '年度订阅均摊',
      tags: ['固定'],
      daysAgo: 4,
      hour: 11,
    },
    // —— 工资账户里的一笔报销收入 ——
    {
      type: 'income',
      amount: 320,
      accountId: salary,
      categoryId: categoryIdByKey.get('工资/报销'),
      title: '差旅报销',
      tags: ['报销'],
      daysAgo: 1,
      hour: 14,
    },
  ];

  for (const p of plans) {
    const tagIds = (p.tags ?? [])
      .map((name) => tagIdByName.get(name))
      .filter((id): id is Id => !!id);
    await txnService.create({
      type: p.type,
      amount: yuanToCents(p.amount),
      accountId: p.accountId,
      toAccountId: p.type === 'transfer' ? (p.toAccountId ?? null) : null,
      categoryId: p.type === 'transfer' ? null : (p.categoryId ?? null),
      time: timeOf(p.daysAgo, p.hour),
      title: p.title,
      note: p.note ?? null,
      tagIds,
    });
  }
}
