// ============================================================
// github.ts —— GitHub 私有仓同步层（原生 fetch + Contents API）
// ============================================================
// 权威来源：S8 任务书 §3。无 HTTP 库、无 base64 库，一律用浏览器原生 API。
//
// 两个操作：
//   - getRemoteFile：GET 内容 + sha（404 → null，表示远端尚无文件）。
//   - putRemoteFile：PUT 覆盖/创建。覆盖已存在文件必须带该文件当前 sha
//     （先 GET 拿到）；首次创建（GET 得 404）不带 sha。
//
// 安全红线：Token 只经请求头传递，绝不写进任何 console.log / 错误信息 /
// commit message（见 §5.2）。
// ============================================================

import { SYNC_DEFAULTS } from './keys';

// ------------------------------------------------------------
// base64（UTF-8 安全，含中文备注/分类名）
//   btoa 不能直接吃 UTF-8，必须先编码为字节。
// ------------------------------------------------------------
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, '')); // GitHub 返回的 base64 常带换行
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ------------------------------------------------------------
// 配置与错误类型
// ------------------------------------------------------------
export interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  token: string;
}

/** GithubError 的附加元信息（限流退避用）。 */
export interface GithubErrorMeta {
  /** HTTP 状态码。 */
  status?: number;
  /** 服务端建议的重试等待毫秒（来自 Retry-After / x-ratelimit-reset）。 */
  retryAfterMs?: number;
  /** 是否属于限流（429，或 403 且报文含 rate limit）。用于编排层决定是否退避重试。 */
  rateLimited?: boolean;
}

/**
 * 友好的同步错误（message 面向用户，不含 Token）。
 * 兼容旧调用：第二个参数既可传纯 status（number），也可传 GithubErrorMeta。
 */
export class GithubError extends Error {
  status?: number;
  retryAfterMs?: number;
  rateLimited?: boolean;

  constructor(message: string, meta: number | GithubErrorMeta = {}) {
    super(message);
    this.name = 'GithubError';
    if (typeof meta === 'number') {
      this.status = meta;
    } else {
      this.status = meta.status;
      this.retryAfterMs = meta.retryAfterMs;
      this.rateLimited = meta.rateLimited;
    }
  }
}

export interface RemoteFile {
  /** 已解码为 UTF-8 文本的文件内容。 */
  content: string;
  /** 该文件当前 sha（覆盖时必须回传）。 */
  sha: string;
}

// ------------------------------------------------------------
// 内部工具
// ------------------------------------------------------------
function repoUrl(cfg: Pick<GithubConfig, 'owner' | 'repo'>): string {
  return `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(
    cfg.repo,
  )}`;
}

function branchUrl(cfg: Pick<GithubConfig, 'owner' | 'repo' | 'branch'>): string {
  return `${repoUrl(cfg)}/branches/${encodeURIComponent(cfg.branch)}`;
}

function baseUrl(cfg: Pick<GithubConfig, 'owner' | 'repo' | 'path'>): string {
  // path 里可能含子目录，逐段编码后拼回，保留斜杠。
  const encodedPath = cfg.path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${repoUrl(cfg)}/contents/${encodedPath}`;
}

/** 低层 GET：统一把网络异常映射为友好错误。 */
async function apiGet(url: string, token: string): Promise<Response> {
  try {
    return await fetch(url, { headers: headers(token) });
  } catch {
    throw new GithubError('网络错误，请检查连接后重试。');
  }
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** 从响应体尽力取出 GitHub 的 message 字段（不含敏感信息）。 */
async function readMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body?.message ?? '';
  } catch {
    return '';
  }
}

/** 把 HTTP 状态码映射为友好错误（不区分 GET/PUT 的公共部分）。 */
function statusToMessage(status: number, apiMessage: string): string {
  switch (status) {
    case 401:
      return 'Token 无效或已过期。';
    case 403:
      return '无权限（检查 Token 是否具备该仓库的 Contents 读写权限，或触发了限流）。';
    case 409:
      return '远端已变化，请重试。';
    case 429:
      return '请求过于频繁，已被 GitHub 限流，请稍后重试。';
    default:
      return `请求失败（HTTP ${status}）${apiMessage ? `：${apiMessage}` : ''}`;
  }
}

/**
 * 判断响应是否属于「限流」，并尽力算出建议等待毫秒：
 *   - 429：一定是限流；
 *   - 403 且报文含 "rate limit" / "abuse" / "secondary"：GitHub 的一/二级限流。
 * 等待时长优先级：Retry-After（秒）> x-ratelimit-reset（epoch 秒）> 无。
 * 头部读取全程防御式：测试桩的 Response 可能没有 headers。
 */
function rateLimitMeta(
  res: Response,
  apiMessage: string,
): { rateLimited: boolean; retryAfterMs?: number } {
  const status = res.status;
  const msg = apiMessage.toLowerCase();
  const looksRateLimited =
    status === 429 ||
    (status === 403 &&
      (msg.includes('rate limit') || msg.includes('abuse') || msg.includes('secondary')));
  if (!looksRateLimited) return { rateLimited: false };

  const h = res.headers;
  const get = (name: string): string | null =>
    typeof h?.get === 'function' ? h.get(name) : null;

  // Retry-After：秒数（GitHub 二级限流常用）。
  const retryAfter = get('retry-after');
  if (retryAfter != null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return { rateLimited: true, retryAfterMs: secs * 1000 };
  }
  // x-ratelimit-reset：重置时刻（epoch 秒），仅当剩余额度为 0 时才有意义。
  const remaining = get('x-ratelimit-remaining');
  const reset = get('x-ratelimit-reset');
  if (remaining === '0' && reset != null) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) {
      const wait = resetMs - Date.now();
      if (wait > 0) return { rateLimited: true, retryAfterMs: wait };
    }
  }
  return { rateLimited: true };
}

/** 由非 2xx 响应构造 GithubError，并附带限流元信息（供编排层退避重试）。 */
async function errorFromResponse(res: Response): Promise<GithubError> {
  const apiMessage = await readMessage(res);
  const { rateLimited, retryAfterMs } = rateLimitMeta(res, apiMessage);
  return new GithubError(statusToMessage(res.status, apiMessage), {
    status: res.status,
    rateLimited,
    retryAfterMs,
  });
}

// ------------------------------------------------------------
// GET：读取文件内容 + sha。404 → null（远端尚无文件）。
// ------------------------------------------------------------
export async function getRemoteFile(
  cfg: GithubConfig,
): Promise<RemoteFile | null> {
  const url = `${baseUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`;

  const res = await apiGet(url, cfg.token);

  if (res.status === 404) return null;

  if (!res.ok) {
    throw await errorFromResponse(res);
  }

  const body = (await res.json()) as { content?: string; sha?: string };
  if (typeof body.content !== 'string' || typeof body.sha !== 'string') {
    throw new GithubError('远端返回的内容格式异常。', res.status);
  }
  return { content: base64ToUtf8(body.content), sha: body.sha };
}

// ------------------------------------------------------------
// PUT：写入/覆盖文件。
//   - 默认（opts.expectedSha === undefined）：保持旧行为，内部先 GET 探测
//     当前 sha（覆盖必带；404 视为首次创建，不带 sha）。适合"单纯备份覆盖"。
//   - 乐观锁（opts.expectedSha 为 string）：显式携带调用方基于的 sha，跳过内部
//     GET。若远端在此期间已变（sha 不符），服务端返回 409 → 抛 GithubError(409)，
//     由同步编排层据此重跑"GET→合并→PUT"整轮。适合 L2 无损同步。
//   - opts.expectedSha === null：显式声明"远端应无此文件"，按首次创建 PUT。
//   - message 不含 Token，仅时间戳。
// ------------------------------------------------------------
export interface PutRemoteOptions {
  /**
   * 乐观锁 sha：
   *   - undefined（默认）→ 内部先 GET 探测当前 sha 再 PUT（自动覆盖，旧行为）。
   *   - string → 显式携带该 sha PUT；远端若已变（sha 不符）服务端返回 409。
   *   - null → 显式声明"远端应无此文件"，按首次创建 PUT（不带 sha）。
   */
  expectedSha?: string | null;
}

export async function putRemoteFile(
  cfg: GithubConfig,
  contentText: string,
  commitMessage: string,
  opts: PutRemoteOptions = {},
): Promise<void> {
  // 决定本次 PUT 是否携带 sha。
  let sha: string | undefined;
  if (opts.expectedSha === undefined) {
    // 旧行为：内部探测已存在文件的 sha（覆盖必带；404 视为首次创建）。
    const existing = await getRemoteFile(cfg);
    if (existing) sha = existing.sha;
  } else if (opts.expectedSha !== null) {
    // 乐观锁：用调用方给定的 sha，不再自行 GET。
    sha = opts.expectedSha;
  }
  // opts.expectedSha === null → sha 保持 undefined（首次创建）。

  const bodyObj: Record<string, string> = {
    message: commitMessage,
    content: utf8ToBase64(contentText),
    branch: cfg.branch,
  };
  if (sha) bodyObj.sha = sha;

  let res: Response;
  try {
    res = await fetch(baseUrl(cfg), {
      method: 'PUT',
      headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj),
    });
  } catch {
    throw new GithubError('网络错误，请检查连接后重试。');
  }

  if (res.ok) return; // 200/201

  if (res.status === 404) {
    throw new GithubError('仓库或分支不存在（请检查 owner / repo / branch 是否正确）。', 404);
  }
  throw await errorFromResponse(res);
}

// ------------------------------------------------------------
// 测试连接：三级校验，任一层失败都给出精确原因（避免「假绿灯」）。
//   1) GET /repos/{owner}/{repo}      —— 仓库是否存在 / Token 是否有权访问
//   2) GET /repos/.../branches/{ref}  —— 分支是否存在
//   3) GET /repos/.../contents/{path} —— 目标文件是否已存在（404 视为「尚无，将创建」）
// ------------------------------------------------------------
export interface ConnectionResult {
  ok: boolean;
  /** 目标文件是否已存在（用于提示「首次备份」还是「将覆盖」）。 */
  fileExists: boolean;
  message: string;
}

export async function testConnection(cfg: GithubConfig): Promise<ConnectionResult> {
  try {
    // 1) 仓库存在性 + 访问权限。
    const repoRes = await apiGet(repoUrl(cfg), cfg.token);
    if (repoRes.status === 404) {
      // 404 既可能是仓库名拼错，也可能是 fine-grained token 未授权访问该私有仓。
      return {
        ok: false,
        fileExists: false,
        message: '仓库不存在或无权访问（检查 owner / repo 拼写，或 Token 是否已授权访问该仓库）。',
      };
    }
    if (!repoRes.ok) {
      const msg = await readMessage(repoRes);
      return { ok: false, fileExists: false, message: statusToMessage(repoRes.status, msg) };
    }

    // 2) 分支存在性。
    const branchRes = await apiGet(branchUrl(cfg), cfg.token);
    if (branchRes.status === 404) {
      return {
        ok: false,
        fileExists: false,
        message: `分支「${cfg.branch}」不存在（检查分支名，空仓库需先建立首个提交）。`,
      };
    }
    if (!branchRes.ok) {
      const msg = await readMessage(branchRes);
      return { ok: false, fileExists: false, message: statusToMessage(branchRes.status, msg) };
    }

    // 3) 目标文件是否已存在（此处 404 是正常的「尚无备份」）。
    const file = await getRemoteFile(cfg);
    return {
      ok: true,
      fileExists: file !== null,
      message: file
        ? '连接成功，远端已有备份文件（再次备份将覆盖）。'
        : '连接成功，远端尚无备份文件（将于首次备份时创建）。',
    };
  } catch (e) {
    const message = e instanceof GithubError ? e.message : '连接失败，请稍后重试。';
    return { ok: false, fileExists: false, message };
  }
}

/** 用默认值补齐可选配置（branch/path）。 */
export function withDefaults(cfg: Partial<GithubConfig>): GithubConfig {
  return {
    owner: cfg.owner ?? '',
    repo: cfg.repo ?? '',
    branch: cfg.branch || SYNC_DEFAULTS.branch,
    path: cfg.path || SYNC_DEFAULTS.path,
    token: cfg.token ?? '',
  };
}
