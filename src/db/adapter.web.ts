// ============================================================
// adapter.web.ts —— SqliteAdapter 的 Web 实现（sqlite-wasm + OPFS-SAHPool VFS，Worker 版）
// ============================================================
// 权威来源：06-接口契约.ts §1（SqliteAdapter）、S6 任务书 §四.1。
// 关键约定：
//   - 数据库文件持久化到 OPFS，刷新页面数据不丢。
//   - 每个连接建立后立即执行 PRAGMA foreign_keys = ON。
//   - 上层只依赖 SqliteAdapter 接口，绝不 import 本文件之外的 sqlite 驱动。
//
// VFS 选型（S6 起）：opfs-sahpool VFS（installOpfsSAHPoolVfs + oo1 OpfsSAHPoolDb），
//   跑在**专用 Worker**里（见 sqlite.worker.ts，方案 B）。
//   为什么用 Worker：SAHPool 依赖 createSyncAccessHandle()，此 API 在多数浏览器
//   **只在 Worker 线程可用**，主线程会报 "Missing required OPFS APIs"。
//   关键区别：SAHPool **不依赖 Atomics.wait / SharedArrayBuffer**，所以即便在 Worker
//   里也**无需页面跨源隔离（COOP/COEP）**——纯静态托管（GitHub Pages）也能持久化。
//   本 adapter 通过 postMessage/Promise 与 Worker 通信，与全异步接口天然契合。
// ============================================================

import type { SqliteAdapter } from './adapter';
import SqliteWorker from './sqlite.worker?worker';

/** Worker 回给主线程的响应信封。 */
interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string; name: string };
}

export class WebSqliteAdapter implements SqliteAdapter {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** 事务嵌套深度：用 SAVEPOINT 支持嵌套，深度 0 时用最外层 BEGIN/COMMIT。 */
  private txDepth = 0;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    // 幂等：并发/重复调用只真正初始化一次。
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const worker = new SqliteWorker();
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      // Worker 级致命错误：拒绝所有在途请求，避免永久挂起。
      const err = new Error(`SQLite worker 错误：${ev.message}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
    this.worker = worker;
    // 触发 Worker 内的 wasm 载入 + SAHPool 安装 + 建库 + PRAGMA foreign_keys=ON。
    await this.call('init');
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.result);
    } else {
      // 还原为 Error 实例，并保留底层 message（S1 服务层据 "FOREIGN KEY constraint failed"
      // 识别 RESTRICT）与 errorClass 名称。
      const err = new Error(msg.error?.message ?? '未知的 SQLite 错误');
      if (msg.error?.name) err.name = msg.error.name;
      p.reject(err);
    }
  }

  /** 向 Worker 发一条请求并等待其响应。 */
  private call(method: 'init' | 'export'): Promise<unknown>;
  private call(method: 'exec', sql: string, params: unknown[]): Promise<unknown>;
  private call(method: string, sql?: string, params?: unknown[]): Promise<unknown> {
    const worker = this.worker;
    if (!worker) {
      return Promise.reject(new Error('SqliteAdapter 尚未初始化，请先调用 init()。'));
    }
    const id = ++this.seq;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, sql, params });
    });
  }

  /** 底层 exec：返回**对象行**数组，键顺序 = SELECT 列顺序（防 Drizzle 列错位）。 */
  private async exec(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const rows = (await this.call('exec', sql, params)) as Record<string, unknown>[];
    return rows ?? [];
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
   * Worker 串行处理消息（oo1 exec 同步），顺序有保证；用 SAVEPOINT 支持嵌套。
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
    const bytes = (await this.call('export')) as Uint8Array;
    return bytes;
  }

  async importBytes(bytes: Uint8Array): Promise<void> {
    // S8 恢复用：SAHPool 可用 poolUtil.importDb 覆盖库文件，需关闭并重开连接，
    // 涉及连接生命周期管理，留待 S8（备份/恢复）依据届时选型实现。
    void bytes;
    throw new Error('importBytes 将在 S8（备份/恢复）阶段实现。');
  }
}
