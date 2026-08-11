// ============================================================
// useToast.ts —— 全局轻量提示（页面顶部弹出的小框，类 element-plus alert）
// ============================================================
// 模块级单例：不依赖 Vue 组件上下文，因此可被后台自动同步（scheduler，
// 运行在任何页面/无组件环境）直接调用 pushToast 触发提示。
// ToastHost.vue 订阅这里的 state.items 渲染并做进出场动画。
//
// 设计：
//   - 每条提示自动消失（成功偏短、失败偏长），也可点击手动关闭。
//   - 叠放上限 4 条，超出丢弃最旧一条，避免连续记账时刷屏。
// ============================================================
import { reactive } from 'vue';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const state = reactive<{ items: ToastItem[] }>({ items: [] });
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let seq = 0;

/** 叠放上限：超出丢弃最旧一条。 */
const MAX_TOASTS = 4;

function clearTimer(id: number): void {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
}

/** 移除一条提示（供 ToastHost 点击关闭 / 自动消失调用）。 */
export function dismissToast(id: number): void {
  const i = state.items.findIndex((x) => x.id === id);
  if (i >= 0) state.items.splice(i, 1);
  clearTimer(id);
}

/**
 * 推一条提示，返回其 id。durationMs 到点自动消失（默认成功 2.6s / 失败 4.5s）。
 */
export function pushToast(
  kind: ToastKind,
  message: string,
  durationMs = kind === 'error' ? 4500 : 2600,
): number {
  const id = ++seq;
  state.items.push({ id, kind, message });
  while (state.items.length > MAX_TOASTS) {
    const removed = state.items.shift();
    if (removed) clearTimer(removed.id);
  }
  const t = setTimeout(() => dismissToast(id), durationMs);
  timers.set(id, t);
  return id;
}

/** 供组件读取的响应式列表 + 操作函数。 */
export function useToast(): {
  toasts: ToastItem[];
  pushToast: typeof pushToast;
  dismissToast: typeof dismissToast;
} {
  return { toasts: state.items, pushToast, dismissToast };
}
