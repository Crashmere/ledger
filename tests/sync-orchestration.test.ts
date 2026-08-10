// ============================================================
// sync-orchestration.test.ts —— L2 同步编排（syncNow）端到端
// ============================================================
// 用"有状态的假 GitHub 远端"（精确模拟 Contents API 的乐观锁：PUT 带的 sha 与
// 当前不符即 409）+ 真实测试库，跑通 syncNow 的每条路径：
//   skipped / created / up-to-date / pushed / 409 冲突自动重试 / 远端脏数据不覆盖。
// 这是"痛点2 安全自动同步"的验收：不再靠人肉保证同步顺序，且冲突不丢数据。
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BetterSqliteAdapter, makeTestAdapter } from './better-sqlite-adapter';
import { AccountServiceImpl, TxnServiceImpl } from '../src/services';
import { exportSnapshot, serializeSnapshot } from '../src/services/backup/snapshot';
import { utf8ToBase64, base64ToUtf8, type GithubConfig } from '../src/services/backup/github';
import { syncNow } from '../src/services/sync';

const CFG: GithubConfig = {
  owner: 'me',
  repo: 'ivy_bak',
  branch: 'main',
  path: 'ivy-wallet-snapshot.json',
  token: 'ghp_SECRET',
};

/**
 * 有状态的假远端：内存里存一份 { content, sha }，精确复刻 GitHub Contents API
 * 的乐观锁语义。可注入 onBeforePut 钩子模拟"GET 与 PUT 之间被别的设备改了"。
 */
class FakeRemote {
  content: string | null;
  sha: string;
  private seq = 0;
  /** 在处理每次 PUT 之前调用一次（用于注入并发修改）。 */
  onBeforePut: (() => void) | null = null;

  constructor(initial: string | null = null) {
    this.content = initial;
    this.sha = initial === null ? '' : this.nextSha();
  }

  private nextSha(): string {
    this.seq += 1;
    return `sha_${this.seq}`;
  }

  /** 直接改远端内容（模拟别的设备推送），bump sha。 */
  setContent(text: string): void {
    this.content = text;
    this.sha = this.nextSha();
  }

  /** 造一个 fetch 桩：GET 读、PUT 按乐观锁写。 */
  makeFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (this.content === null) return mkRes(404, { message: 'Not Found' });
        return mkRes(200, { content: utf8ToBase64(this.content), sha: this.sha });
      }
      // PUT
      this.onBeforePut?.();
      const body = JSON.parse(init!.body as string) as { content: string; sha?: string };
      if (this.content !== null) {
        // 已存在：必须带对得上的 sha，否则 409（乐观锁）。
        if (body.sha !== this.sha) return mkRes(409, { message: 'does not match' });
      } else {
        // 不存在：带了 sha 反而 422（GitHub 语义）。
        if (body.sha) return mkRes(422, { message: 'sha given but file absent' });
      }
      this.content = base64ToUtf8(body.content);
      this.sha = this.nextSha();
      return mkRes(this.content === null ? 201 : 200, {});
    });
  }
}

function mkRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let local: BetterSqliteAdapter;

beforeEach(async () => {
  local = await makeTestAdapter();
});

afterEach(() => {
  local.close();
  vi.restoreAllMocks();
});

describe('syncNow 编排', () => {
  it('未配置 token → skipped，且不发任何请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await syncNow({ adapter: local, config: { ...CFG, token: '' } });
    expect(res.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('远端无文件 → created：把本地快照首次 PUT（不带 sha）', async () => {
    const acc = await new AccountServiceImpl(local).create({ name: '现金', color: 1 });
    await new TxnServiceImpl(local).create({ type: 'expense', amount: 100, accountId: acc.id });

    const remote = new FakeRemote(null);
    vi.stubGlobal('fetch', remote.makeFetch());

    const res = await syncNow({ adapter: local, config: CFG });
    expect(res.status).toBe('created');
    expect(res.retries).toBe(0);
    // 远端现在有内容，且解析出本地那笔交易。
    expect(remote.content).not.toBeNull();
    const parsed = JSON.parse(remote.content!);
    expect(parsed.tables.txn).toHaveLength(1);
    expect(parsed.tables.account).toHaveLength(1);
  });

  it('远端已是合并结果 → up-to-date：吸收但不重复推送', async () => {
    const acc = await new AccountServiceImpl(local).create({ name: '现金', color: 1 });
    await new TxnServiceImpl(local).create({ type: 'income', amount: 500, accountId: acc.id });

    // 远端放一份与本地"合并后"逐字节一致的快照（这里本地=远端，merge 幂等）。
    const snap = await exportSnapshot(local);
    const remote = new FakeRemote(serializeSnapshot(snap));
    const shaBefore = remote.sha;
    vi.stubGlobal('fetch', remote.makeFetch());

    const res = await syncNow({ adapter: local, config: CFG });
    expect(res.status).toBe('up-to-date');
    expect(remote.sha).toBe(shaBefore); // 未 PUT，sha 不变
  });

  it('本地有远端没有的新增 → pushed：合并后带 sha 推送', async () => {
    // 远端：一个账户 + 一笔收入。
    const remoteAdapter = await makeTestAdapter();
    const rAcc = await new AccountServiceImpl(remoteAdapter).create({ name: '现金', color: 1 });
    await new TxnServiceImpl(remoteAdapter).create({
      type: 'income',
      amount: 500,
      accountId: rAcc.id,
    });
    const remoteSnap = await exportSnapshot(remoteAdapter);
    remoteAdapter.close();

    // 本地：同一账户（同 id）+ 一笔本地独有的支出。
    await new AccountServiceImpl(local).create({ name: '现金', color: 1 });
    // 用远端账户 id 造本地交易，保证两侧账户可合并；这里直接塞本地独有交易。
    const lAcc = (await new AccountServiceImpl(local).list())[0];
    await new TxnServiceImpl(local).create({ type: 'expense', amount: 100, accountId: lAcc.id });

    const remote = new FakeRemote(serializeSnapshot(remoteSnap));
    vi.stubGlobal('fetch', remote.makeFetch());

    const res = await syncNow({ adapter: local, config: CFG });
    expect(res.status).toBe('pushed');
    // 远端现在应含"两侧交易并集"（远端收入 + 本地支出）。
    const parsed = JSON.parse(remote.content!);
    expect(parsed.tables.txn.length).toBeGreaterThanOrEqual(2);
    // 本地也吸收了远端那笔收入。
    const localTxns = await new TxnServiceImpl(local).query({});
    expect(localTxns.some((t) => t.type === 'income' && t.amount === 500)).toBe(true);
  });

  it('推送时远端被并发改动（409）→ 自动整轮重试并最终成功', async () => {
    const acc = await new AccountServiceImpl(local).create({ name: '现金', color: 1 });
    await new TxnServiceImpl(local).create({ type: 'expense', amount: 100, accountId: acc.id });

    // 远端初始有一份旧快照（空业务表也行，关键是有文件 → 会带 sha PUT）。
    const seed = await exportSnapshot(await makeTestAdapter());
    const remote = new FakeRemote(serializeSnapshot(seed));

    // 只在第一次 PUT 之前，偷偷把远端改掉（bump sha）→ 第一次 PUT 必 409。
    let injected = false;
    remote.onBeforePut = () => {
      if (!injected) {
        injected = true;
        remote.setContent(remote.content! + '\n'); // 改内容 → sha 变
      }
    };
    vi.stubGlobal('fetch', remote.makeFetch());

    const res = await syncNow({ adapter: local, config: CFG });
    expect(res.status).toBe('pushed');
    expect(res.retries).toBeGreaterThanOrEqual(1); // 至少重试过一次
    // 最终远端仍含本地那笔支出（没因冲突丢失）。
    const parsed = JSON.parse(remote.content!);
    expect(parsed.tables.txn.some((t: { amount: number }) => t.amount === 100)).toBe(true);
  });

  it('远端文件损坏（非本应用 JSON）→ error，绝不覆盖远端', async () => {
    await new AccountServiceImpl(local).create({ name: '现金', color: 1 });
    const remote = new FakeRemote('{"app":"someone-else","junk":true}');
    const before = remote.content;
    vi.stubGlobal('fetch', remote.makeFetch());

    const res = await syncNow({ adapter: local, config: CFG });
    expect(res.status).toBe('error');
    expect(remote.content).toBe(before); // 远端原样保留，不被覆盖
  });
});
