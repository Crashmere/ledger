// ============================================================
// account.ts —— AccountService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts AccountService、S1 任务书 §四.1。
//   - balance 用 SQL 聚合，不把全表拉进内存；转账双向计入（转入 +、转出 -）。
//   - remove 依赖 DB 外键 RESTRICT，捕获后转 AppError('RESTRICT')。
//   - includeInBalance 领域层 boolean、存储层 0/1，读写各转一次。
// 只依赖 SqliteAdapter / money.ts 类型，不 import Vue、不直接 import 驱动。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { Account, AccountDraft, AccountService, Cents, Id } from './contract';
import { AppError } from './contract';
import { isForeignKeyError, rowToAccount, type AccountRow } from './internal';

export class AccountServiceImpl implements AccountService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async list(): Promise<Account[]> {
    const rows = await this.adapter.all<AccountRow>(
      `SELECT id, name, color, icon, initial_balance, include_in_balance, order_num, created_at
         FROM account
        ORDER BY order_num ASC`,
    );
    return rows.map(rowToAccount);
  }

  async get(id: Id): Promise<Account | null> {
    const row = await this.adapter.get<AccountRow>(
      `SELECT id, name, color, icon, initial_balance, include_in_balance, order_num, created_at
         FROM account WHERE id = ?`,
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

    await this.adapter.run(
      `INSERT INTO account
         (id, name, color, icon, initial_balance, include_in_balance, order_num, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        draft.name,
        draft.color,
        draft.icon ?? null,
        initialBalance,
        includeInBalance ? 1 : 0,
        orderNum,
        createdAt,
      ],
    );

    return {
      id,
      name: draft.name,
      color: draft.color,
      icon: draft.icon ?? null,
      initialBalance,
      includeInBalance,
      orderNum,
      createdAt,
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

    if (sets.length > 0) {
      params.push(id);
      await this.adapter.run(`UPDATE account SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const updated = await this.get(id);
    if (!updated) {
      throw new AppError('NOT_FOUND', `账户不存在：${id}`);
    }
    return updated;
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `账户不存在：${id}`);
    }
    try {
      await this.adapter.run(`DELETE FROM account WHERE id = ?`, [id]);
    } catch (err) {
      if (isForeignKeyError(err)) {
        throw new AppError('RESTRICT', '该账户下仍有交易或分类，请先处理后再删除');
      }
      throw err;
    }
  }

  async reorder(orderedIds: Id[]): Promise<void> {
    await this.adapter.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx.run(`UPDATE account SET order_num = ? WHERE id = ?`, [i, orderedIds[i]]);
      }
    });
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
         + COALESCE((SELECT SUM(amount) FROM txn WHERE type = 'income'  AND account_id    = ?), 0)
         - COALESCE((SELECT SUM(amount) FROM txn WHERE type = 'expense' AND account_id    = ?), 0)
         + COALESCE((SELECT SUM(amount) FROM txn WHERE type = 'transfer' AND to_account_id = ?), 0)
         - COALESCE((SELECT SUM(amount) FROM txn WHERE type = 'transfer' AND account_id    = ?), 0)
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
