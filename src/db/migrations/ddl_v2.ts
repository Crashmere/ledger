// ============================================================
// v2 迁移 DDL —— 为记录级同步（L2）引入 updated_at / deleted_at
// ============================================================
// 背景：多设备云同步需要「后写胜（LWW）」与「软删墓碑」两块基建：
//   - updated_at：每条记录最后修改的 epoch ms。合并时比它挑赢家。
//   - deleted_at：软删墓碑（非空=已删）。物理保留行，杜绝合并期外键崩溃，
//     并防止「一方删、另一方留」被误当新增而复活。
//
// 施加对象：account / category / txn / tag 四张有 UUID 主键的业务表。
//   txn_tag 是复合主键、无独立身份，不单独版本化 —— 合并时跟随父 txn 的赢家
//   整体替换其标签集（与 TxnService.update 的「先清后插」语义一致）。
//   setting 是本机配置，不参与跨设备记录级合并，也不加列。
//
// SQLite 约束：ADD COLUMN 不能用「引用其它列」的默认值，故先加可空列，
//   再用 UPDATE 回填 updated_at = created_at（存量行视为「创建即最后修改」）。
//   deleted_at 保持 NULL（存量行都是「未删」）。新行由服务层写入时显式赋值。
// ============================================================

export const DDL_V2 = `
-- 1) 四表各加两列（可空；SQLite ADD COLUMN 默认追加到表末尾，不影响既有列序）
ALTER TABLE account  ADD COLUMN updated_at INTEGER;
ALTER TABLE account  ADD COLUMN deleted_at INTEGER;
ALTER TABLE category ADD COLUMN updated_at INTEGER;
ALTER TABLE category ADD COLUMN deleted_at INTEGER;
ALTER TABLE txn      ADD COLUMN updated_at INTEGER;
ALTER TABLE txn      ADD COLUMN deleted_at INTEGER;
ALTER TABLE tag      ADD COLUMN updated_at INTEGER;
ALTER TABLE tag      ADD COLUMN deleted_at INTEGER;

-- 2) 回填：存量行 updated_at = created_at（创建即最后修改），deleted_at 留 NULL
UPDATE account  SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE category SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE txn      SET updated_at = created_at WHERE updated_at IS NULL;
UPDATE tag      SET updated_at = created_at WHERE updated_at IS NULL;

-- 3) deleted_at 上建索引，加速「WHERE deleted_at IS NULL」的常规读过滤
CREATE INDEX IF NOT EXISTS idx_account_deleted  ON account(deleted_at);
CREATE INDEX IF NOT EXISTS idx_category_deleted ON category(deleted_at);
CREATE INDEX IF NOT EXISTS idx_txn_deleted      ON txn(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tag_deleted      ON tag(deleted_at);
`;
