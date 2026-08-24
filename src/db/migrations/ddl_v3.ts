// ============================================================
// v3 迁移 DDL —— 专项账户（project account）
// ============================================================
// 背景：新增一类「专项账户」，用于记录某段时间的特殊开支（如一次旅行）。
//   - 这类账户默认不计入日常余额总额，且其交易被全局收支统计默认排除；
//   - 借助已有的 account/category/txn/余额/软删/同步全链路，不新增表。
//
// 语义（全部可空，存量行=NULL 即「普通账户」，零回填风险）：
//   - kind：账户种类。NULL / 'normal' = 普通；'project' = 专项。
//           作为统计排除与 UI 分区的唯一开关（开放枚举，未来可扩 'budget' 等）。
//   - period_start / period_end：专项覆盖的时间段（epoch ms），对应「某段时间」。
//   - archived_at：归档/结束标记（epoch ms）。结束后折叠、置只读用；非空=已归档。
//
// SQLite 约束：ADD COLUMN 不能用「引用其它列」的默认值，这里全部可空、
//   无需回填（存量行 kind IS NULL 天然被当作普通账户处理）。
//   kind 上建索引，加速统计里「排除 kind='project' 账户」的子查询。
// ============================================================

export const DDL_V3 = `
-- 1) account 增列（均可空；存量行=NULL 即普通账户）
ALTER TABLE account ADD COLUMN kind         TEXT;
ALTER TABLE account ADD COLUMN period_start INTEGER;
ALTER TABLE account ADD COLUMN period_end   INTEGER;
ALTER TABLE account ADD COLUMN archived_at  INTEGER;

-- 2) kind 上建索引，加速「WHERE kind = 'project'」的统计排除子查询
CREATE INDEX IF NOT EXISTS idx_account_kind ON account(kind);
`;
