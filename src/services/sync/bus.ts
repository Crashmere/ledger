// ============================================================
// bus.ts —— 本地数据变更事件总线（L2 自动推送触发器的信号源）
// ============================================================
// 纯内存的极简发布/订阅：service 层每次成功写库（create/update/remove/
// reorder/导入/恢复）后调用 emitDataChanged()，同步调度器订阅它来安排
// 防抖推送。没有 Vue/DOM 依赖，可脱离 UI 单测。
//
// 设计要点：
//   - 只广播"发生了写"，不携带具体 diff —— 同步走整库快照合并，无需字段级信息。
//   - 订阅返回取消函数，避免测试/热更新泄漏监听器。
//   - emit 内对回调做 try/catch 隔离：一个订阅者抛错不影响其它订阅者，也绝不
//     反向影响触发写操作的业务流程（同步失败不能拖累记账本身）。
// ============================================================

type Listener = () => void;

const listeners = new Set<Listener>();

/** 订阅"本地数据已变更"。返回取消订阅函数。 */
export function onDataChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 广播一次"本地数据已变更"。service 写库成功后调用。 */
export function emitDataChanged(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // 订阅者（同步调度）内部异常绝不冒泡回业务写路径。
    }
  }
}

/** 清空所有订阅者（仅测试用，避免用例间串扰）。 */
export function _resetListeners(): void {
  listeners.clear();
}
