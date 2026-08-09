// ============================================================
// better-sqlite-adapter.ts —— 测试用 SqliteAdapter（Node + better-sqlite3）
// ============================================================
// 用途：单测在 Node 下用独立内存库，不污染 OPFS。
// 关键（S1 任务书 §五）：
//   - 复用同一份建表 DDL（src/db/migrations/ddl_v1.ts，= 04 镜像）。
//   - 必须 PRAGMA foreign_keys = ON，否则测不出 RESTRICT / SET NULL / CASCADE。
// 服务层只依赖 SqliteAdapter 接口，故此测试实现可完全替换 Web/OPFS 实现。
// better-sqlite3 是同步 API，这里包成 async 以匹配接口签名。
// ============================================================

import Database from 'better-sqlite3';
import type { SqliteAdapter } from '../src/db/adapter';
import { DDL_V1 } from '../src/db/migrations/ddl_v1';

/** 逐条拆分 DDL（与 src/db/migrations/index.ts 的实现保持一致）。 */
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

export class BetterSqliteAdapter implements SqliteAdapter {
  private readonly db: Database.Database;
  private txDepth = 0;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
  }

  async init(): Promise<void> {
    // 外键必须显式打开（SQLite 默认关闭）。
    this.db.pragma('foreign_keys = ON');
    for (const stmt of splitStatements(DDL_V1)) {
      this.db.exec(stmt);
    }
    this.db.pragma('user_version = 1');
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    // PRAGMA / 无结果集语句无法 .all()，用 reader 判定。
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
    const row = stmt.get(...(params as never[]));
    return (row as T) ?? null;
  }

  /** 事务：用 SAVEPOINT 支持嵌套，语义与 Web adapter 一致。 */
  async transaction<T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> {
    const isOuter = this.txDepth === 0;
    const savepoint = `sp_${this.txDepth}`;

    this.db.exec(isOuter ? 'BEGIN;' : `SAVEPOINT ${savepoint};`);
    this.txDepth += 1;

    try {
      const result = await fn(this);
      this.txDepth -= 1;
      this.db.exec(isOuter ? 'COMMIT;' : `RELEASE ${savepoint};`);
      return result;
    } catch (err) {
      this.txDepth -= 1;
      if (isOuter) {
        this.db.exec('ROLLBACK;');
      } else {
        this.db.exec(`ROLLBACK TO ${savepoint};`);
        this.db.exec(`RELEASE ${savepoint};`);
      }
      throw err;
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

  async importBytes(bytes: Uint8Array): Promise<void> {
    void bytes;
    throw new Error('测试 adapter 不支持 importBytes');
  }

  close(): void {
    this.db.close();
  }
}

/** 建一个已初始化好（建表 + 外键开）的测试库。 */
export async function makeTestAdapter(): Promise<BetterSqliteAdapter> {
  const adapter = new BetterSqliteAdapter();
  await adapter.init();
  return adapter;
}
