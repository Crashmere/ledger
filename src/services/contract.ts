// ============================================================
// contract.ts —— 领域层类型与服务接口（镜像 交接资料/06-接口契约.ts）
// ============================================================
// 权威来源：新记账系统-交接资料/06-接口契约.ts（本阶段最重要，签名逐字一致）。
// 06 文件放在交接资料目录、不在 src/ 下（tsconfig 的 include 只含 src/**），
// 因此这里在 src 内做一份等价镜像，供各 Service `implements`。
//   - 基础别名 Id/Cents/EpochMs 直接复用 db/adapter.ts，避免重复定义漂移。
//   - 实体/Draft/Query/Service 接口/AppError 与 06 完全一致；06 变更时同步本文件。
// 本文件不依赖 Vue、不依赖任何具体驱动。
// ============================================================

import type { Id, Cents, EpochMs } from '../db/adapter';

export type { Id, Cents, EpochMs };

export type TxnType = 'income' | 'expense' | 'transfer';

/**
 * 账户种类：
 *   - 'normal'（或历史 NULL）：普通账户，计入日常余额与统计。
 *   - 'project'：专项账户（如一次旅行），默认不计入余额总额，且交易被全局收支统计排除。
 * 开放枚举，未来可扩展（如 'budget'）。领域层归一：NULL → 'normal'。
 */
export type AccountKind = 'normal' | 'project';

// ------------------------------------------------------------
// 实体类型（与 05-drizzle-schema.ts 的推断类型对应）
// ------------------------------------------------------------
export interface Account {
  id: Id;
  name: string;
  color: number; // ARGB 整数
  icon: string | null;
  initialBalance: Cents;
  includeInBalance: boolean; // 存储层用 0/1，领域层用 boolean
  orderNum: number;
  createdAt: EpochMs;
  kind: AccountKind; // v3：账户种类（存储层 NULL 归一为 'normal'）
  periodStart: EpochMs | null; // v3：专项时间段起（仅 project 有意义）
  periodEnd: EpochMs | null; // v3：专项时间段止
  archivedAt: EpochMs | null; // v3：归档/结束标记，非空=已归档
}

export interface Category {
  id: Id;
  accountId: Id; // 归属账户
  name: string;
  color: number;
  icon: string | null;
  orderNum: number;
  createdAt: EpochMs;
}

export interface Txn {
  id: Id;
  type: TxnType;
  amount: Cents; // 正数
  accountId: Id; // 收入=收款；支出=付款；转账=转出
  toAccountId: Id | null; // 仅 transfer
  categoryId: Id | null;
  time: EpochMs; // 交易发生时间
  title: string | null;
  note: string | null;
  createdAt: EpochMs;
}

export interface Tag {
  id: Id;
  name: string;
  color: number;
  icon: string | null;
  orderNum: number;
  createdAt: EpochMs;
}

// ------------------------------------------------------------
// 服务层输入类型（写操作用 Draft，省略由系统生成的字段）
// ------------------------------------------------------------
export interface AccountDraft {
  name: string;
  color: number;
  icon?: string | null;
  initialBalance?: Cents; // 默认 0
  includeInBalance?: boolean; // 默认 true；专项账户建议 false
  orderNum?: number; // 省略则追加到末尾
  kind?: AccountKind; // 省略=普通账户；'project'=专项
  periodStart?: EpochMs | null; // 专项时间段起
  periodEnd?: EpochMs | null; // 专项时间段止
  archivedAt?: EpochMs | null; // 归档标记
}

export interface CategoryDraft {
  accountId: Id; // 必填：分类必属某账户
  name: string;
  color: number;
  icon?: string | null;
  orderNum?: number;
}

/** 记一笔的输入。转账时 toAccountId 必填、categoryId 可为空。 */
export interface TxnDraft {
  type: TxnType;
  amount: Cents; // 正数分
  accountId: Id;
  toAccountId?: Id | null; // 仅 transfer；transfer 时必填且 != accountId
  categoryId?: Id | null;
  time?: EpochMs; // 省略则 = 现在
  title?: string | null;
  note?: string | null;
  tagIds?: Id[]; // 关联标签，可空
}

export interface TagDraft {
  name: string;
  color: number;
  icon?: string | null;
  orderNum?: number;
}

// ------------------------------------------------------------
// 服务层：账户 / 分类 / 标签 / 交易
// ------------------------------------------------------------
export interface AccountService {
  list(): Promise<Account[]>;
  get(id: Id): Promise<Account | null>;
  create(draft: AccountDraft): Promise<Account>;
  update(id: Id, patch: Partial<AccountDraft>): Promise<Account>;
  /** 有交易/分类挂着时应抛 AppError('RESTRICT')，提示先处理。 */
  remove(id: Id): Promise<void>;
  reorder(orderedIds: Id[]): Promise<void>;
  /** 余额 = initialBalance + 该账户交易累加（转账双向计入）。 */
  balance(id: Id): Promise<Cents>;
}

export interface CategoryService {
  /** 列出某账户下的分类（记一笔选账户后调此，兑现"分类只列本账户"）。 */
  listByAccount(accountId: Id): Promise<Category[]>;
  get(id: Id): Promise<Category | null>;
  create(draft: CategoryDraft): Promise<Category>;
  update(id: Id, patch: Partial<CategoryDraft>): Promise<Category>;
  /** 删分类：其交易 category_id 由 DB 置 NULL（ON DELETE SET NULL）。 */
  remove(id: Id): Promise<void>;
  reorder(accountId: Id, orderedIds: Id[]): Promise<void>;
}

export interface TagService {
  list(): Promise<Tag[]>;
  create(draft: TagDraft): Promise<Tag>;
  update(id: Id, patch: Partial<TagDraft>): Promise<Tag>;
  remove(id: Id): Promise<void>;
}

/** 交易查询过滤条件（搜索/报告/账户明细共用）。 */
export interface TxnQuery {
  types?: TxnType[];
  accountIds?: Id[];
  categoryIds?: Id[];
  tagIds?: Id[];
  keyword?: string; // 匹配 title/note
  timeFrom?: EpochMs;
  timeTo?: EpochMs;
  amountMin?: Cents;
  amountMax?: Cents;
  sortBy?: 'time' | 'amount';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /**
   * 省略/false = 不排除；true = 排除属于专项账户（kind='project'）的交易。
   * 用于概览/报告等「日常口径」默认屏蔽专项开支；显式选中专项账户时不要置 true。
   */
  excludeProjects?: boolean;
}

/** 交易带上关联标签一起返回，方便 UI 渲染。 */
export interface TxnWithTags extends Txn {
  tags: Tag[];
}

export interface TxnService {
  query(q: TxnQuery): Promise<TxnWithTags[]>;
  get(id: Id): Promise<TxnWithTags | null>;
  /** 记一笔：校验金额>0、transfer 的 toAccountId 有效且 != accountId、分类属该账户。 */
  create(draft: TxnDraft): Promise<Txn>;
  update(id: Id, patch: Partial<TxnDraft>): Promise<Txn>;
  remove(id: Id): Promise<void>;
}

// ------------------------------------------------------------
// 统计服务（概览/报告用；跨账户按分类名合并在此实现，不靠数据结构）
// ------------------------------------------------------------
export interface Summary {
  income: Cents;
  expense: Cents;
  net: Cents; // income - expense；转账不计入收支，仅账户间流动
}

export interface CategoryBreakdownRow {
  categoryName: string; // 跨账户按 name 合并
  amount: Cents;
  count: number;
}

export interface TrendPoint {
  bucket: string; // 如 '2026-08'（按月）或 '2026-08-08'（按日）
  income: Cents;
  expense: Cents;
}

export interface StatsService {
  /** 概览汇总（可选时间/账户范围；excludeProjects 排除专项账户交易）。 */
  summary(
    q?: Pick<TxnQuery, 'accountIds' | 'timeFrom' | 'timeTo' | 'excludeProjects'>,
  ): Promise<Summary>;
  /** 按分类名合并的支出/收入分布（饼图）。 */
  breakdownByCategory(
    q: Pick<TxnQuery, 'types' | 'accountIds' | 'timeFrom' | 'timeTo' | 'excludeProjects'>,
  ): Promise<CategoryBreakdownRow[]>;
  /** 收支趋势（趋势图）。 */
  trend(
    q: Pick<TxnQuery, 'accountIds' | 'timeFrom' | 'timeTo' | 'excludeProjects'> & {
      granularity: 'day' | 'month';
    },
  ): Promise<TrendPoint[]>;
}

// ------------------------------------------------------------
// 金额工具（money.ts）—— 全局唯一的分/元转换入口
// ------------------------------------------------------------
export interface MoneyUtil {
  /** 元(字符串/数字) -> 分。必须用定点/四舍五入，禁止 int(x*100)。 */
  yuanToCents(yuan: string | number): Cents;
  /** 分 -> 元字符串（用于展示，如 780 -> "7.80"）。 */
  centsToYuan(cents: Cents): string;
  /** 格式化带符号金额（收入+、支出-），供 UI 用。 */
  format(cents: Cents, opts?: { sign?: boolean; symbol?: string }): string;
}

// ------------------------------------------------------------
// 设置（键值）
// ------------------------------------------------------------
export interface SettingService {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  all(): Promise<Record<string, string>>;
}

// ------------------------------------------------------------
// 领域错误
// ------------------------------------------------------------
export type AppErrorCode =
  | 'RESTRICT' // 删除被外键 RESTRICT 拦住（如账户下有交易）
  | 'NOT_FOUND'
  | 'VALIDATION' // 金额<=0、转账账户非法、分类不属该账户等
  | 'DB';

export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
