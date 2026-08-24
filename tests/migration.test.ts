// ============================================================
// migration.test.ts —— 迁移正确性（真实 better-sqlite3 走完整 migrator）
// ============================================================
// 重点验证 v1 -> v2：
//   - 幂等：反复迁移不报错、版本稳定在最新。
//   - 加列：account/category/txn/tag 均有 updated_at / deleted_at。
//   - 回填：存量行 updated_at = created_at，deleted_at 为 NULL。
//   - 数据完好：迁移不丢行、不改既有字段值。
// ============================================================

import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { SqliteAdapter } from '../src/db/adapter';
import { migrator } from '../src/db/migrations';
import { DDL_V1 } from '../src/db/migrations/ddl_v1';
import { SCHEMA_VERSION } from '../src/db/schema';

/** 逐条拆分 DDL（与 migrator 内实现一致）。 */
function splitStatements(script: string): string[] {
  return script
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

/** 一个只建到 v1 的库（模拟老设备的存量数据），供迁移测试升级。 */
class V1OnlyAdapter implements SqliteAdapter {
  readonly db: Database.Database;
  private txDepth = 0;
  constructor() {
    this.db = new Database(':memory:');
  }
  /** 只建 v1 表并置 user_version=1，不跑 v2。 */
  buildV1(): void {
    this.db.pragma('foreign_keys = ON');
    for (const stmt of splitStatements(DDL_V1)) this.db.exec(stmt);
    this.db.pragma('user_version = 1');
  }
  async init(): Promise<void> {
    this.buildV1();
  }
  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }
  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    if (!stmt.reader) {
      stmt.run(...(params as never[]));
      return [];
    }
    return stmt.all(...(params as never[])) as T[];
  }
  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    if (!stmt.reader) {
      stmt.run(...(params as never[]));
      return null;
    }
    return (stmt.get(...(params as never[])) as T) ?? null;
  }
  async transaction<T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> {
    const isOuter = this.txDepth === 0;
    const sp = `sp_${this.txDepth}`;
    this.db.exec(isOuter ? 'BEGIN;' : `SAVEPOINT ${sp};`);
    this.txDepth += 1;
    try {
      const r = await fn(this);
      this.txDepth -= 1;
      this.db.exec(isOuter ? 'COMMIT;' : `RELEASE ${sp};`);
      return r;
    } catch (e) {
      this.txDepth -= 1;
      if (isOuter) this.db.exec('ROLLBACK;');
      else {
        this.db.exec(`ROLLBACK TO ${sp};`);
        this.db.exec(`RELEASE ${sp};`);
      }
      throw e;
    }
  }
  async getUserVersion(): Promise<number> {
    return this.db.pragma('user_version', { simple: true }) as number;
  }
  async setUserVersion(v: number): Promise<void> {
    this.db.pragma(`user_version = ${Math.trunc(v)}`);
  }
  async exportBytes(): Promise<Uint8Array> {
    return this.db.serialize();
  }
  async importBytes(): Promise<void> {
    throw new Error('n/a');
  }
  close(): void {
    this.db.close();
  }
}

/** 往 v1 库塞一批存量数据（含账户/分类/交易/标签），用于验证迁移不丢不改。 */
async function seedV1(a: V1OnlyAdapter): Promise<void> {
  await a.run(
    `INSERT INTO account(id,name,color,icon,initial_balance,include_in_balance,order_num,created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    ['acc-1', '现金', 1, null, 10000, 1, 0, 1000],
  );
  await a.run(
    `INSERT INTO category(id,account_id,name,color,icon,order_num,created_at)
     VALUES(?,?,?,?,?,?,?)`,
    ['cat-1', 'acc-1', '餐饮', 2, null, 0, 1100],
  );
  await a.run(
    `INSERT INTO txn(id,type,amount,account_id,to_account_id,category_id,time,title,note,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ['txn-1', 'expense', 500, 'acc-1', null, 'cat-1', 2000, '午饭', null, 1200],
  );
  await a.run(`INSERT INTO tag(id,name,color,icon,order_num,created_at) VALUES(?,?,?,?,?,?)`, [
    'tag-1',
    '报销',
    3,
    null,
    0,
    1300,
  ]);
}

describe('迁移 v1 -> v2', () => {
  let a: V1OnlyAdapter;
  beforeEach(async () => {
    a = new V1OnlyAdapter();
    await a.init(); // 只到 v1
    await seedV1(a);
  });
  afterEach(() => a.close());

  it('升级后 user_version = 最新', async () => {
    expect(await a.getUserVersion()).toBe(1);
    await migrator.migrateToLatest(a);
    expect(await a.getUserVersion()).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(3);
  });

  it('四表都新增了 updated_at / deleted_at 列', async () => {
    await migrator.migrateToLatest(a);
    for (const table of ['account', 'category', 'txn', 'tag']) {
      const cols = await a.all<{ name: string }>(`PRAGMA table_info(${table})`);
      const names = cols.map((c) => c.name);
      expect(names).toContain('updated_at');
      expect(names).toContain('deleted_at');
    }
  });

  it('回填：updated_at = created_at，deleted_at 为 NULL', async () => {
    await migrator.migrateToLatest(a);
    const rows = await a.all<{ created_at: number; updated_at: number; deleted_at: number | null }>(
      `SELECT created_at, updated_at, deleted_at FROM txn`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].updated_at).toBe(rows[0].created_at);
    expect(rows[0].deleted_at).toBeNull();
    // 账户同理。
    const acc = await a.get<{ created_at: number; updated_at: number }>(
      `SELECT created_at, updated_at FROM account WHERE id='acc-1'`,
    );
    expect(acc!.updated_at).toBe(acc!.created_at);
  });

  it('迁移不丢行、不改既有字段', async () => {
    await migrator.migrateToLatest(a);
    expect((await a.all(`SELECT * FROM account`)).length).toBe(1);
    expect((await a.all(`SELECT * FROM txn`)).length).toBe(1);
    const txn = await a.get<Record<string, unknown>>(`SELECT * FROM txn WHERE id='txn-1'`);
    expect(txn!.amount).toBe(500);
    expect(txn!.title).toBe('午饭');
    expect(txn!.account_id).toBe('acc-1');
  });

  it('幂等：重复迁移不报错、版本稳定', async () => {
    await migrator.migrateToLatest(a);
    await migrator.migrateToLatest(a);
    await migrator.migrateToLatest(a);
    expect(await a.getUserVersion()).toBe(SCHEMA_VERSION);
    // 列不会被加两次（ADD COLUMN 若重复会报错，能跑到这里即证明已被 user_version 守卫拦住）。
    const cols = await a.all<{ name: string }>(`PRAGMA table_info(txn)`);
    expect(cols.filter((c) => c.name === 'updated_at')).toHaveLength(1);
  });
});

describe('迁移 v1 -> v3（专项账户列）', () => {
  let a: V1OnlyAdapter;
  beforeEach(async () => {
    a = new V1OnlyAdapter();
    await a.init(); // 只到 v1
    await seedV1(a);
  });
  afterEach(() => a.close());

  it('account 新增 kind/period_start/period_end/archived_at 列', async () => {
    await migrator.migrateToLatest(a);
    const cols = await a.all<{ name: string }>(`PRAGMA table_info(account)`);
    const names = cols.map((c) => c.name);
    expect(names).toContain('kind');
    expect(names).toContain('period_start');
    expect(names).toContain('period_end');
    expect(names).toContain('archived_at');
  });

  it('存量账户行 kind 回填为 NULL（即普通账户）', async () => {
    await migrator.migrateToLatest(a);
    const acc = await a.get<{ kind: string | null; archived_at: number | null }>(
      `SELECT kind, archived_at FROM account WHERE id='acc-1'`,
    );
    expect(acc!.kind).toBeNull();
    expect(acc!.archived_at).toBeNull();
  });

  it('kind 上建了索引 idx_account_kind', async () => {
    await migrator.migrateToLatest(a);
    const idx = await a.all<{ name: string }>(`PRAGMA index_list(account)`);
    expect(idx.map((i) => i.name)).toContain('idx_account_kind');
  });

  it('幂等：重复迁移不会重复加 kind 列', async () => {
    await migrator.migrateToLatest(a);
    await migrator.migrateToLatest(a);
    const cols = await a.all<{ name: string }>(`PRAGMA table_info(account)`);
    expect(cols.filter((c) => c.name === 'kind')).toHaveLength(1);
  });
});
