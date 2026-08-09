// ============================================================
// tag.ts —— TagService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts TagService、S1 任务书 §四.3。
//   - 标签全局共享，不归属账户。
//   - remove 依赖 DB 的 ON DELETE CASCADE 清 txn_tag：标签本体删除、交易不受影响。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { Id, Tag, TagDraft, TagService } from './contract';
import { AppError } from './contract';
import { rowToTag, type TagRow } from './internal';

export class TagServiceImpl implements TagService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async list(): Promise<Tag[]> {
    const rows = await this.adapter.all<TagRow>(
      `SELECT id, name, color, icon, order_num, created_at
         FROM tag
        ORDER BY order_num ASC`,
    );
    return rows.map(rowToTag);
  }

  async create(draft: TagDraft): Promise<Tag> {
    if (!draft.name || draft.name.trim().length === 0) {
      throw new AppError('VALIDATION', '标签名不能为空');
    }

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const orderNum = draft.orderNum ?? (await this.nextOrderNum());

    await this.adapter.run(
      `INSERT INTO tag (id, name, color, icon, order_num, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, draft.name, draft.color, draft.icon ?? null, orderNum, createdAt],
    );

    return {
      id,
      name: draft.name,
      color: draft.color,
      icon: draft.icon ?? null,
      orderNum,
      createdAt,
    };
  }

  async update(id: Id, patch: Partial<TagDraft>): Promise<Tag> {
    const existing = await this.getOne(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `标签不存在：${id}`);
    }
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new AppError('VALIDATION', '标签名不能为空');
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
    if (patch.orderNum !== undefined) {
      sets.push('order_num = ?');
      params.push(patch.orderNum);
    }

    if (sets.length > 0) {
      params.push(id);
      await this.adapter.run(`UPDATE tag SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    const updated = await this.getOne(id);
    if (!updated) {
      throw new AppError('NOT_FOUND', `标签不存在：${id}`);
    }
    return updated;
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.getOne(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `标签不存在：${id}`);
    }
    // ON DELETE CASCADE 由 DB 处理：txn_tag 中该标签的关联自动清除，交易保留。
    await this.adapter.run(`DELETE FROM tag WHERE id = ?`, [id]);
  }

  private async getOne(id: Id): Promise<Tag | null> {
    const row = await this.adapter.get<TagRow>(
      `SELECT id, name, color, icon, order_num, created_at FROM tag WHERE id = ?`,
      [id],
    );
    return row ? rowToTag(row) : null;
  }

  private async nextOrderNum(): Promise<number> {
    const row = await this.adapter.get<{ next: number }>(
      `SELECT COALESCE(MAX(order_num), -1) + 1 AS next FROM tag`,
    );
    return row?.next ?? 0;
  }
}
