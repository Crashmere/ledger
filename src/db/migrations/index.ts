// ============================================================
// 迁移：由 PRAGMA user_version 驱动，逐版本升级。
// ============================================================
// S0：0 -> 1，执行 04-数据库schema.sql 的建表语句（镜像在 ddl_v1.ts）。
// 幂等：DDL 全部 IF NOT EXISTS，且执行前判 user_version；重复调用不重复建表。
// ============================================================

import type { Migrator, SqliteAdapter } from '../adapter';
import { SCHEMA_VERSION } from '../schema';
import { DDL_V1 } from './ddl_v1';
import { DDL_V2 } from './ddl_v2';

/** 逐条拆分 DDL 脚本为独立语句（adapter.run 一次执行一条）。 */
function splitStatements(script: string): string[] {
  return script
    .split(';')
    .map((s) =>
      // 去掉整行 SQL 注释，避免只剩注释的“空语句”。
      s
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

export const migrator: Migrator = {
  async migrateToLatest(db: SqliteAdapter): Promise<void> {
    const current = await db.getUserVersion();
    if (current >= SCHEMA_VERSION) {
      return; // 已是最新，幂等返回。
    }

    // v0 -> v1：整个建表过程放进事务，失败则整体回滚。
    if (current < 1) {
      await db.transaction(async (tx) => {
        for (const stmt of splitStatements(DDL_V1)) {
          await tx.run(stmt);
        }
      });
      await db.setUserVersion(1);
    }

    // v1 -> v2：加 updated_at / deleted_at（记录级同步基建）+ 回填 + 索引。
    // 同样整体入事务，失败回滚；ADD COLUMN / UPDATE / CREATE INDEX 均可在事务内执行。
    if (current < 2) {
      await db.transaction(async (tx) => {
        for (const stmt of splitStatements(DDL_V2)) {
          await tx.run(stmt);
        }
      });
      await db.setUserVersion(2);
    }
  },
};
