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

  it('两批变更（各自静默满窗口，无最小间隔节流）→ 触发两次', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    // minIntervalMs: 0 关闭节流，只验证纯防抖：两批各自静默满窗口 → 两次。
    const handle = createAutoSync({ debounceMs: 3000, minIntervalMs: 0, trigger });

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

  it('onResult 拿到同步结果（供页面顶部提示）', async () => {
    const trigger = vi.fn().mockResolvedValue({ status: 'pushed' });
    const onResult = vi.fn();
    const handle = createAutoSync({ debounceMs: 1000, trigger, onResult });

    emitDataChanged();
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync(); // 冲掉 trigger 的 resolved 微任务

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ status: 'pushed' });
    handle.stop();
  });

  it('trigger 失败时走 onError，且回调抛错不冒泡', async () => {
    const trigger = vi.fn().mockRejectedValue(new Error('boom'));
    const onError = vi.fn(() => {
      throw new Error('提示回调自身也炸了'); // 必须被吞
    });
    const handle = createAutoSync({ debounceMs: 1000, trigger, onError });

    emitDataChanged();
    vi.advanceTimersByTime(1000);
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();

    expect(onError).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});

describe('自动同步调度器 · 最小同步间隔节流', () => {
  it('逐笔慢记（间隔 > 防抖但 < 最小间隔）→ 被节流合并，而非每笔一次', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    // 防抖 3s、最小间隔 15s：模拟每 5s 记一笔的"慢速逐笔录入"。
    const handle = createAutoSync({ debounceMs: 3000, minIntervalMs: 15000, trigger });

    // 第 1 笔：t=0 变更，t=3s 防抖到点，距上次同步(-∞)已满 → 立即触发第 1 次。
    emitDataChanged();
    vi.advanceTimersByTime(3000);
    expect(trigger).toHaveBeenCalledTimes(1); // t=3s

    // 第 2 笔：t=5s 变更 → t=8s 防抖到点，但距上次同步(3s)仅 5s < 15s → 推迟。
    vi.advanceTimersByTime(2000); // t=5s
    emitDataChanged();
    vi.advanceTimersByTime(3000); // t=8s
    expect(trigger).toHaveBeenCalledTimes(1); // 仍被冷却挡住

    // 第 3 笔：t=10s 变更 → t=13s 防抖到点，冷却仍未满（距 3s 才 10s）→ 继续等。
    vi.advanceTimersByTime(2000); // t=10s
    emitDataChanged();
    vi.advanceTimersByTime(3000); // t=13s
    expect(trigger).toHaveBeenCalledTimes(1);

    // 冷却在 t=18s 结束（上次 3s + 15s），到点一次性补跑第 2 次。
    vi.advanceTimersByTime(5000); // t=18s
    expect(trigger).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('距上次同步已超过最小间隔 → 防抖到点即触发（不额外等待）', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSync({ debounceMs: 3000, minIntervalMs: 15000, trigger });

    emitDataChanged();
    vi.advanceTimersByTime(3000);
    expect(trigger).toHaveBeenCalledTimes(1); // t=3s

    // 让时间走过冷却窗口后再记：应像正常防抖一样触发。
    vi.advanceTimersByTime(20000); // t=23s，早已超过 15s 冷却
    emitDataChanged();
    vi.advanceTimersByTime(3000); // t=26s
    expect(trigger).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('flush() 无视最小间隔，立即触发', () => {
    const trigger = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSync({ debounceMs: 3000, minIntervalMs: 15000, trigger });

    emitDataChanged();
    vi.advanceTimersByTime(3000);
    expect(trigger).toHaveBeenCalledTimes(1); // t=3s

    // 冷却期内手动 flush 应立刻同步，不受最小间隔约束。
    emitDataChanged();
    handle.flush();
    expect(trigger).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
