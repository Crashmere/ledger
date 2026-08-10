// ============================================================
// github.test.ts —— S8 GitHub 同步层单测（mock fetch）
// ============================================================
// 覆盖 S8 任务书 §3 与 §六 DoD #5/#9 里的 HTTP 逻辑（无需真实仓库/Token）：
//   - PUT 首次创建（GET 404 → 不带 sha）；再次覆盖（GET 200 → 带 sha）。
//   - base64 内容用 UTF-8 编码（中文安全），可解码回原文。
//   - 请求头带 Bearer Token / Accept / X-GitHub-Api-Version。
//   - 错误映射：401/403/404/409/网络 reject → 友好文案，且不含 Token。
//   - getRemoteFile：200 解码内容+sha；404 → null。
// ============================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getRemoteFile,
  putRemoteFile,
  testConnection,
  base64ToUtf8,
  utf8ToBase64,
  GithubError,
  type GithubConfig,
} from '../src/services/backup/github';

const CFG: GithubConfig = {
  owner: 'me',
  repo: 'ivy_bak',
  branch: 'main',
  path: 'ivy-wallet-snapshot.json',
  token: 'ghp_SECRET',
};

/** 造一个 Response-like 对象（够 github.ts 用）。 */
function mkRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getRemoteFile', () => {
  it('200 → 解码 content 与 sha', async () => {
    const content = utf8ToBase64('{"中文":"值"}');
    const fetchMock = vi.fn().mockResolvedValue(mkRes(200, { content, sha: 'abc123' }));
    vi.stubGlobal('fetch', fetchMock);

    const file = await getRemoteFile(CFG);
    expect(file).not.toBeNull();
    expect(file!.sha).toBe('abc123');
    expect(file!.content).toBe('{"中文":"值"}');

    // 请求头校验：Bearer Token / Accept / 版本。
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ghp_SECRET');
    expect(headers.Accept).toBe('application/vnd.github+json');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('404 → null（远端尚无文件）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(404, { message: 'Not Found' })));
    expect(await getRemoteFile(CFG)).toBeNull();
  });

  it('401 → 友好错误「Token 无效或已过期」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(401, { message: 'Bad credentials' })));
    await expect(getRemoteFile(CFG)).rejects.toMatchObject({ status: 401 });
    try {
      await getRemoteFile(CFG);
    } catch (e) {
      expect(e).toBeInstanceOf(GithubError);
      expect((e as GithubError).message).toContain('Token 无效');
      // 错误信息不含 Token。
      expect((e as GithubError).message).not.toContain('ghp_SECRET');
    }
  });

  it('网络 reject → 「网络错误」', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(getRemoteFile(CFG)).rejects.toThrow('网络错误');
  });
});

describe('putRemoteFile', () => {
  it('首次创建：GET 404 → PUT 不带 sha', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(404, { message: 'Not Found' })) // 内部先 GET
      .mockResolvedValueOnce(mkRes(201, {})); // 再 PUT
    vi.stubGlobal('fetch', fetchMock);

    await putRemoteFile(CFG, '{"a":"中文"}', 'backup: test');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, putInit] = fetchMock.mock.calls[1];
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(body.sha).toBeUndefined(); // 首次不带 sha
    expect(body.branch).toBe('main');
    expect(body.message).toBe('backup: test');
    // content 是 UTF-8 base64，可解回原文（中文安全）。
    expect(base64ToUtf8(body.content as string)).toBe('{"a":"中文"}');
  });

  it('覆盖已存在：GET 200 拿 sha → PUT 带上该 sha', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(200, { content: utf8ToBase64('old'), sha: 'OLDSHA' }))
      .mockResolvedValueOnce(mkRes(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await putRemoteFile(CFG, 'new', 'backup: overwrite');

    const [, putInit] = fetchMock.mock.calls[1];
    const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
    expect(body.sha).toBe('OLDSHA'); // 覆盖必须带 sha
  });

  it('PUT 阶段 404 → 提示仓库/分支不存在', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(404, { message: 'Not Found' })) // GET
      .mockResolvedValueOnce(mkRes(404, { message: 'Not Found' })); // PUT
    vi.stubGlobal('fetch', fetchMock);
    await expect(putRemoteFile(CFG, 'x', 'm')).rejects.toThrow('仓库或分支不存在');
  });

  it('PUT 409 sha 冲突 → 「远端已变化，请重试」', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(200, { content: utf8ToBase64('old'), sha: 'S' }))
      .mockResolvedValueOnce(mkRes(409, { message: 'conflict' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(putRemoteFile(CFG, 'x', 'm')).rejects.toThrow('远端已变化');
  });

  it('commit message 与请求体均不含 Token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(404, {}))
      .mockResolvedValueOnce(mkRes(201, {}));
    vi.stubGlobal('fetch', fetchMock);
    await putRemoteFile(CFG, '{"x":1}', 'backup: ivy-wallet snapshot 2026');
    const [, putInit] = fetchMock.mock.calls[1];
    expect(putInit.body as string).not.toContain('ghp_SECRET');
  });

  describe('乐观锁（expectedSha）', () => {
    it('expectedSha=string → 跳过内部 GET，直接 PUT 带该 sha', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(mkRes(200, {})); // 只有一次 PUT
      vi.stubGlobal('fetch', fetchMock);

      await putRemoteFile(CFG, 'merged', 'sync: x', { expectedSha: 'REMOTE_SHA' });

      expect(fetchMock).toHaveBeenCalledTimes(1); // 无内部 GET
      const [, putInit] = fetchMock.mock.calls[0];
      expect(putInit.method).toBe('PUT');
      const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
      expect(body.sha).toBe('REMOTE_SHA');
    });

    it('expectedSha=null → 首次创建，PUT 不带 sha 且不 GET', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(mkRes(201, {}));
      vi.stubGlobal('fetch', fetchMock);

      await putRemoteFile(CFG, 'first', 'sync: x', { expectedSha: null });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, putInit] = fetchMock.mock.calls[0];
      const body = JSON.parse(putInit.body as string) as Record<string, unknown>;
      expect(body.sha).toBeUndefined();
    });

    it('expectedSha=string 且远端已变 → PUT 409 抛 GithubError(409)', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(mkRes(409, { message: 'conflict' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        putRemoteFile(CFG, 'x', 'm', { expectedSha: 'STALE' }),
      ).rejects.toMatchObject({ status: 409 });
      expect(fetchMock).toHaveBeenCalledTimes(1); // 未做内部 GET
    });
  });
});

describe('testConnection（仓库→分支→文件 三级校验）', () => {
  it('仓库+分支存在、文件已存在 → ok + fileExists=true', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(200, { full_name: 'me/ivy_bak' })) // repo
      .mockResolvedValueOnce(mkRes(200, { name: 'main' })) // branch
      .mockResolvedValueOnce(mkRes(200, { content: utf8ToBase64('{}'), sha: 's' })); // file
    vi.stubGlobal('fetch', fetchMock);
    const r = await testConnection(CFG);
    expect(r.ok).toBe(true);
    expect(r.fileExists).toBe(true);
    // 三次请求：repo / branch / contents。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0][0] as string)).toBe('https://api.github.com/repos/me/ivy_bak');
    expect((fetchMock.mock.calls[1][0] as string)).toContain('/branches/main');
  });

  it('仓库+分支存在、文件不存在（404）→ ok + fileExists=false', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(200, { full_name: 'me/ivy_bak' })) // repo
      .mockResolvedValueOnce(mkRes(200, { name: 'main' })) // branch
      .mockResolvedValueOnce(mkRes(404, { message: 'Not Found' })); // file
    vi.stubGlobal('fetch', fetchMock);
    const r = await testConnection(CFG);
    expect(r.ok).toBe(true);
    expect(r.fileExists).toBe(false);
  });

  it('仓库名拼错（repo 404）→ ok=false，提示仓库不存在，且不再查分支/文件', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mkRes(404, { message: 'Not Found' })); // repo 404
    vi.stubGlobal('fetch', fetchMock);
    const r = await testConnection(CFG);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('仓库不存在或无权访问');
    // 仓库都不存在，不应继续打 branch/contents。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('分支不存在（branch 404）→ ok=false，提示分支不存在（含分支名）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mkRes(200, { full_name: 'me/ivy_bak' })) // repo ok
      .mockResolvedValueOnce(mkRes(404, { message: 'Branch not found' })); // branch 404
    vi.stubGlobal('fetch', fetchMock);
    const r = await testConnection(CFG);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('分支「main」不存在');
    // 分支不存在，不应继续查文件。
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('401（首层即失败）→ ok=false，文案不含 Token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(401, { message: 'Bad credentials' })));
    const r = await testConnection(CFG);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Token 无效');
    expect(r.message).not.toContain('ghp_SECRET');
  });
});
