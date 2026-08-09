// ============================================================
// category.ts —— CategoryService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts CategoryService、S1 任务书 §四.2、红线 §三.1。
//   - listByAccount 只返回该账户下的分类（红线：分类归属账户），按 order_num 排。
//   - create 校验 accountId 必填且账户存在，否则 VALIDATION。
//   - remove 依赖 DB 的 ON DELETE SET NULL：删后其交易 category_id 变 NULL、交易保留。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { Category, CategoryDraft, CategoryService, Id } from './contract';
import { AppError } from './contract';
import { rowToCategory, type CategoryRow } from './internal';

export class CategoryServiceImpl implements CategoryService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async listByAccount(accountId: Id): Promise<Category[]> {
    const rows = await this.adapter.all<CategoryRow>(
      `SELECT id, account_id, name, color, icon, order_num, created_at
         FROM category
        WHERE account_id = ?
        ORDER BY order_num ASC`,
      [accountId],
    );
    return rows.map(rowToCategory);
  }

  async get(id: Id): Promise<Category | null> {
    const row = await this.adapter.get<CategoryRow>(
      `SELECT id, account_id, name, color, icon, order_num, created_at
         FROM category WHERE id = ?`,
      [id],
    );
    return row ? rowToCategory(row) : null;
  }

  async create(draft: CategoryDraft): Promise<Category> {
    if (!draft.accountId) {
      throw new AppError('VALIDATION', '分类必须归属某个账户');
    }
    if (!draft.name || draft.name.trim().length === 0) {
      throw new AppError('VALIDATION', '分类名不能为空');
    }
    await this.assertAccountExists(draft.accountId);

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const orderNum = draft.orderNum ?? (await this.nextOrderNum(draft.accountId));

    await this.adapter.run(
      `INSERT INTO category (id, account_id, name, color, icon, order_num, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, draft.accountId, draft.name, draft.color, draft.icon ?? null, orderNum, createdAt],
    );

    return {
      id,
      accountId: draft.accountId,
      name: draft.name,
      color: draft.color,
      icon: draft.icon ?? null,
      orderNum,
      createdAt,
    };
  }

  async update(id: Id, patch: Partial<CategoryDraft>): Promise<Category> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `分类不存在：${id}`);
    }
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new AppError('VALIDATION', '分类名不能为空');
    }
    if (patch.accountId !== undefined) {
      await this.assertAccountExists(patch.accountId);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.accountId !== undefined) {
      sets.push('account_id = ?');
      params.push(patch.accountId);
    }
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
    if (patch.orderNum !== undefined) {
      sets.push('order_num = ?');
      params.push(patch.orderNum);
    }

    if (sets.length > 0) {
      params.push(id);
      await this.adapter.run(`UPDATE category SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const updated = await this.get(id);
    if (!updated) {
      throw new AppError('NOT_FOUND', `分类不存在：${id}`);
    }
    return updated;
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `分类不存在：${id}`);
    }
    // ON DELETE SET NULL 由 DB 处理：其交易的 category_id 自动置 NULL，交易保留。
    await this.adapter.run(`DELETE FROM category WHERE id = ?`, [id]);
  }

  async reorder(accountId: Id, orderedIds: Id[]): Promise<void> {
    await this.adapter.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx.run(`UPDATE category SET order_num = ? WHERE id = ? AND account_id = ?`, [
          i,
          orderedIds[i],
          accountId,
        ]);
      }
    });
  }

  private async assertAccountExists(accountId: Id): Promise<void> {
    const row = await this.adapter.get<{ id: string }>(`SELECT id FROM account WHERE id = ?`, [
      accountId,
    ]);
    if (!row) {
      throw new AppError('VALIDATION', `账户不存在：${accountId}`);
    }
  }

  private async nextOrderNum(accountId: Id): Promise<number> {
    const row = await this.adapter.get<{ next: number }>(
      `SELECT COALESCE(MAX(order_num), -1) + 1 AS next FROM category WHERE account_id = ?`,
      [accountId],
    );
    return row?.next ?? 0;
  }
}
