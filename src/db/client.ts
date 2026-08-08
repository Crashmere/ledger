// ============================================================
// client.ts —— 已初始化好的 drizzle 客户端（挂在选定 adapter 上）
// ============================================================
// 权威来源：S0 任务书 §四.2、06-接口契约.ts。
// 职责：
//   - 选定平台 adapter（S0 = Web/OPFS；S12 会加 Tauri，届时只改这里的选择逻辑）。
//   - init() adapter + 跑迁移到最新（user_version 0 -> 1）。
//   - 用 drizzle-orm/sqlite-proxy 把 drizzle 查询转发到 adapter。
// 上层 Service 只 import 这里的 db / getAdapter()，不直接 import 任何 sqlite 驱动。
// ============================================================

import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { SqliteAdapter } from './adapter';
import { WebSqliteAdapter } from './adapter.web';
import { migrator } from './migrations';
import * as schema from './schema';

/** 选定当前平台的 adapter。S0 仅 Web；桌面端在 S12 接入。 */
function selectAdapter(): SqliteAdapter {
  return new WebSqliteAdapter();
}

const adapter: SqliteAdapter = selectAdapter();

let initialized: Promise<void> | null = null;

/** 初始化底层数据库并迁移到最新（幂等：多次调用只跑一次）。 */
export function initDb(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      await adapter.init();
      await migrator.migrateToLatest(adapter);
    })();
  }
  return initialized;
}

/** 供需要裸 SQL 的场景（迁移、导入导出、统计）直接拿 adapter。 */
export function getAdapter(): SqliteAdapter {
  return adapter;
}

/**
 * drizzle 客户端（异步 proxy 驱动）。
 * sqlite-proxy 约定回调按位置返回列值数组：
 *   - 'all' / 'values' -> { rows: 行数组[] }
 *   - 'get'            -> { rows: 单行列值数组 }（无行则空数组）
 *   - 'run'            -> { rows: [] }
 * adapter.all 返回对象行，这里用列顺序转成数组。drizzle 生成的 SELECT 列顺序稳定，
 * 与对象键顺序一致；未来若出现同名列的多表 join，需在此改走数组行模式。
 */
export const db = drizzle(
  async (sql, params, method) => {
    if (method === 'run') {
      await adapter.run(sql, params);
      return { rows: [] };
    }

    const objectRows = await adapter.all(sql, params);
    const arrayRows = objectRows.map((row) => Object.values(row));

    if (method === 'get') {
      return { rows: arrayRows.length > 0 ? arrayRows[0] : [] };
    }
    // 'all' | 'values'
    return { rows: arrayRows };
  },
  { schema },
);
