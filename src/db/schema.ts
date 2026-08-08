// ============================================================
// 记账系统 · Drizzle ORM Schema (SQLite) · 与 04-数据库schema.sql 等价
// ============================================================
// 权威来源：01-设计文档.md §3。若与 04-数据库schema.sql 不一致，以 SQL 文件为准。
// 放置位置：src/db/schema.ts
//
// 说明：
// - 金额字段（amount / initial_balance）单位是"分"，整数。
// - 时间字段（time / created_at）是 epoch 毫秒整数。
// - 主键是 UUID 字符串，用 crypto.randomUUID() 生成。
// - CHECK 约束（type 枚举、amount>0、转账互斥规则）由 SQL 层保证；
//   Drizzle 目前对 CHECK 支持有限，务必以 04 的 DDL 建库，schema 仅用于类型与查询。
// ============================================================

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
} from 'drizzle-orm/sqlite-core';

// ------------------------------------------------------------
// account · 账户
// ------------------------------------------------------------
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: integer('color').notNull(), // ARGB 整数，可为负
  icon: text('icon'),
  initialBalance: integer('initial_balance').notNull().default(0), // 分
  includeInBalance: integer('include_in_balance').notNull().default(1), // 0/1
  orderNum: real('order_num').notNull(),
  createdAt: integer('created_at').notNull(), // epoch ms
});

// ------------------------------------------------------------
// category · 分类（归属账户）
// FK: account_id -> account.id  ON DELETE RESTRICT
// ------------------------------------------------------------
export const category = sqliteTable(
  'category',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    color: integer('color').notNull(),
    icon: text('icon'),
    orderNum: real('order_num').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    accountIdx: index('idx_category_account').on(t.accountId),
  }),
);

// ------------------------------------------------------------
// txn · 交易（income / expense / transfer 同表）
// FK: account_id / to_account_id -> account.id  ON DELETE RESTRICT
//     category_id -> category.id                ON DELETE SET NULL
// ------------------------------------------------------------
export const txn = sqliteTable(
  'txn',
  {
    id: text('id').primaryKey(),
    // 'income' | 'expense' | 'transfer'（CHECK 在 SQL 层）
    type: text('type').notNull(),
    amount: integer('amount').notNull(), // 分，正数
    accountId: text('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    toAccountId: text('to_account_id').references(() => account.id, {
      onDelete: 'restrict',
    }),
    categoryId: text('category_id').references(() => category.id, {
      onDelete: 'set null',
    }),
    time: integer('time').notNull(), // 交易发生时间 epoch ms
    title: text('title'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    timeIdx: index('idx_txn_time').on(t.time),
    accountIdx: index('idx_txn_account').on(t.accountId),
    toAccountIdx: index('idx_txn_to_account').on(t.toAccountId),
    categoryIdx: index('idx_txn_category').on(t.categoryId),
    typeIdx: index('idx_txn_type').on(t.type),
  }),
);

// ------------------------------------------------------------
// tag · 标签（全局共享）
// ------------------------------------------------------------
export const tag = sqliteTable('tag', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: integer('color').notNull(),
  icon: text('icon'),
  orderNum: real('order_num').notNull(),
  createdAt: integer('created_at').notNull(),
});

// ------------------------------------------------------------
// txn_tag · 交易↔标签 多对多
// 复合主键 (txn_id, tag_id)；两侧 ON DELETE CASCADE
// ------------------------------------------------------------
export const txnTag = sqliteTable(
  'txn_tag',
  {
    txnId: text('txn_id')
      .notNull()
      .references(() => txn.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.txnId, t.tagId] }),
    tagIdx: index('idx_txn_tag_tag').on(t.tagId),
  }),
);

// ------------------------------------------------------------
// setting · 键值设置
// ------------------------------------------------------------
export const setting = sqliteTable('setting', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ------------------------------------------------------------
// 推断类型（供服务层直接引用）
// ------------------------------------------------------------
export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;
export type Txn = typeof txn.$inferSelect;
export type NewTxn = typeof txn.$inferInsert;
export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;
export type TxnTag = typeof txnTag.$inferSelect;
export type Setting = typeof setting.$inferSelect;

// 建库/迁移时在每个连接执行，确保外键规则生效：
export const ENABLE_FK = sql`PRAGMA foreign_keys = ON;`;
export const SCHEMA_VERSION = 1;
