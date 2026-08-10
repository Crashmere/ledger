// ============================================================
// index.ts —— 云备份编排层（供 Settings.vue 直接调用）
// ============================================================
// 权威来源：S8 任务书 §一、§四、§五。
// 把 snapshot（导出/校验/恢复）+ github（GET/PUT）+ setting（配置读写）
// 编排成 UI 一行就能用的动作，且把安全红线（Token 不进快照/日志/commit）收口在此。
//
// 只依赖 SqliteAdapter 接口与 SettingService（既有实现），不碰 db 层、不改签名。
// ============================================================

import type { SqliteAdapter } from '../../db/adapter';
import { getAdapter } from '../../db/client';
import { settingService } from '../index';
import {
  getRemoteFile,
  testConnection,
  withDefaults,
  type ConnectionResult,
  type GithubConfig,
} from './github';
import {
  exportSnapshot,
  parseSnapshot,
  restoreSnapshot,
  serializeSnapshot,
  snapshotCounts,
  type BackupSnapshot,
  type SnapshotCounts,
} from './snapshot';
import { SYNC_DEFAULTS, SYNC_KEYS } from './keys';
import { SYNC_REPO_DEFAULTS } from '../../config/sync-defaults';

export type { BackupSnapshot, SnapshotCounts } from './snapshot';
export type { GithubConfig, ConnectionResult, RemoteFile } from './github';
export { GithubError, utf8ToBase64, base64ToUtf8 } from './github';
export { snapshotCounts, serializeSnapshot } from './snapshot';
export { SYNC_KEYS, SYNC_DEFAULTS, isSyncKey } from './keys';

// ------------------------------------------------------------
// 配置读写（sync.github.*）
// ------------------------------------------------------------
/**
 * 从 setting 表读取 GitHub 配置（token 也读出，供发请求；UI 不明文回显）。
 * owner/repo/branch/path 若本机从未配置（setting 为空），回落到内置的
 * SYNC_REPO_DEFAULTS —— 新设备无需手填仓库信息，只需再输 Token。
 * 已存的用户配置优先级高于内置默认值（用户改过就以用户的为准）。
 * Token 无内置默认（安全红线：不写进代码），未配置即为空。
 */
export async function loadConfig(): Promise<GithubConfig> {
  const [owner, repo, branch, path, token] = await Promise.all([
    settingService.get(SYNC_KEYS.owner),
    settingService.get(SYNC_KEYS.repo),
    settingService.get(SYNC_KEYS.branch),
    settingService.get(SYNC_KEYS.path),
    settingService.get(SYNC_KEYS.token),
  ]);
  return withDefaults({
    owner: owner ?? SYNC_REPO_DEFAULTS.owner,
    repo: repo ?? SYNC_REPO_DEFAULTS.repo,
    branch: branch ?? SYNC_REPO_DEFAULTS.branch,
    path: path ?? SYNC_REPO_DEFAULTS.path,
    token: token ?? '',
  });
}

/** 待保存的配置字段（token 为空表示「不修改已存 token」，见 saveConfig）。 */
export interface ConfigInput {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** 留空 = 保留原有 token（避免用户不重输就清空凭据）。 */
  token?: string;
}

/**
 * 保存配置到 setting 表。
 * - owner/repo/branch/path 直接写（branch/path 空则回落默认）。
 * - token：仅当传入非空才写入；留空表示保留原值（不清空已配置的凭据）。
 */
export async function saveConfig(input: ConfigInput): Promise<void> {
  await settingService.set(SYNC_KEYS.owner, input.owner.trim());
  await settingService.set(SYNC_KEYS.repo, input.repo.trim());
  await settingService.set(SYNC_KEYS.branch, input.branch.trim() || SYNC_DEFAULTS.branch);
  await settingService.set(SYNC_KEYS.path, input.path.trim() || SYNC_DEFAULTS.path);
  if (input.token && input.token.trim()) {
    await settingService.set(SYNC_KEYS.token, input.token.trim());
  }
}

/** 是否已配置 token（用于 UI 显示「已配置」状态，而非明文）。 */
export async function hasToken(): Promise<boolean> {
  const t = await settingService.get(SYNC_KEYS.token);
  return !!(t && t.trim());
}

// ------------------------------------------------------------
// 本地导出（下载文件）
// ------------------------------------------------------------
/** 生成本机快照的 JSON 文本（美化）。 */
export async function buildSnapshotText(adapter: SqliteAdapter = getAdapter()): Promise<string> {
  const snap = await exportSnapshot(adapter);
  return serializeSnapshot(snap);
}

/** 本地导出文件名：ivy-wallet-snapshot-YYYYMMDD-HHmm.json。 */
export function localFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(
    now.getHours(),
  )}${p(now.getMinutes())}`;
  return `ivy-wallet-snapshot-${stamp}.json`;
}

// ------------------------------------------------------------
// 从云端恢复：GET → 解析校验 → （UI 预览+二次确认后）→ 事务写回。
//   拆成「取快照」与「写回」两步，让 UI 能在中间插入预览与确认。
//   注：日常同步走 services/sync（拉取+记录级合并+乐观锁推送，无损）；
//   这里的"整份覆盖恢复"仅供灾难恢复（本机数据损坏时从云端重建）。
//   原先的 backupToCloud（无条件覆盖推送）已被 L2 合并同步取代并移除。
// ------------------------------------------------------------
export interface FetchSnapshotResult {
  ok: boolean;
  snapshot?: BackupSnapshot;
  counts?: SnapshotCounts;
  error?: string;
}

/** 从云端取快照并校验（不写库）。远端无文件 → 明确提示。 */
export async function fetchCloudSnapshot(
  cfg: GithubConfig,
  adapter: SqliteAdapter = getAdapter(),
): Promise<FetchSnapshotResult> {
  const file = await getRemoteFile(cfg);
  if (!file) {
    return { ok: false, error: '云端还没有备份文件。' };
  }
  const currentVersion = await adapter.getUserVersion();
  const parsed = parseSnapshot(file.content, currentVersion);
  if (!parsed.ok || !parsed.snapshot) {
    return { ok: false, error: parsed.error ?? '备份文件无法解析。' };
  }
  return { ok: true, snapshot: parsed.snapshot, counts: snapshotCounts(parsed.snapshot) };
}

/** 执行恢复（事务清空+写回）。失败整体回滚。 */
export async function restoreFromSnapshot(
  snapshot: BackupSnapshot,
  adapter: SqliteAdapter = getAdapter(),
): Promise<void> {
  await restoreSnapshot(adapter, snapshot);
}

// ------------------------------------------------------------
// 测试连接（透传，方便 UI 从一个入口引用）
// ------------------------------------------------------------
export async function testGithubConnection(cfg: GithubConfig): Promise<ConnectionResult> {
  return testConnection(cfg);
}
