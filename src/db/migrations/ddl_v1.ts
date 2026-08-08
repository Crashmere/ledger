// ============================================================
// v1 建表 DDL —— 逐字取自 交接资料/04-数据库schema.sql（建库唯一权威）
// ============================================================
// 注意：这里是 04-数据库schema.sql 的镜像副本，仅去掉了两条 PRAGMA
// （foreign_keys 由 adapter.init 每次连接执行；user_version 由 migrator 显式置 1）。
// 表结构/字段/约束/索引一律以 04 为准，不得在此擅自改动；04 变更时同步更新本文件。
// ============================================================

export const DDL_V1 = `
-- ------------------------------------------------------------
-- account · 账户
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account (
    id                 TEXT    PRIMARY KEY,                 -- UUID
    name               TEXT    NOT NULL,
    color              INTEGER NOT NULL,                    -- ARGB 整数（可为负）
    icon               TEXT,                                -- 图标名，可空
    initial_balance    INTEGER NOT NULL DEFAULT 0,          -- 初始余额（分）
    include_in_balance INTEGER NOT NULL DEFAULT 1,          -- 是否计入总余额（0/1）
    order_num          REAL    NOT NULL,                    -- 拖拽排序（插值）
    created_at         INTEGER NOT NULL,                    -- epoch ms
    CHECK (include_in_balance IN (0, 1))
);

-- ------------------------------------------------------------
-- category · 分类（归属且仅归属一个账户）
--   删账户时若仍有分类挂着 -> RESTRICT（与 txn 一致，账户不可轻易删）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category (
    id          TEXT    PRIMARY KEY,                        -- UUID
    account_id  TEXT    NOT NULL,                           -- 所属账户
    name        TEXT    NOT NULL,                           -- 跨账户可同名
    color       INTEGER NOT NULL,
    icon        TEXT,
    order_num   REAL    NOT NULL,                           -- 账户内排序
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_category_account ON category(account_id);

-- ------------------------------------------------------------
-- txn · 交易（收入/支出/转账 同表）
--   account_id     ：收入=收款账户；支出=付款账户；转账=转出账户
--   to_account_id  ：仅转账，转入账户
--   删账户 -> RESTRICT（账户下有交易禁止直接删）
--   删分类 -> category_id 置 NULL（交易保留）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS txn (
    id             TEXT    PRIMARY KEY,                     -- UUID
    type           TEXT    NOT NULL,                        -- income / expense / transfer
    amount         INTEGER NOT NULL,                        -- 金额（分，正数）
    account_id     TEXT    NOT NULL,
    to_account_id  TEXT,                                    -- 仅 transfer 有值
    category_id    TEXT,                                    -- 可空
    time           INTEGER NOT NULL,                        -- 交易发生时间 epoch ms
    title          TEXT,
    note           TEXT,
    created_at     INTEGER NOT NULL,
    CHECK (type IN ('income', 'expense', 'transfer')),
    CHECK (amount > 0),
    -- 转账必须有转入账户且不等于转出账户；非转账不得有转入账户
    CHECK (
        (type = 'transfer' AND to_account_id IS NOT NULL AND to_account_id <> account_id)
        OR
        (type <> 'transfer' AND to_account_id IS NULL)
    ),
    FOREIGN KEY (account_id)    REFERENCES account(id)  ON DELETE RESTRICT,
    FOREIGN KEY (to_account_id) REFERENCES account(id)  ON DELETE RESTRICT,
    FOREIGN KEY (category_id)   REFERENCES category(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_txn_time        ON txn(time);
CREATE INDEX IF NOT EXISTS idx_txn_account     ON txn(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_to_account  ON txn(to_account_id);
CREATE INDEX IF NOT EXISTS idx_txn_category    ON txn(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_type        ON txn(type);

-- ------------------------------------------------------------
-- tag · 标签（全局共享，不归属账户）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tag (
    id          TEXT    PRIMARY KEY,                        -- UUID
    name        TEXT    NOT NULL,
    color       INTEGER NOT NULL,
    icon        TEXT,
    order_num   REAL    NOT NULL,
    created_at  INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- txn_tag · 交易↔标签 多对多
--   删交易或删标签 -> 级联清关联（交易/标签本体不受影响）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS txn_tag (
    txn_id  TEXT NOT NULL,
    tag_id  TEXT NOT NULL,
    PRIMARY KEY (txn_id, tag_id),
    FOREIGN KEY (txn_id) REFERENCES txn(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tag(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_txn_tag_tag ON txn_tag(tag_id);

-- ------------------------------------------------------------
-- setting · 键值设置
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS setting (
    key    TEXT PRIMARY KEY,
    value  TEXT
);
`;
