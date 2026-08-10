// ============================================================
// tag.ts —— TagService 实现（implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts TagService、S1 任务书 §四.3。
//   - 标签全局共享，不归属账户。
//   - remove 改为软删（写 deleted_at）。原 ON DELETE CASCADE 不再触发，txn_tag 关联
//     行物理保留；读取时靠 join tag.deleted_at IS NULL 过滤掉已删标签，交易不受影响。
//     （txn_tag 不独立版本化，跟随父 txn 合并，故此处不动它。）
//   - 所有写操作 bump updated_at（LWW 时间戳基建）。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type { Id, Tag, TagDraft, TagService } from './contract';
import { AppError } from './contract';
import { rowToTag, type TagRow } from './internal';
import { emitDataChanged } from './sync/bus';

export class TagServiceImpl implements TagService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async list(): Promise<Tag[]> {
    const rows = await this.adapter.all<TagRow>(
      `SELECT id, name, color, icon, order_num, created_at
         FROM tag
        WHERE deleted_at IS NULL
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
      `INSERT INTO tag (id, name, color, icon, order_num, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, draft.name, draft.color, draft.icon ?? null, orderNum, createdAt, createdAt],
    );

    emitDataChanged();
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

    // 只要调用 update 就 bump updated_at（LWW 时间戳）。
    sets.push('updated_at = ?');
    params.push(Date.now());

    params.push(id);
    await this.adapter.run(
      `UPDATE tag SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      params,
    );

    const updated = await this.getOne(id);
    if (!updated) {
      throw new AppError('NOT_FOUND', `标签不存在：${id}`);
    }
    emitDataChanged();
    return updated;
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.getOne(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `标签不存在：${id}`);
    }
    // 软删标签：txn_tag 关联行物理保留（跟随父 txn 合并），交易读取时靠
    // join tag.deleted_at IS NULL 过滤掉已删标签，故此标签不再出现在任何交易上。
    const now = Date.now();
    await this.adapter.run(
      `UPDATE tag SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
      [now, now, id],
    );
    emitDataChanged();
  }

  private async getOne(id: Id): Promise<Tag | null> {
    const row = await this.adapter.get<TagRow>(
      `SELECT id, name, color, icon, order_num, created_at FROM tag
        WHERE id = ? AND deleted_at IS NULL`,
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
