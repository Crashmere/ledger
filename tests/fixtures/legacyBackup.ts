// ============================================================
// tests/fixtures/legacyBackup.ts —— 真实旧应用备份夹具加载器
// ============================================================
// import.test.ts / backup.test.ts 依赖一份真实的旧 Ivy Wallet 备份 JSON
// （4 账户 / 16 分类 / 数百笔交易）来做端到端映射与往返校验。
//
// 该 JSON 含个人财务数据，公开仓库不跟踪：文件放在 tests/fixtures/legacy-backup.json
// 并被 .gitignore 忽略。因此在新克隆 / CI（CI 只跑 build，不跑 test）上文件可能缺失。
//
// 约定：本模块在文件缺失时返回 null，测试据此 describe.skip，
//       而不是在导入期 readFileSync 抛 ENOENT 直接崩掉整个测试文件。
// 需要跑这两个套件时，把旧应用导出的备份 JSON 放到上述路径即可。
// ============================================================
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LegacyBackup } from '../../src/services/import/legacyBackup';

const FIXTURE_PATH = fileURLToPath(new URL('./legacy-backup.json', import.meta.url));

/** 读取真实备份夹具；文件不存在时返回 null（供测试跳过，而非崩溃）。 */
export function loadLegacyBackup(): LegacyBackup | null {
  if (!existsSync(FIXTURE_PATH)) return null;
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as LegacyBackup;
}
