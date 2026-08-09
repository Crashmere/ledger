// ============================================================
// internal.ts —— 服务层内部共享工具（行映射 / 错误识别）
// ============================================================
// 不对外导出到 UI；仅供 src/services/ 内部各 service 复用。
//   - DB 行（snake_case、0/1 整数）↔ 领域实体（camelCase、boolean）的映射。
//   - 外键 RESTRICT 错误识别：sqlite 抛的 Error message 含 "FOREIGN KEY constraint failed"，
//     据此在 remove 里转成 AppError('RESTRICT', …)。
// ============================================================

import type { Account, Category, Tag, Txn, TxnType } from './contract';

/** 从错误 message 判断是否外键约束失败（RESTRICT/被引用而不能删）。 */
export function isForeignKeyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /FOREIGN KEY constraint failed/i.test(msg);
}

// ------------------------------------------------------------
// 行 → 领域实体映射（列名与 04-数据库schema.sql 精确对应）
// ------------------------------------------------------------
export interface AccountRow {
  id: string;
  name: string;
  color: number;
  icon: string | null;
  initial_balance: number;
  include_in_balance: number; // 0/1
  order_num: number;
  created_at: number;
}

export function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    initialBalance: r.initial_balance,
    includeInBalance: r.include_in_balance === 1,
    orderNum: r.order_num,
    createdAt: r.created_at,
  };
}

export interface CategoryRow {
  id: string;
  account_id: string;
  name: string;
  color: number;
  icon: string | null;
  order_num: number;
  created_at: number;
}

export function rowToCategory(r: CategoryRow): Category {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    orderNum: r.order_num,
    createdAt: r.created_at,
  };
}

export interface TagRow {
  id: string;
  name: string;
  color: number;
  icon: string | null;
  order_num: number;
  created_at: number;
}

export function rowToTag(r: TagRow): Tag {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    orderNum: r.order_num,
    createdAt: r.created_at,
  };
}

export interface TxnRow {
  id: string;
  type: string;
  amount: number;
  account_id: string;
  to_account_id: string | null;
  category_id: string | null;
  time: number;
  title: string | null;
  note: string | null;
  created_at: number;
}

export function rowToTxn(r: TxnRow): Txn {
  return {
    id: r.id,
    type: r.type as TxnType,
    amount: r.amount,
    accountId: r.account_id,
    toAccountId: r.to_account_id,
    categoryId: r.category_id,
    time: r.time,
    title: r.title,
    note: r.note,
    createdAt: r.created_at,
  };
}
