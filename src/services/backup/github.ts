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

/** 友好的同步错误（message 面向用户，不含 Token）。 */
export class GithubError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'GithubError';
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
    default:
      return `请求失败（HTTP ${status}）${apiMessage ? `：${apiMessage}` : ''}`;
  }
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
    const msg = await readMessage(res);
    throw new GithubError(statusToMessage(res.status, msg), res.status);
  }

  const body = (await res.json()) as { content?: string; sha?: string };
  if (typeof body.content !== 'string' || typeof body.sha !== 'string') {
    throw new GithubError('远端返回的内容格式异常。', res.status);
  }
  return { content: base64ToUtf8(body.content), sha: body.sha };
}

// ------------------------------------------------------------
// PUT：写入/覆盖文件。覆盖已存在文件必须带 sha（先 GET 拿）。
//   - 内部先 GET：拿到 sha → 覆盖；404 → 首次创建（不带 sha）。
//   - message 不含 Token，仅时间戳。
// ------------------------------------------------------------
export async function putRemoteFile(
  cfg: GithubConfig,
  contentText: string,
  commitMessage: string,
): Promise<void> {
  // 先探测已存在文件的 sha（覆盖必带；404 视为首次创建）。
  const existing = await getRemoteFile(cfg);

  const bodyObj: Record<string, string> = {
    message: commitMessage,
    content: utf8ToBase64(contentText),
    branch: cfg.branch,
  };
  if (existing) bodyObj.sha = existing.sha;

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

  const msg = await readMessage(res);
  if (res.status === 404) {
    throw new GithubError('仓库或分支不存在（请检查 owner / repo / branch 是否正确）。', 404);
  }
  throw new GithubError(statusToMessage(res.status, msg), res.status);
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
