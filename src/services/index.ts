// ============================================================
// index.ts —— 服务层统一出口 + 装配
// ============================================================
// 权威来源：06-接口契约.ts、S1 任务书 §四.8。
// 装配约定：
//   - 每个 service 都可注入 SqliteAdapter（构造函数默认 getAdapter()）；
//     单测时传入独立测试库，生产环境用默认 Web/OPFS adapter。
//   - 对外同时导出：实现类、工厂函数、以及基于默认 adapter 的单例（供 UI/Store 直接用）。
// 上层只从这里 import 服务，不直接 import 具体驱动。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { AccountServiceImpl } from './account';
import { CategoryServiceImpl } from './category';
import { SettingServiceImpl } from './setting';
import { StatsServiceImpl } from './stats';
import { TagServiceImpl } from './tag';
import { TxnServiceImpl } from './txn';

// 契约类型/错误 re-export，方便上层只从 services 引用。
export * from './contract';
export { yuanToCents, centsToYuan, format, MoneyUtil } from './money';
export { AccountServiceImpl } from './account';
export { CategoryServiceImpl } from './category';
export { TagServiceImpl } from './tag';
export { TxnServiceImpl } from './txn';
export { StatsServiceImpl } from './stats';
export { SettingServiceImpl } from './setting';

/** 一次性构造全部服务（注入同一个 adapter）。单测/多库场景用它。 */
export function createServices(adapter?: SqliteAdapter) {
  return {
    accounts: new AccountServiceImpl(adapter),
    categories: new CategoryServiceImpl(adapter),
    tags: new TagServiceImpl(adapter),
    txns: new TxnServiceImpl(adapter),
    stats: new StatsServiceImpl(adapter),
    settings: new SettingServiceImpl(adapter),
  };
}

export type Services = ReturnType<typeof createServices>;

// 默认单例（挂在默认 adapter 上，供 UI/Store 直接使用）。
export const accountService = new AccountServiceImpl();
export const categoryService = new CategoryServiceImpl();
export const tagService = new TagServiceImpl();
export const txnService = new TxnServiceImpl();
export const statsService = new StatsServiceImpl();
export const settingService = new SettingServiceImpl();
