# Ivy Wallet Development Guide

本文件是仓库内 AI 与开发者共同遵守的长期约定，作用域为整个仓库。它是唯一进入 Git 的项目文档；详细产品背景、当前状态与历史决策保存在本地忽略目录 `.project-docs/`。

## 1. 开工顺序

1. 先读本文件。
2. 按任务读取 `.project-docs/README.md` 指向的本地文档；若该目录不存在，以本文件和当前代码为准。
3. 检查 `git status --short --branch`，不得覆盖用户未提交的改动。
4. 先查代码、测试和迁移，不依据旧阶段编号或历史记忆猜测现状。

冲突优先级：当前数据库迁移与约束 > 当前服务契约和测试 > 本文件 > `.project-docs/` > 历史 Git 记录。

## 2. 当前基线

- 产品：单人、本地优先的个人记账 PWA。
- 技术栈：Vue 3、TypeScript strict、Vite、Pinia、Vue Router、SQLite WASM + OPFS SAHPool。
- 唯一交付形态：PWA；不开发 Tauri 或其他桌面壳。
- 部署：GitHub Pages，线上地址 `https://crashmere.github.io/ledger/`。
- 数据库：`PRAGMA user_version = 2`；最新版本以 `src/db/schema.ts` 和 `src/db/migrations/` 为准。
- 同步：GitHub 私有仓 JSON 快照、乐观锁、记录级 LWW 合并、软删墓碑、3 秒防抖自动同步。
- 测试基线会增长，不要在约定中固化数量；以 `npm test` 实际输出为准。

## 3. 产品不变量

- 金额全链路使用整数分；输入转分必须正确四舍五入，禁止浮点金额累计。
- 主键为 UUID 字符串；时间为 epoch 毫秒。
- `txn.time` 表示用户选择日期的本地零点；同日展示排序可用 `created_at` 兜底。
- 分类必须归属账户；交易选择账户后只能选择该账户下的分类。
- 转账使用单条 `txn`：`type='transfer'`、转出账户在 `account_id`、转入账户在 `to_account_id`。
- 转账在单账户口径计入流入/流出，在全局收入、支出和净额中排除。
- 交易录入和编辑必须同时保留 `title` 与 `note` 两个独立字段。
- 单人账本，不加入成员、协作、记账人或多用户概念。
- 本地 SQLite/OPFS 是数据权威源；不引入必须长期运行或付费的后端。
- 手机端记一笔保持高密度、数字键盘常驻；应尽量在常见视口无纵向滚动，但不得为凑一屏牺牲字段和可用性。

## 4. 数据与同步约定

- 上层业务只依赖 `SqliteAdapter`，不得直接 import sqlite-wasm 驱动。
- 每个数据库连接都必须开启 `PRAGMA foreign_keys = ON`。
- schema 变更必须新增逐版本迁移并更新 `SCHEMA_VERSION`，禁止直接改旧迁移模拟已发布历史。
- v2 的 `account`、`category`、`txn`、`tag` 使用 `updated_at` 和 `deleted_at`。
- 常规删除为软删；所有常规读取必须排除 `deleted_at IS NOT NULL` 的记录。
- 删除分类时，要将仍存活交易的 `category_id` 清空并更新交易的 `updated_at`。
- 删除账户前必须确认没有存活分类或关联交易；服务层返回稳定的领域错误，不靠 UI 猜 SQL 文本。
- `txn_tag` 不独立版本化，跟随父交易参与同步；不要随软删物理清除关联。
- LWW 比较 `updated_at`；同毫秒冲突使用稳定的 canonical JSON 字典序裁决。
- 数据等价比较必须忽略快照生成时间与行顺序，不能用原始 JSON 文本比较。
- GitHub Token 只能由用户在 UI 输入并存入本地 `setting`；禁止写入源码、环境默认值、日志、测试夹具或提交历史。
- 破坏性恢复与 SQL 写操作必须有明确的二次确认和备份提醒。

## 5. 代码边界

- `src/db/`：adapter、schema、迁移和 Worker；改动风险最高。
- `src/services/`：平台无关领域逻辑；不得依赖 Vue。
- `src/pages/`：页面和 UI 编排；不要在页面复制服务层业务规则。
- `src/pages/sqlConsole.ts`：SQL 分类安全边界。CTE、PRAGMA、多语句、注释和字符串中的假关键字都要从严处理。
- `src/styles/tokens.css`：全局设计 token 和响应式外壳；优先复用 token，不随意引入散落色值。
- 桌面页的顶栏控制通过 `App.vue` 的 `#topbar-slot` Teleport；概览月份条居中规则必须限定在概览页，不能影响账户页 tab。
- 手机断点统一以现有 `720px` 规则为准；底部四个 tab 为概览、账户、报告、设置，搜索走顶栏入口，中央按钮进入记一笔。

## 6. 实施原则

- 在现有代码库中做最小、聚焦的修改，修根因，不做无关重构。
- 先检索再修改；涉及数据录入时，必须将界面字段与 schema/服务输入逐项交叉核对。
- 不新增依赖，除非现有能力无法合理完成任务且用户认可。
- 不使用 `any` 绕过 strict 类型检查。
- 不使用 `eval` 解析金额算式。
- 不使用 `v-html` 渲染用户或数据库内容；高亮必须先安全分段和转义。
- 不提交构建产物、数据库、导出快照、Token 或 `.project-docs/`。
- 除非用户明确要求，不创建分支、不提交、不推送。

## 7. 验证要求

最小验证：

```bash
npm test
npm run build
git diff --check
```

- 优先运行受影响模块的测试，再运行完整测试。
- 数据层、同步、备份、SQL 控制台改动必须补充针对边界和绕过路径的测试。
- UI 改动在可用时通过 Chrome DevTools MCP 实测；至少检查桌面与 `390x844` 手机视口、关键交互、控制台错误和失败网络请求。
- OPFS SAHPool 可能被同源多个标签或陈旧开发服务器占用。实测前确认端口和进程，不要把句柄冲突误判为代码缺陷。
- 部署相关改动还要验证 `DEPLOY_BASE` 子路径、PWA 产物和 GitHub Pages SPA 深链兜底。

## 8. 文档维护

- `.project-docs/` 保存可更新的本地详细文档，整个目录由 `.gitignore` 忽略。
- 产品规则变化：更新 `.project-docs/PRODUCT.md`；若属于长期硬约定，同时更新本文件。
- 架构、schema、同步或部署变化：更新 `.project-docs/ARCHITECTURE.md`。
- 当前状态、待办和已知问题变化：更新 `.project-docs/STATUS.md`。
- 运行、测试或发布流程变化：更新 `.project-docs/OPERATIONS.md`。
- 完成一次有意义的开发后，只记录仍会影响未来工作的结论；不要保留逐阶段验收流水账、CI run 编号或已失效任务书。

## 9. Git 约定

- 提交信息格式：`type(scope): 摘要` 或 `type: 摘要`。
- 一个提交只做一件事，保持可审查。
- 若编写或修改提交信息，末尾必须且只能出现一次：

```text
Co-authored-by: TRAE CLI <noreply@bytedance.com>
```
