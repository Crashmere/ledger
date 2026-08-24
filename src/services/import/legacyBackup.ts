// ============================================================
// legacyBackup.ts —— 旧 Ivy Wallet 备份 JSON -> 新模型（S7 数据导入）
// ============================================================
// 落地自 交接资料/07-导入器参考实现.ts（映射逻辑已对真实数据验证无损），
// 仅修正 import 路径指向 ../contract，并补齐写库函数 persistImport。
//
// 设计要点（务必保留，来自 07 / S7 任务书第二章）：
//   1. 金额浮点"元" -> 整数"分"：用四舍五入定点转换，禁止 int/trunc(x*100)。
//   2. 分类归属反向构建：旧数据 account.visibleCategoryIdsSerialized（逗号串）
//      -> 新模型 category.account_id（不是分类自带 accountId）。
//   3. 旧数据无 orderNum / 账户无 initialBalance & createdAt -> 生成/兜底。
//   4. 借贷/预算/多币种/汇率/旧 settings 一律丢弃；无标签数据 -> tag/txn_tag 为空。
//
// 写库（persistImport）：
//   - 一个事务内按外键顺序 account -> category -> txn 插入，保留旧 JSON 原 id
//     （用裸 SQL，不走 service.create()，避免生成新 UUID 破坏转账引用/幂等）。
//   - clearFirst=true 时先反序清空 txn_tag -> txn -> category -> account，满足
//     验收纯净基线（4/16/468），二次导入不叠加。
//
// 本文件不依赖 Vue，仅依赖领域类型与 SqliteAdapter 接口，可脱离 UI 单测。
// ============================================================

import type { SqliteAdapter } from '../../db/adapter';
import type { Account, Category, Txn, Cents, EpochMs, TxnType } from '../contract';

// ------------------------------------------------------------
// 旧备份 JSON 的形状（来自真实备份，仅列用到的字段）
// ------------------------------------------------------------
interface LegacyAccount {
  id: string;
  name: string;
  color: number;
  icon?: string | null;
  currency?: string; // 丢弃（固定 CNY）
  orderNum?: number; // 真实数据无此字段
  visibleCategoryIdsSerialized?: string; // 逗号分隔的 categoryId 列表
}

interface LegacyCategory {
  id: string;
  name: string;
  color: number;
  icon?: string | null;
  orderNum?: number; // 真实数据无此字段
}

interface LegacyTxn {
  id: string;
  type: 'INCOME' | 'EXPENSE' | 'TRANSFER';
  amount: number; // 浮点"元"
  accountId: string;
  toAccountId?: string; // 仅转账
  toAmount?: number; // 仅转账，丢弃（同币种 == amount）
  categoryId?: string | null;
  dateTime: number; // epoch ms
  title?: string | null;
  description?: string | null; // -> note
}

export interface LegacyBackup {
  accounts?: LegacyAccount[];
  categories?: LegacyCategory[];
  transactions?: LegacyTxn[];
  settings?: Record<string, unknown>;
  // loanRecords / loans / budgets / plannedPaymentRules / exchangeRates / sharedPrefs -> 全部忽略
  [k: string]: unknown;
}

// ------------------------------------------------------------
// 导入结果
// ------------------------------------------------------------
export interface ImportResult {
  accounts: Account[];
  categories: Category[];
  txns: Txn[];
  stats: {
    accountCount: number;
    categoryCount: number;
    txnOk: number;
    txnFailed: number;
    orphanCategories: number; // 未被任何账户引用的分类数（应为 0）
    /** 收支类中未能确定分类（categoryId 置 null 保留）的交易数——不算失败。 */
    txnNoCategory: number;
    /** 按类型细分成功交易数，供预览/汇总展示。 */
    byType: { income: number; expense: number; transfer: number };
  };
  failures: Array<{ txnId: string; reason: string }>;
}

// ------------------------------------------------------------
// 金额：元 -> 分（四舍五入，避免浮点误差）
//   7.8 -> 780、9.28 -> 928、6690.0 -> 669000
//   truncation 会零星差 1 分（9.29*100=928.999…），务必用 round。
// ------------------------------------------------------------
export function yuanToCents(yuan: string | number): Cents {
  const n = typeof yuan === 'string' ? Number(yuan) : yuan;
  if (!Number.isFinite(n)) throw new Error(`bad amount: ${String(yuan)}`);
  // 先定点消除二进制误差再取整（与 src/services/money.ts 口径一致）。
  return Math.round(Number(n.toFixed(2)) * 100);
}

// ------------------------------------------------------------
// 主函数（纯函数：只算不写，预览步直接用其返回值）
// ------------------------------------------------------------
export function importLegacyBackup(data: LegacyBackup, now: EpochMs = Date.now()): ImportResult {
  const legacyAccounts = data.accounts ?? [];
  const legacyCategories = data.categories ?? [];
  const legacyTxns = data.transactions ?? [];

  // ---- 1. 反向构建 category.account_id ----
  // categoryId -> accountId（谁的 visible 列表里包含它）
  const catToAccount = new Map<string, string>();
  for (const acc of legacyAccounts) {
    const serialized = acc.visibleCategoryIdsSerialized ?? '';
    for (const rawId of serialized.split(',')) {
      const catId = rawId.trim();
      if (catId) catToAccount.set(catId, acc.id);
    }
  }

  // ---- 2. 账户 ----
  const accounts: Account[] = legacyAccounts.map((a, i) => ({
    id: a.id,
    name: a.name,
    color: a.color,
    icon: a.icon ?? null,
    initialBalance: 0, // 旧数据无初始余额
    includeInBalance: true, // 默认计入
    orderNum: a.orderNum ?? i, // 旧数据无 orderNum -> 数组序
    createdAt: now, // 旧数据无创建时间 -> 合成
    kind: 'normal', // 旧数据均为普通账户
    periodStart: null,
    periodEnd: null,
    archivedAt: null,
  }));

  // ---- 3. 分类（补上反向构建的 account_id）----
  let orphanCategories = 0;
  const categories: Category[] = [];
  legacyCategories.forEach((c, i) => {
    const accountId = catToAccount.get(c.id);
    if (!accountId) {
      // 孤儿分类：不属于任何账户。真实数据中为 0；健壮起见跳过并计数。
      orphanCategories++;
      return;
    }
    categories.push({
      id: c.id,
      accountId,
      name: c.name,
      color: c.color,
      icon: c.icon ?? null,
      orderNum: c.orderNum ?? i, // 旧数据无 orderNum -> 数组序
      createdAt: now,
    });
  });

  const accountIds = new Set(accounts.map((a) => a.id));
  const categoryIds = new Set(categories.map((c) => c.id));

  // ---- 4. 交易 ----
  const txns: Txn[] = [];
  const failures: Array<{ txnId: string; reason: string }> = [];
  const byType = { income: 0, expense: 0, transfer: 0 };
  let txnNoCategory = 0;

  for (const t of legacyTxns) {
    const type = t.type.toLowerCase() as TxnType;

    // 引用校验（真实数据中无坏引用，但导入器需健壮，且要与 CHECK 约束对齐）
    if (!accountIds.has(t.accountId)) {
      failures.push({ txnId: t.id, reason: `account not found: ${t.accountId}` });
      continue;
    }
    if (type === 'transfer') {
      if (!t.toAccountId || !accountIds.has(t.toAccountId)) {
        failures.push({ txnId: t.id, reason: `transfer toAccount invalid` });
        continue;
      }
      if (t.toAccountId === t.accountId) {
        failures.push({ txnId: t.id, reason: `transfer to same account` });
        continue;
      }
    }

    let amount: Cents;
    try {
      amount = yuanToCents(t.amount);
    } catch {
      failures.push({ txnId: t.id, reason: `bad amount: ${String(t.amount)}` });
      continue;
    }
    if (amount <= 0) {
      failures.push({ txnId: t.id, reason: `amount <= 0` });
      continue;
    }

    // 分类：为空或非本账户分类 -> 置 null（保留交易）。转账不带分类。
    let categoryId: string | null = t.categoryId ?? null;
    if (categoryId && !categoryIds.has(categoryId)) categoryId = null;
    if (type !== 'transfer' && categoryId === null) txnNoCategory++;

    txns.push({
      id: t.id,
      type,
      amount,
      accountId: t.accountId,
      toAccountId: type === 'transfer' ? (t.toAccountId as string) : null,
      categoryId: type === 'transfer' ? null : categoryId,
      time: t.dateTime,
      title: t.title ?? null,
      note: t.description ?? null, // description -> note
      createdAt: now,
    });
    byType[type]++;
  }

  return {
    accounts,
    categories,
    txns,
    stats: {
      accountCount: accounts.length,
      categoryCount: categories.length,
      txnOk: txns.length,
      txnFailed: failures.length,
      orphanCategories,
      txnNoCategory,
      byType,
    },
    failures,
  };
}

/** 写库模式：replace=先清空再导入（推荐，纯净基线）；merge=按原 id 幂等合并。 */
export type ImportMode = 'replace' | 'merge';

// ------------------------------------------------------------
// 写库：在一个事务里插入（顺序 account -> category -> txn，满足外键）。
//   - 保留原 id（裸 INSERT，不生成新 UUID），使转账引用不错乱、可幂等去重。
//   - mode='replace'：先反序清空既有数据（含开发种子）再插入 -> 纯净基线，
//     反复导入结果稳定（4/16/468，不叠加）。用普通 INSERT 以暴露约束问题。
//   - mode='merge'：按原 id 用 INSERT OR IGNORE，重复导入不产生重复行
//     （已存在同 id 的行原样保留）。与既有种子（不同 id）会并存。
//   - 整体包在一个事务：要么全成功要么全回滚，失败不留半吊子数据。
// adapter 显式传入：UI 传 getAdapter()，单测传测试库 adapter。
// ------------------------------------------------------------
export async function persistImport(
  adapter: SqliteAdapter,
  r: ImportResult,
  opts?: { mode?: ImportMode },
): Promise<void> {
  const mode: ImportMode = opts?.mode ?? 'replace';
  const verb = mode === 'merge' ? 'INSERT OR IGNORE INTO' : 'INSERT INTO';

  await adapter.transaction(async (tx) => {
    if (mode === 'replace') {
      // 反外键顺序清空，避免 RESTRICT 拦截。
      await tx.run('DELETE FROM txn_tag');
      await tx.run('DELETE FROM txn');
      await tx.run('DELETE FROM category');
      await tx.run('DELETE FROM account');
    }

    for (const a of r.accounts) {
      await tx.run(
        `${verb} account(id,name,color,icon,initial_balance,include_in_balance,order_num,created_at,updated_at,deleted_at,kind,period_start,period_end,archived_at)
         VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL)`,
        [
          a.id,
          a.name,
          a.color,
          a.icon,
          a.initialBalance,
          a.includeInBalance ? 1 : 0,
          a.orderNum,
          a.createdAt,
          a.createdAt, // 导入即"新建"：updated_at = created_at
        ],
      );
    }

    for (const c of r.categories) {
      await tx.run(
        `${verb} category(id,account_id,name,color,icon,order_num,created_at,updated_at,deleted_at)
         VALUES(?,?,?,?,?,?,?,?,NULL)`,
        [c.id, c.accountId, c.name, c.color, c.icon, c.orderNum, c.createdAt, c.createdAt],
      );
    }

    for (const t of r.txns) {
      await tx.run(
        `${verb} txn(id,type,amount,account_id,to_account_id,category_id,time,title,note,created_at,updated_at,deleted_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        [
          t.id,
          t.type,
          t.amount,
          t.accountId,
          t.toAccountId,
          t.categoryId,
          t.time,
          t.title,
          t.note,
          t.createdAt,
          t.createdAt,
        ],
      );
    }
  });
}
