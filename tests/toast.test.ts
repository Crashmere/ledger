// ============================================================
// toast.test.ts —— 全局提示 useToast 的行为（纯逻辑，无 DOM 依赖）
// ============================================================
// 验证：推入返回 id、到点自动消失、手动 dismiss、叠放上限丢弃最旧、
// 失败默认停留更久。用假计时器精确控制自动消失窗口。
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushToast, dismissToast, useToast } from '../src/composables/useToast';

/** 每例开始把残留提示清干净（模块级单例，跨用例会串）。 */
function clearAll(): void {
  const { toasts } = useToast();
  for (const t of [...toasts]) dismissToast(t.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  clearAll();
});

afterEach(() => {
  clearAll();
  vi.useRealTimers();
});

describe('useToast 全局提示', () => {
  it('推入后出现在列表，到点自动消失', () => {
    const { toasts } = useToast();
    const id = pushToast('success', '同步成功');
    expect(toasts.map((t) => t.message)).toContain('同步成功');
    expect(id).toBeGreaterThan(0);

    vi.advanceTimersByTime(2600); // 成功默认 2.6s
    expect(toasts.find((t) => t.id === id)).toBeUndefined();
  });

  it('失败提示停留更久（4.5s）', () => {
    const { toasts } = useToast();
    const id = pushToast('error', '同步失败');

    vi.advanceTimersByTime(2600);
    expect(toasts.find((t) => t.id === id)).toBeDefined(); // 2.6s 时仍在

    vi.advanceTimersByTime(4500 - 2600);
    expect(toasts.find((t) => t.id === id)).toBeUndefined(); // 4.5s 后消失
  });

  it('可手动关闭（并清掉其自动消失计时器）', () => {
    const { toasts } = useToast();
    const id = pushToast('info', '提示');
    dismissToast(id);
    expect(toasts.find((t) => t.id === id)).toBeUndefined();
    // 计时器已清：推进时间不应报错、也不影响其它。
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
  });

  it('叠放超过上限时丢弃最旧一条（保留最近 4 条）', () => {
    const { toasts } = useToast();
    const ids = [1, 2, 3, 4, 5].map((n) => pushToast('info', `第${n}条`));
    expect(toasts.length).toBe(4);
    // 第 1 条（最旧）被挤掉，第 2~5 条保留。
    expect(toasts.find((t) => t.id === ids[0])).toBeUndefined();
    expect(toasts.map((t) => t.message)).toEqual(['第2条', '第3条', '第4条', '第5条']);
  });

  it('自定义 durationMs 生效', () => {
    const { toasts } = useToast();
    const id = pushToast('info', '短提示', 500);
    vi.advanceTimersByTime(499);
    expect(toasts.find((t) => t.id === id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(toasts.find((t) => t.id === id)).toBeUndefined();
  });
});
