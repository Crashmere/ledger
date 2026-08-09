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

import { accountService, categoryService, tagService } from '../services';

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

  for (const group of SEED) {
    const account = await accountService.create({
      name: group.account.name,
      color: argb(group.account.color),
    });
    for (const cat of group.categories) {
      await categoryService.create({
        accountId: account.id,
        name: cat.name,
        color: argb(cat.color),
      });
    }
  }

  for (const tag of SEED_TAGS) {
    await tagService.create({ name: tag.name, color: argb(tag.color) });
  }
}
