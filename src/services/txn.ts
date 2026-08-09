// ============================================================
// txn.ts —— TxnService 实现（本阶段最核心，implements 06 契约）
// ============================================================
// 权威来源：06-接口契约.ts TxnService/TxnQuery/TxnWithTags、S1 任务书 §四.4、红线 §三.1/2。
// 关键点：
//   - create/update 校验：amount>0；transfer 必有 toAccountId、须存在、!=accountId；
//     非 transfer 时 toAccountId 必须为空；categoryId 若给必须属于 accountId 账户；账户须存在。
//   - 带 tagIds 的 create/update 在同一事务里维护 txn_tag（用 adapter.transaction）。
//   - query 用参数化 SQL 拼 WHERE（禁止字符串插值用户输入）；tag 过滤走 txn_tag 子查询。
//   - 列顺序坑：涉及 join 一律裸 SQL + 列别名，按列名映射（不依赖 drizzle proxy 的列顺序）。
// ============================================================

import type { SqliteAdapter } from '../db/adapter';
import { getAdapter } from '../db/client';
import type {
  Id,
  Tag,
  Txn,
  TxnDraft,
  TxnQuery,
  TxnService,
  TxnWithTags,
} from './contract';
import { AppError } from './contract';
import { rowToTag, rowToTxn, type TagRow, type TxnRow } from './internal';

/** 计算出的交易有效值（create 直接用；update 由 existing + patch 合并得到）。 */
interface TxnEffective {
  type: Txn['type'];
  amount: number;
  accountId: Id;
  toAccountId: Id | null;
  categoryId: Id | null;
  time: number;
  title: string | null;
  note: string | null;
}

export class TxnServiceImpl implements TxnService {
  constructor(private readonly adapter: SqliteAdapter = getAdapter()) {}

  async query(q: TxnQuery): Promise<TxnWithTags[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (q.types && q.types.length > 0) {
      where.push(`type IN (${placeholders(q.types.length)})`);
      params.push(...q.types);
    }
    if (q.accountIds && q.accountIds.length > 0) {
      // 账户维度：转出账户或转入账户命中都算（转账在两账户流水中都体现）。
      const ph = placeholders(q.accountIds.length);
      where.push(`(account_id IN (${ph}) OR to_account_id IN (${ph}))`);
      params.push(...q.accountIds, ...q.accountIds);
    }
    if (q.categoryIds && q.categoryIds.length > 0) {
      where.push(`category_id IN (${placeholders(q.categoryIds.length)})`);
      params.push(...q.categoryIds);
    }
    if (q.tagIds && q.tagIds.length > 0) {
      where.push(
        `id IN (SELECT txn_id FROM txn_tag WHERE tag_id IN (${placeholders(q.tagIds.length)}))`,
      );
      params.push(...q.tagIds);
    }
    if (q.keyword && q.keyword.length > 0) {
      where.push(`(title LIKE ? OR note LIKE ?)`);
      const like = `%${q.keyword}%`;
      params.push(like, like);
    }
    if (q.timeFrom !== undefined) {
      where.push(`time >= ?`);
      params.push(q.timeFrom);
    }
    if (q.timeTo !== undefined) {
      where.push(`time <= ?`);
      params.push(q.timeTo);
    }
    if (q.amountMin !== undefined) {
      where.push(`amount >= ?`);
      params.push(q.amountMin);
    }
    if (q.amountMax !== undefined) {
      where.push(`amount <= ?`);
      params.push(q.amountMax);
    }

    const sortBy = q.sortBy === 'amount' ? 'amount' : 'time';
    const sortDir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    let sql =
      `SELECT id, type, amount, account_id, to_account_id, category_id, time, title, note, created_at
         FROM txn
        ${whereSql}
        ORDER BY ${sortBy} ${sortDir}, created_at ${sortDir}`;
    if (q.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(q.limit);
      if (q.offset !== undefined) {
        sql += ` OFFSET ?`;
        params.push(q.offset);
      }
    }

    const rows = await this.adapter.all<TxnRow>(sql, params);
    const txns = rows.map(rowToTxn);
    const tagsByTxn = await this.loadTagsFor(txns.map((t) => t.id));
    return txns.map((t) => ({ ...t, tags: tagsByTxn.get(t.id) ?? [] }));
  }

  async get(id: Id): Promise<TxnWithTags | null> {
    const row = await this.adapter.get<TxnRow>(
      `SELECT id, type, amount, account_id, to_account_id, category_id, time, title, note, created_at
         FROM txn WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    const txn = rowToTxn(row);
    const tagsByTxn = await this.loadTagsFor([txn.id]);
    return { ...txn, tags: tagsByTxn.get(txn.id) ?? [] };
  }

  async create(draft: TxnDraft): Promise<Txn> {
    const effective = await this.validateAndNormalize({
      type: draft.type,
      amount: draft.amount,
      accountId: draft.accountId,
      toAccountId: draft.toAccountId ?? null,
      categoryId: draft.categoryId ?? null,
      time: draft.time ?? Date.now(),
      title: draft.title ?? null,
      note: draft.note ?? null,
    });

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const tagIds = dedupe(draft.tagIds ?? []);

    await this.adapter.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO txn
           (id, type, amount, account_id, to_account_id, category_id, time, title, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          effective.type,
          effective.amount,
          effective.accountId,
          effective.toAccountId,
          effective.categoryId,
          effective.time,
          effective.title,
          effective.note,
          createdAt,
        ],
      );
      for (const tagId of tagIds) {
        await tx.run(`INSERT INTO txn_tag (txn_id, tag_id) VALUES (?, ?)`, [id, tagId]);
      }
    });

    return {
      id,
      type: effective.type,
      amount: effective.amount,
      accountId: effective.accountId,
      toAccountId: effective.toAccountId,
      categoryId: effective.categoryId,
      time: effective.time,
      title: effective.title,
      note: effective.note,
      createdAt,
    };
  }

  async update(id: Id, patch: Partial<TxnDraft>): Promise<Txn> {
    const existing = await this.get(id);
    if (!existing) {
      throw new AppError('NOT_FOUND', `交易不存在：${id}`);
    }

    // 合并出有效值，再整体校验（避免 type/toAccountId 部分更新导致 CHECK 不一致）。
    const merged = {
      type: patch.type ?? existing.type,
      amount: patch.amount ?? existing.amount,
      accountId: patch.accountId ?? existing.accountId,
      toAccountId: patch.toAccountId !== undefined ? patch.toAccountId : existing.toAccountId,
      categoryId: patch.categoryId !== undefined ? patch.categoryId : existing.categoryId,
      time: patch.time ?? existing.time,
      title: patch.title !== undefined ? patch.title : existing.title,
      note: patch.note !== undefined ? patch.note : existing.note,
    };
    const effective = await this.validateAndNormalize(merged);

    await this.adapter.transaction(async (tx) => {
      // 整表写有效值：把互相牵连的 type/to_account_id 一次性对齐，DB CHECK 不会踩空。
      await tx.run(
        `UPDATE txn
            SET type = ?, amount = ?, account_id = ?, to_account_id = ?,
                category_id = ?, time = ?, title = ?, note = ?
          WHERE id = ?`,
        [
          effective.type,
          effective.amount,
          effective.accountId,
          effective.toAccountId,
          effective.categoryId,
          effective.time,
          effective.title,
          effective.note,
          id,
        ],
      );

      if (patch.tagIds !== undefined) {
        // 全量替换关联：先清后插，整个过程在同一事务内。
        await tx.run(`DELETE FROM txn_tag WHERE txn_id = ?`, [id]);
        for (const tagId of dedupe(patch.tagIds)) {
          await tx.run(`INSERT INTO txn_tag (txn_id, tag_id) VALUES (?, ?)`, [id, tagId]);
        }
      }
    });

    return {
      id,
      type: effective.type,
      amount: effective.amount,
      accountId: effective.accountId,
      toAccountId: effective.toAccountId,
      categoryId: effective.categoryId,
      time: effective.time,
      title: effective.title,
      note: effective.note,
      createdAt: existing.createdAt,
    };
  }

  async remove(id: Id): Promise<void> {
    const existing = await this.adapter.get<{ id: string }>(`SELECT id FROM txn WHERE id = ?`, [
      id,
    ]);
    if (!existing) {
      throw new AppError('NOT_FOUND', `交易不存在：${id}`);
    }
    // ON DELETE CASCADE 由 DB 清理 txn_tag。
    await this.adapter.run(`DELETE FROM txn WHERE id = ?`, [id]);
  }

  // ----------------------------------------------------------
  // 校验 + 规范化：所有 create/update 的领域规则集中于此。
  // ----------------------------------------------------------
  private async validateAndNormalize(v: {
    type: Txn['type'];
    amount: number;
    accountId: Id;
    toAccountId: Id | null;
    categoryId: Id | null;
    time: number;
    title: string | null;
    note: string | null;
  }): Promise<TxnEffective> {
    if (!Number.isInteger(v.amount) || v.amount <= 0) {
      throw new AppError('VALIDATION', '金额必须为正整数（分）');
    }
    if (!v.accountId) {
      throw new AppError('VALIDATION', '缺少账户');
    }
    await this.assertAccountExists(v.accountId);

    let toAccountId = v.toAccountId;
    if (v.type === 'transfer') {
      if (!toAccountId) {
        throw new AppError('VALIDATION', '转账必须指定转入账户');
      }
      if (toAccountId === v.accountId) {
        throw new AppError('VALIDATION', '转账的转入账户不能与转出账户相同');
      }
      await this.assertAccountExists(toAccountId);
    } else {
      // 非转账不得有转入账户（与 04 的 CHECK 一致）。
      if (toAccountId) {
        throw new AppError('VALIDATION', '非转账交易不能指定转入账户');
      }
      toAccountId = null;
    }

    if (v.categoryId) {
      const cat = await this.adapter.get<{ account_id: string }>(
        `SELECT account_id FROM category WHERE id = ?`,
        [v.categoryId],
      );
      if (!cat) {
        throw new AppError('VALIDATION', `分类不存在：${v.categoryId}`);
      }
      if (cat.account_id !== v.accountId) {
        throw new AppError('VALIDATION', '所选分类不属于该交易的账户');
      }
    }

    return {
      type: v.type,
      amount: v.amount,
      accountId: v.accountId,
      toAccountId,
      categoryId: v.categoryId,
      time: v.time,
      title: v.title,
      note: v.note,
    };
  }

  private async assertAccountExists(accountId: Id): Promise<void> {
    const row = await this.adapter.get<{ id: string }>(`SELECT id FROM account WHERE id = ?`, [
      accountId,
    ]);
    if (!row) {
      throw new AppError('VALIDATION', `账户不存在：${accountId}`);
    }
  }

  /**
   * 批量取出多笔交易的标签，返回 txnId -> Tag[]。
   * join 用列别名 + 按列名映射，规避 S0 已知的 drizzle proxy 列顺序坑。
   */
  private async loadTagsFor(txnIds: Id[]): Promise<Map<Id, Tag[]>> {
    const result = new Map<Id, Tag[]>();
    if (txnIds.length === 0) return result;

    const rows = await this.adapter.all<{ link_txn_id: string } & TagRow>(
      `SELECT tt.txn_id      AS link_txn_id,
              t.id           AS id,
              t.name         AS name,
              t.color        AS color,
              t.icon         AS icon,
              t.order_num    AS order_num,
              t.created_at   AS created_at
         FROM txn_tag tt
         JOIN tag t ON t.id = tt.tag_id
        WHERE tt.txn_id IN (${placeholders(txnIds.length)})
        ORDER BY t.order_num ASC`,
      txnIds,
    );

    for (const row of rows) {
      const list = result.get(row.link_txn_id) ?? [];
      list.push(rowToTag(row));
      result.set(row.link_txn_id, list);
    }
    return result;
  }
}

/** 生成 n 个 SQL 占位符 "?, ?, ..."。 */
function placeholders(n: number): string {
  return Array(n).fill('?').join(', ');
}

/** 去重（保留首次顺序）。 */
function dedupe(ids: Id[]): Id[] {
  return Array.from(new Set(ids));
}
