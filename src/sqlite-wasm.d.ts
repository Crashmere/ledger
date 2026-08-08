// 为 @sqlite.org/sqlite-wasm 补充本项目用到、但官方 d.ts 未覆盖的类型。
// 官方 index.d.ts 只导出默认的 init 函数，未导出 Worker1 Promiser 的具名类型。

declare module '@sqlite.org/sqlite-wasm' {
  /** Worker1 Promiser 工厂（含 v2：返回 Promise<promiser>）。 */
  export const sqlite3Worker1Promiser: {
    v2(config?: {
      worker?: () => Worker;
      onready?: (promiser: unknown) => void | Promise<void>;
    }): Promise<unknown>;
  };
}
