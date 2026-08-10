// ============================================================
// category.ts —— CategoryService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts CategoryService、S1 任务书 §四.2、红线 §三.1。
//   - listByAccount 只返回该账户下"未软删"的分类，按 order_num 排。
//   - create 校验 accountId 必填且账户存在，否则 VALIDATION。
//   - remove 改为软删（写 deleted_at）。原 DB 的 ON DELETE SET NULL 不再触发，
//     故在同事务里把引用它的"未软删"交易 category_id 置 NULL 并 bump 其 updated_at，
//     保持"删分类后其交易仍在、categoryId 变 null"的既有语义。
//   - 所有写操作 bump updated_at（LWW 时间戳基建）。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { Category, CategoryDraft, CategoryService, Id } from './contract';
import { AppError } from './contract';
import { rowToCategory, type CategoryRow } from './internal';
import { emitDataChanged } from './sync/bus';

export class CategoryServiceImpl implements CategoryService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async listByAccount(accountId: Id): Promise<Category[]> {
    const rows = await this.adapter.all<CategoryRow>(
      `SELECT id, account_id, name, color, icon, order_num, created_at
         FROM category
        WHERE account_id = ? AND deleted_at IS NULL
        ORDER BY order_num ASC`,
      [accountId],
    );
    return rows.map(rowToCategory);
  }

  async get(id: Id): Promise<Category | null> {
    const row = await this.adapter.get<CategoryRow>(
      `SELECT id, account_id, name, color, icon, order_num, created_at
         FROM category WHERE id = ? AND deleted_at IS NULL`,
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
      `INSERT INTO category
         (id, account_id, name, color, icon, order_num, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, draft.accountId, draft.name, draft.color, draft.icon ?? null, orderNum, createdAt, createdAt],
    );

    emitDataChanged();
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

    // 只要调用 update 就 bump updated_at（LWW 时间戳）。
    sets.push('updated_at = ?');
    params.push(Date.now());

    params.push(id);
    await this.adapter.run(
      `UPDATE category SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      params,
    );

    const updated = await this.get(id);
    if (!updated) {
      throw new AppError('NOT_FOUND', `分类不存在：${id}`);
    }
    emitDataChanged();
    return updated;
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `分类不存在：${id}`);
    }
    // 软删分类，并模拟原 ON DELETE SET NULL：把引用它的"未软删"交易 category_id
    // 置 NULL，同时 bump 那些交易的 updated_at（让它们参与后续合并）。
    const now = Date.now();
    await this.adapter.transaction(async (tx) => {
      await tx.run(
        `UPDATE txn SET category_id = NULL, updated_at = ?
          WHERE category_id = ? AND deleted_at IS NULL`,
        [now, id],
      );
      await tx.run(
        `UPDATE category SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
        [now, now, id],
      );
    });
    emitDataChanged();
  }

  async reorder(accountId: Id, orderedIds: Id[]): Promise<void> {
    const now = Date.now();
    await this.adapter.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await tx.run(
          `UPDATE category SET order_num = ?, updated_at = ? WHERE id = ? AND account_id = ?`,
          [i, now, orderedIds[i], accountId],
        );
      }
    });
    emitDataChanged();
  }

  private async assertAccountExists(accountId: Id): Promise<void> {
    const row = await this.adapter.get<{ id: string }>(
      `SELECT id FROM account WHERE id = ? AND deleted_at IS NULL`,
      [accountId],
    );
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
