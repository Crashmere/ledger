<script setup lang="ts">
// ============================================================
// ToastHost.vue —— 全局提示宿主（页面顶部居中弹出，类 element-plus alert）
// ============================================================
// 挂在 App.vue 根部一次即可。订阅 useToast 的响应式列表，
// 用 <TransitionGroup> 做上滑淡入/淡出，点击 × 手动关闭。
// z-index 高于页面内 modal（Settings 弹层约 40~60），确保提示不被遮住。
// ============================================================
import { useToast, type ToastKind } from '../composables/useToast';

const { toasts, dismissToast } = useToast();

const iconPath: Record<ToastKind, string> = {
  success: 'M20 6 9 17l-5-5',
  error: 'M12 8v5M12 16.5v.5M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 8v.5M12 11v5',
};
</script>

<template>
  <TransitionGroup tag="div" name="toast" class="toast-host" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" role="status">
      <svg class="toast-ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4">
        <circle v-if="t.kind !== 'success'" cx="12" cy="12" r="9" />
        <path :d="iconPath[t.kind]" />
      </svg>
      <span class="toast-msg">{{ t.message }}</span>
      <button class="toast-x" aria-label="关闭" @click="dismissToast(t.id)">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200; /* 高于页面内 modal（~40-60）与手机底栏（~40） */
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  pointer-events: none; /* 容器不挡点击，仅单条 toast 可交互 */
  width: max-content;
  max-width: min(92vw, 460px);
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-radius: var(--r-md);
  font-size: 13px;
  line-height: 1.4;
  box-shadow: var(--sh-2);
  border: 1px solid transparent;
  min-width: 220px;
  max-width: 100%;
}
.toast.success {
  background: var(--income-soft);
  color: var(--income);
  border-color: color-mix(in srgb, var(--income) 24%, transparent);
}
.toast.error {
  background: var(--expense-soft);
  color: var(--expense);
  border-color: color-mix(in srgb, var(--expense) 24%, transparent);
}
.toast.info {
  background: var(--primary-soft);
  color: var(--primary-strong);
  border-color: color-mix(in srgb, var(--primary) 24%, transparent);
}
.toast-ic {
  flex-shrink: 0;
}
.toast-msg {
  flex: 1;
  font-weight: 500;
}
.toast-x {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--r-sm);
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  background: transparent;
  border: none;
}
.toast-x:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 12%, transparent);
}

/* 进出场：上滑 + 淡入淡出。 */
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
/* 让被移除项从流中脱离，剩余项平滑上移。 */
.toast-leave-active {
  position: absolute;
}
</style>
