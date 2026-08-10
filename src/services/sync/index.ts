// ============================================================
// index.ts —— L2 无损同步编排（拉取 → 合并 → 落本地 → 乐观锁推送）
// ============================================================
// 把 github（GET/PUT+乐观锁）+ snapshot（导出/宽松校验/恢复）+ merge（记录级
// 合并）编排成"一次安全同步"。启动时阻塞式跑一遍、写库后防抖推送都调它。
//
// 单轮流程（syncNow）：
//   1. 无 token / 未配置仓库 → skipped（记账仍可离线用）。
//   2. GET 远端文件：
//      · 404（远端还没有备份）→ 首次创建：导出本地 → PUT(expectedSha=null)。
//      · 200 → 宽松解析（容忍 v1 远端）：
//          - 解析失败 → error，绝不覆盖远端、绝不动本地（防脏数据互毁）。
//          - 成功 → merge(本地, 远端) 得合并快照：
//              a. restore 合并快照到本地（吸收远端新增/删除，事务内整体替换）。
//              b. 若合并结果与远端**数据等价**（忽略行序/时间戳/v1 形状）→
//                 本地本无新东西，跳过 PUT（只拉不推，避免每次启动都产生无谓 commit）。
//              c. 否则 PUT(expectedSha=远端 sha)：
//                   · 成功 → pushed。
//                   · 409（远端在我们合并期间又被别的设备改了）→ 整轮重试
//                     （重新 GET→merge→restore→PUT），最多 MAX_RETRIES 次。
//   3. 成功后记 lastSyncAt。
//
// 并发合流：同一时刻只跑一轮 syncNow；重复调用返回同一 in-flight Promise。
// 安全红线：token 只经 github 层请求头传递；任何返回/日志都不含 token。
// ============================================================

import type { SqliteAdapter } from '../../db/adapter';
import { getAdapter } from '../../db/client';
import { SettingServiceImpl } from '../setting';
import { getRemoteFile, putRemoteFile, GithubError, type GithubConfig } from '../backup/github';
import {
  exportSnapshot,
  serializeSnapshot,
  restoreSnapshot,
  parseSnapshotLenient,
} from '../backup/snapshot';
import { loadConfig } from '../backup/index';
import { mergeSnapshots, snapshotDataEquals, type MergeReport } from './merge';
import { SYNC_KEYS } from '../backup/keys';

/** 单轮同步中，乐观锁 409 冲突后的最大整轮重试次数。 */
const MAX_RETRIES = 4;

export type SyncStatus =
  | 'created' // 远端原本无文件，本次首创
  | 'pushed' // 合并后有本地新增，已推送
  | 'up-to-date' // 合并结果与远端一致，只吸收了远端变化（或本就无变化），未推送
  | 'skipped' // 未配置 token / 仓库，跳过
  | 'error'; // 失败（message 面向用户，不含 token）

export interface SyncResult {
  status: SyncStatus;
  /** 本轮合并报告（created/pushed/up-to-date 时有）。 */
  report?: MergeReport;
  /** 成功同步时间 epoch ms（created/pushed/up-to-date 时有）。 */
  at?: number;
  /** skipped 的原因 / error 的用户可读信息。 */
  message?: string;
  /** 本轮为解决 409 冲突而重试的次数（0 表示一次成功）。 */
  retries?: number;
}

export interface SyncOptions {
  /** 目标库 adapter（默认默认库）。测试传独立测试库。 */
  adapter?: SqliteAdapter;
  /** GitHub 配置（默认 loadConfig()）。测试直接传，避免依赖 setting 单例库。 */
  config?: GithubConfig;
}

// 并发合流：同一时刻只允许一轮同步。
let inFlight: Promise<SyncResult> | null = null;

/**
 * 执行一次 L2 无损同步。并发调用会合流到同一 in-flight Promise，
 * 避免"启动同步 + 刚记的一笔触发的推送"两路并跑互相 409。
 */
export function syncNow(opts: SyncOptions = {}): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 是否已配置可同步（有 token 且有 owner/repo）。 */
function isConfigured(cfg: GithubConfig): boolean {
  return !!(cfg.token && cfg.token.trim() && cfg.owner && cfg.repo);
}

async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const adapter = opts.adapter ?? getAdapter();
  const cfg = opts.config ?? (await loadConfig());

  if (!isConfigured(cfg)) {
    return { status: 'skipped', message: '未配置同步（缺少 Token 或仓库信息）。' };
  }

  const settings = new SettingServiceImpl(adapter);

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const remote = await getRemoteFile(cfg);

      // —— 情况 A：远端还没有备份文件 → 首次创建 ——
      if (!remote) {
        const localSnap = await exportSnapshot(adapter);
        const text = serializeSnapshot(localSnap);
        try {
          await putRemoteFile(cfg, text, commitMessage(localSnap.exportedAt), {
            expectedSha: null, // 显式声明"远端应无此文件"
          });
        } catch (e) {
          // 竞态：刚才 GET 得 404，PUT 时别的设备已创建 → 409/422，整轮重试。
          if (isConflict(e)) continue;
          throw e;
        }
        const at = await stampSyncAt(settings);
        return { status: 'created', at, retries: attempt };
      }

      // —— 情况 B：远端已有文件 → 宽松解析并合并 ——
      const parsed = parseSnapshotLenient(remote.content);
      if (!parsed.ok || !parsed.snapshot) {
        // 远端文件损坏/非本应用：绝不覆盖、绝不动本地，交由用户处理。
        return { status: 'error', message: `远端备份无法解析：${parsed.error ?? '未知格式'}` };
      }

      const localSnap = await exportSnapshot(adapter);
      const { merged, report } = mergeSnapshots(localSnap, parsed.snapshot);

      // a. 合并结果落本地（吸收远端新增/删除；事务内整体替换，失败回滚）。
      await restoreSnapshot(adapter, merged);

      // b. 合并结果与远端"数据等价"（忽略行序/时间戳）→ 本地无新东西，只拉不推。
      //    不能按 JSON 逐字节比：merge 会重排行、盖新 exportedAt，且远端可能是 v1 形状。
      if (snapshotDataEquals(merged, parsed.snapshot)) {
        const at = await stampSyncAt(settings);
        return { status: 'up-to-date', report, at, retries: attempt };
      }

      // c. 有本地新增 → 带远端 sha 乐观锁推送。
      const mergedText = serializeSnapshot(merged);
      try {
        await putRemoteFile(cfg, mergedText, commitMessage(merged.exportedAt), {
          expectedSha: remote.sha,
        });
      } catch (e) {
        if (isConflict(e)) continue; // 远端又变了 → 整轮重试
        throw e;
      }
      const at = await stampSyncAt(settings);
      return { status: 'pushed', report, at, retries: attempt };
    }

    // 连续 409：远端被高频改动，本轮放弃（下次触发再来）。
    return { status: 'error', message: '远端变化过于频繁，本次同步未完成，请稍后重试。' };
  } catch (e) {
    const message = e instanceof GithubError ? e.message : '同步失败，请稍后重试。';
    return { status: 'error', message };
  }
}

/** 记 lastSyncAt 并返回该时间戳。 */
async function stampSyncAt(settings: SettingServiceImpl): Promise<number> {
  const at = Date.now();
  await settings.set(SYNC_KEYS.lastSyncAt, String(at));
  return at;
}

/** 提交信息只含时间戳，绝不含 token 或敏感信息。 */
function commitMessage(exportedAt: number): string {
  return `sync: ivy-wallet snapshot ${new Date(exportedAt).toISOString()}`;
}

/** GitHub 乐观锁冲突：409（sha 不符）或 422（并发创建）。 */
function isConflict(e: unknown): boolean {
  return e instanceof GithubError && (e.status === 409 || e.status === 422);
}

/** 上次自动同步成功时间（epoch ms），无则 null。 */
export async function getLastSyncAt(
  adapter: SqliteAdapter = getAdapter(),
): Promise<number | null> {
  const settings = new SettingServiceImpl(adapter);
  const v = await settings.get(SYNC_KEYS.lastSyncAt);
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 启动同步：阻塞式跑一轮 syncNow，但设**上限**（默认 10s）——若网络迟迟不返回，
 * 到点就先放行 App 挂载，同步在后台继续跑完（不丢，只是不再挡首屏）。
 * 这样既满足"同步完再开"的常规体验，又避免死网把启动卡死。
 * 任何错误都被吞掉（记账离线可用），返回是否在时限内完成。
 */
export async function runStartupSync(timeoutMs = 10_000): Promise<boolean> {
  let done = false;
  const task = syncNow()
    .then(() => {
      done = true;
    })
    .catch(() => {
      done = true; // 失败也算"跑过了"，不阻塞
    });

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([task, timeout]);
  return done;
}
