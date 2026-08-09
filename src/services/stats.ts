// ============================================================
// stats.ts —— StatsService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts StatsService/Summary、S1 任务书 §四.5、红线 §三.2。
// 本阶段（S9）：
//   - summary：net = income − expense；转账既不算 income 也不算 expense、不进 net。
//     用 SQL 聚合，支持 accountIds/timeFrom/timeTo 过滤。
//   - breakdownByCategory：饼图/分类排行数据源。按 category.name 跨账户合并，
//     只统计 income/expense（transfer 恒排除），无分类归入 '未分类'，按 amount 降序。
//   - trend：趋势图数据源。SQL 只取 time/type/amount（附过滤），在 TS 里按本地时区
//     分桶（day/month），聚合 income/expense（transfer 排除），bucket 升序。
// 红线：转账绝不进收支统计（白名单 IN ('income','expense')）；金额全程整数分。
// join 列顺序坑：breakdown 走裸 SQL + 显式列别名 + 按列名映射（不依赖列顺序）。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type {
  CategoryBreakdownRow,
  StatsService,
  Summary,
  TrendPoint,
  TxnQuery,
} from './contract';

/** 无分类交易在分类分布里的归并占位名（红线：不用空串）。 */
const UNCATEGORIZED = '未分类';

export class StatsServiceImpl implements StatsService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async summary(
    q?: Pick<TxnQuery, 'accountIds' | 'timeFrom' | 'timeTo'>,
  ): Promise<Summary> {
    const where: string[] = [];
    const params: unknown[] = [];

    // 只统计收入/支出；转账被这条 type 过滤天然排除，不进 income/expense/net。
    where.push(`type IN ('income', 'expense')`);

    if (q?.accountIds && q.accountIds.length > 0) {
      where.push(`account_id IN (${Array(q.accountIds.length).fill('?').join(', ')})`);
      params.push(...q.accountIds);
    }
    if (q?.timeFrom !== undefined) {
      where.push(`time >= ?`);
      params.push(q.timeFrom);
    }
    if (q?.timeTo !== undefined) {
      where.push(`time <= ?`);
      params.push(q.timeTo);
    }

    const row = await this.adapter.get<{ income: number; expense: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense
         FROM txn
        WHERE ${where.join(' AND ')}`,
      params,
    );

    const income = row?.income ?? 0;
    const expense = row?.expense ?? 0;
    return { income, expense, net: income - expense };
  }

  // ----------------------------------------------------------
  // breakdownByCategory —— 饼图 / 分类排行的数据源。
  //   跨账户按 category.name 合并（靠 SQL GROUP BY 分组键，不靠数据结构）；
  //   无分类交易（category_id IS NULL）归入固定占位名 '未分类'；
  //   只统计 income/expense（transfer 恒排除，即使 q.types 传入也做交集过滤）；
  //   按 amount 降序返回。join category 用 LEFT JOIN + 显式列别名，规避列顺序坑。
  // ----------------------------------------------------------
  async breakdownByCategory(
    q: Pick<TxnQuery, 'types' | 'accountIds' | 'timeFrom' | 'timeTo'>,
  ): Promise<CategoryBreakdownRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    // 白名单收窄：即便 q.types 传入也对 {income,expense} 取交集，transfer 恒排除。
    const allowed: string[] = ['income', 'expense'];
    const types =
      q.types && q.types.length > 0 ? q.types.filter((t) => allowed.includes(t)) : allowed;
    if (types.length === 0) {
      // 交集为空（例如只传了 transfer）：无任何收支可统计，直接空结果。
      return [];
    }
    where.push(`t.type IN (${placeholders(types.length)})`);
    params.push(...types);

    if (q.accountIds && q.accountIds.length > 0) {
      // 收支交易无 to_account_id 语义，这里只按转出/收付账户 account_id 命中。
      where.push(`t.account_id IN (${placeholders(q.accountIds.length)})`);
      params.push(...q.accountIds);
    }
    if (q.timeFrom !== undefined) {
      where.push(`t.time >= ?`);
      params.push(q.timeFrom);
    }
    if (q.timeTo !== undefined) {
      where.push(`t.time <= ?`);
      params.push(q.timeTo);
    }

    // 分组键统一用 COALESCE(c.name, '未分类')，让无分类交易并成一行。
    const rows = await this.adapter.all<{
      category_name: string;
      amount: number;
      cnt: number;
    }>(
      `SELECT COALESCE(c.name, ?) AS category_name,
              SUM(t.amount)        AS amount,
              COUNT(*)             AS cnt
         FROM txn t
         LEFT JOIN category c ON c.id = t.category_id
        WHERE ${where.join(' AND ')}
        GROUP BY COALESCE(c.name, ?)
        ORDER BY amount DESC`,
      [UNCATEGORIZED, ...params, UNCATEGORIZED],
    );

    return rows.map((r) => ({
      categoryName: r.category_name,
      amount: r.amount,
      count: r.cnt,
    }));
  }

  // ----------------------------------------------------------
  // trend —— 趋势图数据源。
  //   SQL 只取回 time/type/amount（附过滤条件、排除 transfer），
  //   分桶在 TS 里按本地时区做（避免 SQLite strftime 的 UTC 串桶问题）。
  //   每桶输出 income/expense（整数分），按 bucket 升序返回。
  // ----------------------------------------------------------
  async trend(
    q: Pick<TxnQuery, 'accountIds' | 'timeFrom' | 'timeTo'> & { granularity: 'day' | 'month' },
  ): Promise<TrendPoint[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    // 白名单：只取收支，transfer 排除。
    where.push(`type IN ('income', 'expense')`);

    if (q.accountIds && q.accountIds.length > 0) {
      where.push(`account_id IN (${placeholders(q.accountIds.length)})`);
      params.push(...q.accountIds);
    }
    if (q.timeFrom !== undefined) {
      where.push(`time >= ?`);
      params.push(q.timeFrom);
    }
    if (q.timeTo !== undefined) {
      where.push(`time <= ?`);
      params.push(q.timeTo);
    }

    const rows = await this.adapter.all<{ time: number; type: string; amount: number }>(
      `SELECT time, type, amount
         FROM txn
        WHERE ${where.join(' AND ')}`,
      params,
    );

    // 在 TS 里按本地时区分桶聚合（bucket -> {income, expense}）。
    const buckets = new Map<string, { income: number; expense: number }>();
    for (const r of rows) {
      const bucket = bucketOf(r.time, q.granularity);
      let agg = buckets.get(bucket);
      if (!agg) {
        agg = { income: 0, expense: 0 };
        buckets.set(bucket, agg);
      }
      if (r.type === 'income') agg.income += r.amount;
      else if (r.type === 'expense') agg.expense += r.amount;
    }

    // bucket 字符串（'2026-08' / '2026-08-08'）按字典序即时间序，升序返回。
    return Array.from(buckets.keys())
      .sort()
      .map((bucket) => {
        const agg = buckets.get(bucket)!;
        return { bucket, income: agg.income, expense: agg.expense };
      });
  }
}

/** 生成 n 个 SQL 占位符 "?, ?, ..."。 */
function placeholders(n: number): string {
  return Array(n).fill('?').join(', ');
}

/** 用两位补零（月/日 → '01'..'12' / '01'..'31'）。 */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * 按本地时区把 epoch 毫秒切成 bucket 字符串：
 *   'month' → '2026-08'；'day' → '2026-08-08'。
 * 用 Date 的本地 getFullYear/getMonth/getDate，确保月初/日界不串桶（不用 UTC strftime）。
 */
export function bucketOf(timeMs: number, granularity: 'day' | 'month'): string {
  const d = new Date(timeMs);
  const ym = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  return granularity === 'month' ? ym : `${ym}-${pad2(d.getDate())}`;
}
