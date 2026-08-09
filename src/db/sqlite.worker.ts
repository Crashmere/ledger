// ============================================================
// sqlite.worker.ts —— 承载 SQLite（OPFS-SAHPool VFS）的专用 Worker
// ============================================================
// 为什么放 Worker（S6 §四.1 方案 B）：
//   SAHPool 依赖 FileSystemFileHandle.createSyncAccessHandle()，该 API 在多数浏览器
//   **只在 Worker 线程可用**（主线程会报 "Missing required OPFS APIs"）。
//   与旧的标准 OPFS VFS 不同，SAHPool **不依赖 Atomics.wait / SharedArrayBuffer**，
//   因此即便跑在 Worker 里也**无需页面跨源隔离（COOP/COEP）**——这正是本阶段的目的。
//
// 协议：主线程发 { id, method, sql?, params? }，Worker 回
//   成功 { id, ok:true, result } / 失败 { id, ok:false, error:{message,name} }。
//   oo1 exec 为同步 API，每条消息在 onmessage 内同步跑完，天然串行，
//   保证 BEGIN/COMMIT/SAVEPOINT 顺序（主线程逐条 await）。
// ============================================================

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type PoolUtil = Awaited<ReturnType<Sqlite3['installOpfsSAHPoolVfs']>>;
type PoolDb = InstanceType<PoolUtil['OpfsSAHPoolDb']>;
type BindValue = string | number | bigint | boolean | null | undefined | Uint8Array;

interface ReqMessage {
  id: number;
  method: 'init' | 'exec' | 'export';
  sql?: string;
  params?: unknown[];
}

const DB_PATH = '/ivy-wallet.sqlite3';
const POOL_NAME = 'ivy-wallet-sahpool';

let sqlite3: Sqlite3 | null = null;
let db: PoolDb | null = null;
let initPromise: Promise<void> | null = null;

async function doInit(): Promise<void> {
  if (db) return;
  const s3 = await sqlite3InitModule();
  // 安装 SAHPool VFS（不依赖 COOP/COEP）。首次会预分配一批 SyncAccessHandle，略慢属正常。
  const poolUtil = await s3.installOpfsSAHPoolVfs({ name: POOL_NAME });
  sqlite3 = s3;
  db = new poolUtil.OpfsSAHPoolDb(DB_PATH);
  // 建立连接后立即开外键，否则 RESTRICT/SET NULL/CASCADE 全部失效。
  db.exec({ sql: 'PRAGMA foreign_keys = ON;' });
}

/** 单次初始化（幂等）。 */
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

/** 执行一条/多条 SQL，返回对象行数组（键顺序 = SELECT 列顺序）。 */
function execRows(sql: string, params: unknown[]): Record<string, unknown>[] {
  if (!db) throw new Error('SQLite worker 尚未初始化。');
  const rows = db.exec({
    sql,
    bind: params.length ? (params as BindValue[]) : undefined,
    rowMode: 'object',
    returnValue: 'resultRows',
  });
  return rows as Record<string, unknown>[];
}

function exportBytes(): Uint8Array {
  if (!db || !sqlite3) throw new Error('SQLite worker 尚未初始化。');
  return sqlite3.capi.sqlite3_js_db_export(db);
}

self.onmessage = async (ev: MessageEvent<ReqMessage>) => {
  const { id, method, sql, params } = ev.data;
  try {
    if (method === 'init') {
      await ensureInit();
      self.postMessage({ id, ok: true, result: null });
      return;
    }
    // exec / export 之前确保已初始化（防止竞态）。
    await ensureInit();
    if (method === 'exec') {
      const result = execRows(sql ?? '', params ?? []);
      self.postMessage({ id, ok: true, result });
      return;
    }
    if (method === 'export') {
      const bytes = exportBytes();
      self.postMessage({ id, ok: true, result: bytes });
      return;
    }
    throw new Error(`未知方法：${String(method)}`);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    self.postMessage({ id, ok: false, error: { message: err.message, name: err.name } });
  }
};
