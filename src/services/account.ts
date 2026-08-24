// ============================================================
// account.ts —— AccountService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts AccountService、S1 任务书 §四.1。
//   - balance 用 SQL 聚合，不把全表拉进内存；转账双向计入（转入 +、转出 -）。
//     （只统计未软删的交易：WHERE deleted_at IS NULL。）
//   - remove 改为软删（写 deleted_at）；软删后行仍在、DB 外键不再触发，
//     故 RESTRICT 语义改由应用层查询"是否还有未删的子交易/分类"来保。
//   - 所有写操作 bump updated_at（LWW 后写胜的时间戳基建）。
//   - includeInBalance 领域层 boolean、存储层 0/1，读写各转一次。
// 只依赖 SqliteAdapter / money.ts 类型，不 import Vue、不直接 import 驱动。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { Account, AccountDraft, AccountService, Cents, Id } from './contract';
import { AppError } from './contract';
import { rowToAccount, type AccountRow } from './internal';
import { emitDataChanged } from './sync/bus';

export class AccountServiceImpl implements AccountService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async list(): Promise<Account[]> {
    const rows = await this.adapter.all<AccountRow>(
      `SELECT id, name, color, icon, initial_balance, include_in_balance, order_num, created_at,
              kind, period_start, period_end, archived_at
         FROM account
        WHERE deleted_at IS NULL
        ORDER BY order_num ASC`,
    );
    return rows.map(rowToAccount);
  }

  async get(id: Id): Promise<Account | null> {
    const row = await this.adapter.get<AccountRow>(
      `SELECT id, name, color, icon, initial_balance, include_in_balance, order_num, created_at,
              kind, period_start, period_end, archived_at
         FROM account WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row ? rowToAccount(row) : null;
  }

  async create(draft: AccountDraft): Promise<Account> {
    if (!draft.name || draft.name.trim().length === 0) {
      throw new AppError('VALIDATION', '账户名不能为空');
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const initialBalance = draft.initialBalance ?? 0;
    const includeInBalance = draft.includeInBalance ?? true;
    const orderNum = draft.orderNum ?? (await this.nextOrderNum());
    const kind = draft.kind ?? 'normal';
    const periodStart = draft.periodStart ?? null;
    const periodEnd = draft.periodEnd ?? null;
    const archivedAt = draft.archivedAt ?? null;

    await this.adapter.run(
      `INSERT INTO account
         (id, name, color, icon, initial_balance, include_in_balance, order_num, created_at, updated_at, deleted_at,
          kind, period_start, period_end, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        id,
        draft.name,
        draft.color,
        draft.icon ?? null,
        initialBalance,
        includeInBalance ? 1 : 0,
        orderNum,
        createdAt,
        createdAt, // 新建：updated_at = created_at
        // v3：普通账户的 kind 存 NULL（保持与存量行一致、快照更干净），仅专项存 'project'。
        kind === 'project' ? 'project' : null,
        periodStart,
        periodEnd,
        archivedAt,
      ],
    );

    emitDataChanged();
    return {
      id,
      name: draft.name,
      color: draft.color,
      icon: draft.icon ?? null,
      initialBalance,
      includeInBalance,
      orderNum,
      createdAt,
      kind,
      periodStart,
      periodEnd,
      archivedAt,
    };
  }

  async update(id: Id, patch: Partial<AccountDraft>): Promise<Account> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `账户不存在：${id}`);
    }
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new AppError('VALIDATION', '账户名不能为空');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.color !== undefined) {
      sets.push('color = ?');
      params.push(patch.color);
    }
    if (patch.icon !== undefined) {
      sets.push('icon = ?');
      params.push(patch.icon ?? null);
    }
    if (patch.initialBalance !== undefined) {
      sets.push('initial_balance = ?');
      params.push(patch.initialBalance);
    }
    if (patch.includeInBalance !== undefined) {
      sets.push('include_in_balance = ?');
      params.push(patch.includeInBalance ? 1 : 0);
    }
    if (patch.orderNum !== undefined) {
      sets.push('order_num = ?');
      params.push(patch.orderNum);
    }
    if (patch.kind !== undefined) {
      // 普通账户存 NULL、专项存 'project'，与新建口径一致。
      sets.push('kind = ?');
      params.push(patch.kind === 'project' ? 'project' : null);
    }
    if (patch.periodStart !== undefined) {
      sets.push('period_start = ?');
      params.push(patch.periodStart ?? null);
    }
    if (patch.periodEnd !== undefined) {
      sets.push('period_end = ?');
      params.push(patch.periodEnd ?? null);
    }
    if (patch.archivedAt !== undefined) {
      sets.push('archived_at = ?');
      params.push(patch.archivedAt ?? null);
    }

    // 无论改了哪些字段，只要调用 update 就 bump updated_at（LWW 时间戳）。
    sets.push('updated_at = ?');
    params.push(Date.now());

    params.push(id);
    await this.adapter.run(
      `UPDATE account SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      params,
    );

    const updated = await this.get(id);
    if (!updated) {
      throw new AppError('NOT_FOUND', `账户不存在：${id}`);
    }
    emitDataChanged();
    return updated;
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `账户不存在：${id}`);
    }
    // 软删后行仍在，DB 外键不会再触发 RESTRICT；改由应用层校验：
    // 该账户下是否还有"未软删"的子交易 / 分类。任一存在则拒删。
    const child = await this.adapter.get<{ cnt: number }>(
      `SELECT
         (SELECT COUNT(*) FROM txn
           WHERE deleted_at IS NULL AND (account_id = ? OR to_account_id = ?))
       + (SELECT COUNT(*) FROM category
           WHERE deleted_at IS NULL AND account_id = ?)
         AS cnt`,
      [id, id, id],
    );
    if ((child?.cnt ?? 0) > 0) {
      throw new AppError('RESTRICT', '该账户下仍有交易或分类，请先处理后再删除');
    }
    const now = Date.now();
    await this.adapter.run(
      `UPDATE account SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, id],
    );
    emitDataChanged();
  }

  async reorder(orderedIds: Id[]): Promise<void> {
    const now = Date.now();
    await this.adapter.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx.run(`UPDATE account SET order_num = ?, updated_at = ? WHERE id = ?`, [
          i,
          now,
          orderedIds[i],
        ]);
      }
    });
    emitDataChanged();
  }

  /**
   * 余额 = initial_balance
   *      + 收入(account_id=本账户) − 支出(account_id=本账户)
   *      + 转入(transfer 且 to_account_id=本账户) − 转出(transfer 且 account_id=本账户)
   * 全部用 SQL 聚合，不拉全表进内存。
   */
  async balance(id: Id): Promise<Cents> {
    const account = await this.get(id);
    if (!account) {
      throw new AppError('NOT_FOUND', `账户不存在：${id}`);
    }
    const row = await this.adapter.get<{ balance: number }>(
      `SELECT
         ?
         + COALESCE((SELECT SUM(amount) FROM txn WHERE deleted_at IS NULL AND type = 'income'  AND account_id    = ?), 0)
         - COALESCE((SELECT SUM(amount) FROM txn WHERE deleted_at IS NULL AND type = 'expense' AND account_id    = ?), 0)
         + COALESCE((SELECT SUM(amount) FROM txn WHERE deleted_at IS NULL AND type = 'transfer' AND to_account_id = ?), 0)
         - COALESCE((SELECT SUM(amount) FROM txn WHERE deleted_at IS NULL AND type = 'transfer' AND account_id    = ?), 0)
         AS balance`,
      [account.initialBalance, id, id, id, id],
    );
    return row?.balance ?? account.initialBalance;
  }

  /** 追加到末尾用的 order_num：当前最大值 + 1（空表则 0）。 */
  private async nextOrderNum(): Promise<number> {
    const row = await this.adapter.get<{ next: number }>(
      `SELECT COALESCE(MAX(order_num), -1) + 1 AS next FROM account`,
    );
    return row?.next ?? 0;
  }
}
