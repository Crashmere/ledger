// ============================================================
// sync-defaults.ts —— 云备份仓库的「内置默认值」（个人自用，可写死）
// ============================================================
// 目的：新设备打开时不必再手填 owner/repo/branch/path 四个框，
// 只需粘贴一次 Token 即可开始备份/恢复。
//
// 安全边界（务必牢记）：
//   - 这里只放【非机密】的仓库定位信息（owner/repo/branch/path）。
//   - 【Token 绝不写进这里】。本站是公开部署（GitHub Pages + public 仓），
//     任何写进源码的常量都会被内联进公开 bundle，F12 即可读到，
//     且 GitHub Secret Scanning 会自动吊销泄露的 PAT。Token 只能由
//     用户在设置页手动输入，存本机 OPFS，永不进代码/快照/commit。
//
// 换仓库怎么办：改这里的常量 → 重新 push 部署即可（正如「改配置文件」）。
// 覆盖优先级：setting 表已存的用户配置 > 这里的默认值（见 backup/index.ts loadConfig）。
// ============================================================

/** 内置的备份仓库定位默认值（不含 Token）。 */
export const SYNC_REPO_DEFAULTS = {
  owner: 'Crashmere',
  repo: 'ivy_bak',
  branch: 'main',
  path: 'ivy-wallet-snapshot.json',
} as const;
