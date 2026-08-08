// ============================================================
// DAL：跨平台唯一的缝。Web 与 Tauri 各实现一份。
// ============================================================
// 权威来源：06-接口契约.ts §0、§1。本文件只放本阶段（S0）用到的部分：
//   - 金额/主键/时间类型别名
//   - SqliteAdapter 接口（上层只依赖它，不直接 import sqlite 驱动）
//   - Migrator 接口
// 其余 Service 契约（AccountService 等）在 S1 才实现，这里不引入。
// ============================================================

export type Id = string; // UUID
export type Cents = number; // 整数分
export type EpochMs = number; // epoch 毫秒

// ------------------------------------------------------------
// DAL：跨平台唯一的缝。Web 与 Tauri 各实现一份。
//    上层只依赖此接口，不直接 import sqlite 驱动。
// ------------------------------------------------------------
export interface SqliteAdapter {
  /** 打开/初始化底层数据库（Web=OPFS 文件，Tauri=磁盘 .db）。内部须执行 PRAGMA foreign_keys=ON。 */
  init(): Promise<void>;

  /** 执行一条写语句（INSERT/UPDATE/DELETE/DDL）。 */
  run(sql: string, params?: unknown[]): Promise<void>;

  /** 查询多行。 */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** 查询单行（无则 null）。 */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;

  /** 事务：回调内的所有操作要么全成功要么全回滚。 */
  transaction<T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T>;

  /** 读/写 schema 版本（PRAGMA user_version）。 */
  getUserVersion(): Promise<number>;
  setUserVersion(v: number): Promise<void>;

  /** 导出整库为字节（用于阶段二备份）。 */
  exportBytes(): Promise<Uint8Array>;

  /** 用字节覆盖整库（用于阶段二恢复）。 */
  importBytes(bytes: Uint8Array): Promise<void>;
}

/** 迁移：由 user_version 驱动，逐版本升级。 */
export interface Migrator {
  /** 把库从当前 user_version 迁到最新（阶段一：0 -> 1，执行 04 的 DDL）。 */
  migrateToLatest(db: SqliteAdapter): Promise<void>;
}
