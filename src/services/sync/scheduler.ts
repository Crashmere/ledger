// ============================================================
// scheduler.ts —— 自动同步调度器（订阅变更总线 + 防抖推送）
// ============================================================
// 把"本地写库"信号（bus.emitDataChanged）转成"稍后同步一次"的动作：
//   - 每次数据变更 → 重置一个防抖计时器（默认 3s）；静默 3s 后触发 syncNow。
//   - 连续记多笔只会在最后一笔后 3s 触发一次，避免每笔都推、刷爆 commit。
//   - syncNow 内部有并发合流：即便计时器与启动同步撞上也只跑一轮。
//   - 同步失败静默吞掉（记账离线可用，不能因网络问题打断用户）。
//
// 生命周期：main.ts 在启动同步完成后调用 startAutoSync() 挂上订阅；
// 返回 stop() 用于热更新/测试清理。默认单例只启一次（幂等）。
// ============================================================

import { onDataChanged } from './bus';
import { syncNow } from './index';

/** 防抖窗口：最后一次写库后静默这么久才推送。 */
export const AUTO_SYNC_DEBOUNCE_MS = 3000;

export interface AutoSyncHandle {
  /** 停止：取消订阅并清掉未触发的计时器。 */
  stop(): void;
  /** 立即触发（跳过防抖等待），用于"手动同步"按钮或测试。 */
  flush(): void;
}

export interface AutoSyncOptions {
  /** 防抖毫秒，默认 AUTO_SYNC_DEBOUNCE_MS。 */
  debounceMs?: number;
  /** 触发时执行的同步动作（默认 syncNow）。测试可注入桩。 */
  trigger?: () => Promise<unknown>;
  /**
   * 每次自动同步跑完后回调（拿到 trigger 的解析值，通常是 SyncResult）。
   * 供 main.ts 把结果转成页面顶部提示。回调内自身抛错会被吞掉，不影响同步。
   */
  onResult?: (result: unknown) => void;
  /** trigger 抛错 / rejected 时回调（供提示"同步失败"）。回调抛错同样被吞。 */
  onError?: (err: unknown) => void;
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
  const trigger = opts.trigger ?? syncNow;
  const onResult = opts.onResult;
  const onError = opts.onError;

  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = (): void => {
    timer = null;
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

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
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
      fire();
    },
  };
}
