// ============================================================
// sync-scheduler.test.ts —— 自动同步调度器（防抖 + 变更总线）
// ============================================================
// 验证：多次写库变更只在最后一次后防抖窗口结束时触发一次同步；
// stop() 后不再触发；flush() 立即触发；订阅者异常不冒泡。
// 用 vitest 假计时器精确控制防抖窗口，不依赖真实等待。
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitDataChanged, _resetListeners } from '../src/services/sync/bus';
import { createAutoSync } from '../src/services/sync/scheduler';

beforeEach(() => {
  vi.useFakeTimers();
  _resetListeners();
});

afterEach(() => {
  vi.useRealTimers();
  _resetListeners();
});

describe('自动同步调度器', () => {
  it('连续多次变更 → 防抖窗口内只触发一次', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSync({ debounceMs: 3000, trigger });

    emitDataChanged();
    vi.advanceTimersByTime(1000);
    emitDataChanged(); // 重置计时器
    vi.advanceTimersByTime(1000);
    emitDataChanged(); // 再次重置
    expect(trigger).not.toHaveBeenCalled(); // 还没静默满 3s

    vi.advanceTimersByTime(3000); // 最后一次后静默满
    expect(trigger).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('两批变更（各自静默满窗口）→ 触发两次', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSync({ debounceMs: 3000, trigger });

    emitDataChanged();
    vi.advanceTimersByTime(3000);
    expect(trigger).toHaveBeenCalledTimes(1);

    emitDataChanged();
    vi.advanceTimersByTime(3000);
    expect(trigger).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('stop() 后变更不再触发', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSync({ debounceMs: 3000, trigger });

    handle.stop();
    emitDataChanged();
    vi.advanceTimersByTime(5000);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('flush() 立即触发（跳过防抖等待）', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSync({ debounceMs: 3000, trigger });

    emitDataChanged();
    handle.flush(); // 不等 3s
    expect(trigger).toHaveBeenCalledTimes(1);

    // flush 已清计时器，原本的防抖到点不应再触发。
    vi.advanceTimersByTime(3000);
    expect(trigger).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('trigger 抛错不冒泡（离线记账不受影响）', async () => {
    const trigger = vi.fn().mockRejectedValue(new Error('network down'));
    const handle = createAutoSync({ debounceMs: 1000, trigger });

    emitDataChanged();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(trigger).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});
