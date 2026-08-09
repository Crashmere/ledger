// ============================================================
// stats.ts —— StatsService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts StatsService/Summary、S1 任务书 §四.5、红线 §三.2。
// 本阶段：
//   - summary 必做：net = income − expense；转账既不算 income 也不算 expense、不进 net。
//     用 SQL 聚合，支持 accountIds/timeFrom/timeTo 过滤。
//   - breakdownByCategory / trend 留到 S10：抛"未实现"，避免写错语义。
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
import { AppError } from './contract';

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

  // breakdownByCategory / trend 属 S10，占位不实现（避免写错语义误用）。
  async breakdownByCategory(
    _q: Pick<TxnQuery, 'types' | 'accountIds' | 'timeFrom' | 'timeTo'>,
  ): Promise<CategoryBreakdownRow[]> {
    void _q;
    throw new AppError('DB', 'breakdownByCategory 将在 S10（报告页）阶段实现');
  }

  async trend(
    _q: Pick<TxnQuery, 'accountIds' | 'timeFrom' | 'timeTo'> & { granularity: 'day' | 'month' },
  ): Promise<TrendPoint[]> {
    void _q;
    throw new AppError('DB', 'trend 将在 S10（报告页）阶段实现');
  }
}
