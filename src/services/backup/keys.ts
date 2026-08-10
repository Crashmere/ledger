// ============================================================
// keys.ts —— 云备份配置的 setting key 常量与默认值
// ============================================================
// 权威来源：S8 任务书 §3.1。这一整组 `sync.github.*` 是「本机配置」：
//   - 绝不写进快照 JSON（导出时过滤，见 snapshot.ts）；
//   - 恢复时不被覆盖（setting 只逐条 UPSERT，且快照本就不含这组 key）。
// 集中定义，避免各处硬编码字符串漂移。
// ============================================================

/** 云备份配置在 setting 表里的 key（固定命名）。 */
export const SYNC_KEYS = {
  owner: 'sync.github.owner',
  repo: 'sync.github.repo',
  branch: 'sync.github.branch',
  path: 'sync.github.path',
  token: 'sync.github.token',
  lastBackupAt: 'sync.github.lastBackupAt',
  /** 上次 L2 自动同步（拉取+合并+推送）成功时间 epoch ms。 */
  lastSyncAt: 'sync.github.lastSyncAt',
} as const;

/**
 * 「本机配置」key 前缀。导出快照时凡以此开头的 setting 一律剔除，
 * 恢复时快照里也不含它们 —— 本机 GitHub 配置/Token 天然保全。
 */
export const SYNC_KEY_PREFIX = 'sync.github.';

/** 判断一个 setting key 是否属于「本机配置」（不进快照）。 */
export function isSyncKey(key: string): boolean {
  return key.startsWith(SYNC_KEY_PREFIX);
}

/** 配置默认值。path 用 `ivy-wallet-snapshot.json`，避免与旧 Ivy 的 backup 撞名。 */
export const SYNC_DEFAULTS = {
  branch: 'main',
  path: 'ivy-wallet-snapshot.json',
} as const;
