// ============================================================
// scheduler.ts —— 自动同步调度器（订阅变更总线 + 防抖 + 最小间隔节流）
// ============================================================
// 把"本地写库"信号（bus.emitDataChanged）转成"稍后同步一次"的动作，两道闸门叠加：
//   1. 防抖（默认 3s）：每次数据变更重置计时器，静默满窗口才考虑触发。
//      → 合并"快速连记多笔"（间隔 < 防抖窗口）为一次推送。
//   2. 最小同步间隔（默认 15s）：两次实际同步之间至少间隔这么久。
//      → 即便逐笔慢慢记（每笔间隔 > 防抖窗口），推送频率也被硬性限制，
//        从源头避免 GitHub 对同一文件高频提交触发的限流/409 抖动。
//   - syncNow 内部有并发合流：即便计时器与启动同步撞上也只跑一轮。
//   - 同步失败静默吞掉（记账离线可用，不能因网络问题打断用户）。
//
// 生命周期：main.ts 在启动同步完成后调用 startAutoSync() 挂上订阅；
// 返回 stop() 用于热更新/测试清理。默认单例只启一次（幂等）。
// ============================================================

import { onDataChanged } from './bus';
import { syncNow } from './index';

/** 防抖窗口：最后一次写库后静默这么久才考虑推送。 */
export const AUTO_SYNC_DEBOUNCE_MS = 3000;

/** 最小同步间隔：两次实际推送之间至少间隔这么久（在防抖之上再节流）。 */
export const MIN_SYNC_INTERVAL_MS = 15_000;

export interface AutoSyncHandle {
  /** 停止：取消订阅并清掉未触发的计时器。 */
  stop(): void;
  /** 立即触发（跳过防抖与最小间隔等待），用于"手动同步"按钮或测试。 */
  flush(): void;
}

export interface AutoSyncOptions {
  /** 防抖毫秒，默认 AUTO_SYNC_DEBOUNCE_MS。 */
  debounceMs?: number;
  /** 最小同步间隔毫秒，默认 MIN_SYNC_INTERVAL_MS；设 0 关闭节流（仅防抖）。 */
  minIntervalMs?: number;
  /** 触发时执行的同步动作（默认 syncNow）。测试可注入桩。 */
  trigger?: () => Promise<unknown>;
  /**
   * 每次自动同步跑完后回调（拿到 trigger 的解析值，通常是 SyncResult）。
   * 供 main.ts 把结果转成页面顶部提示。回调内自身抛错会被吞掉，不影响同步。
   */
  onResult?: (result: unknown) => void;
  /** trigger 抛错 / rejected 时回调（供提示"同步失败"）。回调抛错同样被吞。 */
  onError?: (err: unknown) => void;
  /** 当前时刻取值（默认 Date.now）。测试注入以获得确定性节流。 */
  now?: () => number;
}

let singleton: AutoSyncHandle | null = null;

/**
 * 启动自动同步（订阅变更总线 + 防抖推送）。幂等：重复调用返回同一 handle。
 * 应在启动同步跑完之后调用，避免"启动拉取"与"首个防抖推送"抢跑。
 */
export function startAutoSync(opts: AutoSyncOptions = {}): AutoSyncHandle {
  if (singleton) return singleton;
  singleton = createAutoSync(opts);
  return singleton;
}

/** 停止并清空单例（热更新/测试用）。 */
export function stopAutoSync(): void {
  if (singleton) {
    singleton.stop();
    singleton = null;
  }
}

/** 创建一个独立的自动同步实例（不走单例，供测试直接控制）。 */
export function createAutoSync(opts: AutoSyncOptions = {}): AutoSyncHandle {
  const debounceMs = opts.debounceMs ?? AUTO_SYNC_DEBOUNCE_MS;
  const minIntervalMs = opts.minIntervalMs ?? MIN_SYNC_INTERVAL_MS;
  const trigger = opts.trigger ?? syncNow;
  const onResult = opts.onResult;
  const onError = opts.onError;
  const now = opts.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 上次实际触发同步的时刻（epoch ms）；-Infinity 表示尚未同步过。 */
  let lastRunAt = -Infinity;

  const runTrigger = (): void => {
    lastRunAt = now();
    // 同步调用 trigger；无论它同步抛错还是返回 rejected Promise 都吞掉
    // （离线记账不受同步失败影响）。有 onResult/onError 时把结果透出去做提示，
    // 但回调自身抛错也一并吞掉，绝不反过来打断同步。
    const notifyResult = (r: unknown): void => {
      if (!onResult) return;
      try {
        onResult(r);
      } catch {
        /* swallow：提示回调出错不影响同步 */
      }
    };
    const notifyError = (e: unknown): void => {
      if (!onError) return;
      try {
        onError(e);
      } catch {
        /* swallow */
      }
    };
    try {
      const p = trigger();
      if (p && typeof (p as Promise<unknown>).then === 'function') {
        (p as Promise<unknown>).then(notifyResult, notifyError);
      } else {
        notifyResult(p);
      }
    } catch (e) {
      // trigger 同步抛错也不冒泡，转成 onError 提示。
      notifyError(e);
    }
  };

  // 防抖窗口到点：若距上次同步已满最小间隔则立即跑，否则把触发再推迟到冷却结束。
  const onDebounceElapsed = (): void => {
    const waited = now() - lastRunAt;
    if (waited >= minIntervalMs) {
      timer = null;
      runTrigger();
    } else {
      // 冷却未满：重排一个"剩余冷却时长"的计时器，到点再判定（其间若有新变更会再被重置）。
      const remaining = minIntervalMs - waited;
      timer = setTimeout(onDebounceElapsed, remaining);
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onDebounceElapsed, debounceMs);
  };

  const unsubscribe = onDataChanged(schedule);

  return {
    stop() {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      runTrigger();
    },
  };
}
