// ============================================================
// adapter.web.ts —— SqliteAdapter 的 Web 实现（sqlite-wasm + OPFS，Worker 版）
// ============================================================
// 权威来源：06-接口契约.ts §1（SqliteAdapter）、S0 任务书 §三/§四。
// 关键约定：
//   - 数据库文件持久化到 OPFS，刷新页面数据不丢。
//   - 每个连接建立后立即执行 PRAGMA foreign_keys = ON。
//   - 上层只依赖 SqliteAdapter 接口，绝不 import 本文件之外的 sqlite 驱动。
//
// VFS 选型：用官方 Worker1 Promiser（sqlite3Worker1Promiser）+ OPFS VFS。
//   经典 oo1.OpfsDb 依赖 Atomics.wait()、SAHPool 依赖 createSyncAccessHandle()，
//   二者都只能在 Worker 线程用，主线程会报 "Atomics.wait/Missing OPFS APIs"。
//   因此让 SQLite 跑在专用 Worker 里，主线程通过 Promise 消息与之通信——
//   这与本 adapter 的全异步接口天然契合。
//   仍需页面跨源隔离（COOP/COEP，见 vite.config.ts）以获得 SharedArrayBuffer。
// ============================================================

import { sqlite3Worker1Promiser } from '@sqlite.org/sqlite-wasm';
import type { SqliteAdapter } from './adapter';

/** Worker1 promiser 的响应信封。 */
interface Worker1Response<R = unknown> {
  type: string;
  result: R;
  dbId?: string;
}

/** exec 返回的 result 结构（我们只关心 resultRows）。 */
interface ExecResult {
  resultRows?: Record<string, unknown>[];
}

/** open 返回的 result 结构。 */
interface OpenResult {
  dbId: string;
  filename: string;
  persistent: boolean;
  vfs: string;
}

/** promiser 工厂：promiser(type, args) => Promise<response>。 */
type Promiser = <R = unknown>(
  type: string,
  args: Record<string, unknown>,
) => Promise<Worker1Response<R>>;

/** OPFS 中的数据库文件名。桌面端（S12）另有 .db 磁盘文件，与此无关。 */
const DB_FILENAME = 'ivy-wallet.sqlite3';

export class WebSqliteAdapter implements SqliteAdapter {
  private promiser: Promiser | null = null;
  private dbId: string | null = null;
  /** 事务嵌套深度：用 SAVEPOINT 支持嵌套，深度 0 时用最外层 BEGIN/COMMIT。 */
  private txDepth = 0;

  async init(): Promise<void> {
    if (this.promiser) return; // 幂等：已初始化直接返回。

    // 用官方默认 worker 配置（包内以 new Worker(new URL(...)) 声明，
    // Vite 会自动把 worker 及其 wasm 资源打包并正确定位 URL）。
    const promiser = (await sqlite3Worker1Promiser.v2()) as unknown as Promiser;
    this.promiser = promiser;

    // 打开（不存在则创建）OPFS 持久化库文件。
    const opened = await promiser<OpenResult>('open', {
      filename: `file:${DB_FILENAME}?vfs=opfs`,
    });
    this.dbId = opened.result.dbId;

    if (!opened.result.persistent) {
      throw new Error(
        `OPFS 持久化未生效（当前 VFS=${opened.result.vfs}）：请确认运行环境支持 OPFS 且页面已跨源隔离（COOP/COEP）。`,
      );
    }

    // 每个连接建立后立即打开外键，否则 RESTRICT/SET NULL/CASCADE 全部失效。
    await this.exec('PRAGMA foreign_keys = ON;');
  }

  private requireReady(): { promiser: Promiser; dbId: string } {
    if (!this.promiser || !this.dbId) {
      throw new Error('SqliteAdapter 尚未初始化，请先调用 init()。');
    }
    return { promiser: this.promiser, dbId: this.dbId };
  }

  /** 底层 exec 封装：统一走 worker，返回对象行数组。 */
  private async exec(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const { promiser, dbId } = this.requireReady();
    try {
      const resp = await promiser<ExecResult>('exec', {
        dbId,
        sql,
        bind: params.length ? params : undefined,
        rowMode: 'object',
        resultRows: [],
      });
      return resp.result.resultRows ?? [];
    } catch (e) {
      // Worker1 promiser 在出错时 reject 的是响应信封，而非 Error 实例；
      // 归一化为真正的 Error，让上层（S1）能按 message 识别外键 RESTRICT 等。
      throw normalizeWorkerError(e);
    }
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.exec(sql, params);
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await this.exec(sql, params);
    return rows as T[];
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.exec(sql, params);
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  /**
   * 事务：回调内所有操作要么全成功要么全回滚。
   * Worker 侧串行处理消息，顺序有保证；共享单库连接，用 SAVEPOINT 支持嵌套。
   */
  async transaction<T>(fn: (tx: SqliteAdapter) => Promise<T>): Promise<T> {
    const isOuter = this.txDepth === 0;
    const savepoint = `sp_${this.txDepth}`;

    await this.exec(isOuter ? 'BEGIN;' : `SAVEPOINT ${savepoint};`);
    this.txDepth += 1;

    try {
      const result = await fn(this);
      this.txDepth -= 1;
      await this.exec(isOuter ? 'COMMIT;' : `RELEASE ${savepoint};`);
      return result;
    } catch (err) {
      this.txDepth -= 1;
      if (isOuter) {
        await this.exec('ROLLBACK;');
      } else {
        await this.exec(`ROLLBACK TO ${savepoint};`);
        await this.exec(`RELEASE ${savepoint};`);
      }
      throw err;
    }
  }

  async getUserVersion(): Promise<number> {
    const row = await this.get<{ user_version: number }>('PRAGMA user_version;');
    return row?.user_version ?? 0;
  }

  async setUserVersion(v: number): Promise<void> {
    // PRAGMA 不支持绑定参数，且 v 由内部调用（整数），直接内联。
    const n = Math.trunc(v);
    await this.exec(`PRAGMA user_version = ${n};`);
  }

  async exportBytes(): Promise<Uint8Array> {
    const { promiser, dbId } = this.requireReady();
    const resp = await promiser<{ byteArray: Uint8Array }>('export', { dbId });
    return resp.result.byteArray;
  }

  async importBytes(bytes: Uint8Array): Promise<void> {
    // S8 恢复用。S0 不走此路径。Worker1 API 无直接 import 消息，
    // 这里复用 sqlite-wasm 的 OPFS 导入约定：留待 S8 依据届时选型实现。
    void bytes;
    throw new Error('importBytes 将在 S8（备份/恢复）阶段实现。');
  }
}

/**
 * 把 Worker1 promiser 抛出的错误归一化为 Error。
 * 出错时 promiser reject 的是响应信封 { type:'error', result:{ message, errorClass, ... } }，
 * 直接 String() 会得到 "[object Object]"。这里提取出真正的错误信息。
 */
function normalizeWorkerError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === 'object') {
    const envelope = e as { result?: { message?: string; errorClass?: string } };
    const msg = envelope.result?.message;
    if (typeof msg === 'string' && msg.length > 0) {
      const err = new Error(msg);
      if (envelope.result?.errorClass) err.name = envelope.result.errorClass;
      return err;
    }
  }
  return new Error(String(e));
}
