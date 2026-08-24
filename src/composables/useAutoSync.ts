// ============================================================
// useAutoSync.ts —— 自动同步开关（侧栏「自动同步」开关的共享状态）
// ============================================================
// 一个纯本地的 UI 便利开关：连续慢慢录入多笔时可临时关闭后台自动推送，
// 录完再打开一次性补推，避免 GitHub 对同一文件高频提交触发限流/409。
//
// 设计：
//   - 状态是模块级 ref，App.vue 的开关读写它；持久化到 localStorage
//     （纯本地 UI 偏好，不入库、不进云备份，语义同 Search 的最近搜索）。
//   - main.ts 启动调度器后 registerAutoSyncHandle 把 handle 登记进来，
//     使开关能真正驱动 scheduler.setEnabled；未登记时开关只改本地状态（幂等）。
//   - 默认开启：绝大多数时候用户希望自动同步照常工作。
// ============================================================
import { readonly, ref } from 'vue';

/** localStorage key：纯本地 UI 偏好，不入库/不进云备份。 */
const STORAGE_KEY = 'sync:auto-enabled';

/** 读取持久化的启用状态；缺省或异常一律按「开」（最常见期望）。 */
function loadEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw !== '0';
  } catch {
    return true; // 隐私模式等 localStorage 不可用：默认开
  }
}

const enabled = ref(loadEnabled());

/** 调度器句柄（由 main.ts 登记）；只用它的 setEnabled 接口。 */
let handle: { setEnabled(on: boolean): void } | null = null;

/**
 * 登记调度器 handle（main.ts 在 startAutoSync 之后调用）。
 * 登记时立即把持久化的初始状态应用到调度器，保证刷新后仍是上次的选择。
 */
export function registerAutoSyncHandle(h: { setEnabled(on: boolean): void }): void {
  handle = h;
  handle.setEnabled(enabled.value);
}

/** 读取初始启用状态（供 main.ts 传给 startAutoSync 的 enabled 选项）。 */
export function initialAutoSyncEnabled(): boolean {
  return enabled.value;
}

/** 设置开关：更新响应式状态 + 持久化 + 驱动调度器。 */
export function setAutoSyncEnabled(on: boolean): void {
  enabled.value = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // localStorage 不可用（隐私模式等）→ 本次会话内仍生效，只是不持久化。
  }
  handle?.setEnabled(on);
}

/** 组件里用：拿到只读状态与切换函数。 */
export function useAutoSync(): {
  enabled: Readonly<typeof enabled>;
  setEnabled: (on: boolean) => void;
  toggle: () => void;
} {
  return {
    enabled: readonly(enabled) as Readonly<typeof enabled>,
    setEnabled: setAutoSyncEnabled,
    toggle: () => setAutoSyncEnabled(!enabled.value),
  };
}
