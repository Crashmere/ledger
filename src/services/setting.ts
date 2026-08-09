// ============================================================
// setting.ts —— SettingService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts SettingService、S1 任务书 §四.6。
//   - 读写 setting 键值表（key 主键、value 可空）。
//   - set 用 UPSERT（存在则覆盖）。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { SettingService } from './contract';

export class SettingServiceImpl implements SettingService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async get(key: string): Promise<string | null> {
    const row = await this.adapter.get<{ value: string | null }>(
      `SELECT value FROM setting WHERE key = ?`,
      [key],
    );
    return row ? (row.value ?? null) : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.adapter.run(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async remove(key: string): Promise<void> {
    await this.adapter.run(`DELETE FROM setting WHERE key = ?`, [key]);
  }

  async all(): Promise<Record<string, string>> {
    const rows = await this.adapter.all<{ key: string; value: string | null }>(
      `SELECT key, value FROM setting`,
    );
    const out: Record<string, string> = {};
    for (const r of rows) {
      out[r.key] = r.value ?? '';
    }
    return out;
  }
}
