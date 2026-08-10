<script setup lang="ts">
// ============================================================
// Settings.vue —— 设置页（S7 · 数据导入）
// ============================================================
// 对照 设计稿/settings.html 桌面稿的「数据 · 导入 / 导出」分组卡片风格还原，
// 本阶段（S7）只落地「从旧备份导入」这一区块，其余（外观/云备份/导出/危险区）
// 保留为后续阶段占位说明，不做交互。
//
// 导入流程（选文件 → 预览 → 确认 → 执行 → 汇总）：
//   1. 选文件：<input type=file> 读文本 JSON.parse；解析失败友好提示、不崩溃。
//   2. 预览：跑 importLegacyBackup(data)（纯函数，不写库），展示将导入范围
//      + 明确「不迁移」内容（借贷/预算/多币种/设置/标签）。
//   3. 确认：默认「覆盖导入」（先清空再导入）——二次确认弹层提示会清空现有数据；
//      另提供「合并导入」（按原 id 幂等）。
//   4. 执行：persistImport 写库（带 loading，防重复点击）。
//   5. 汇总：展示成功账户/分类/交易、失败数、孤儿分类、无分类交易，列出失败原因。
//
// 红线：
//   - 界面文案不出现「记账人/成员/协作/TA」（单用户应用）。
//   - 本页只展示计数（账户/分类/交易笔数），不展示金额；金额转分由
//     importLegacyBackup 内部走 Math.round（与 money 口径一致）。
//   - 只经 getAdapter() 裸 SQL 或服务层写库，不改数据层/服务层签名。
// ============================================================
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { getAdapter } from '../db/client';
import {
  importLegacyBackup,
  persistImport,
  type ImportMode,
  type ImportResult,
  type LegacyBackup,
} from '../services/import/legacyBackup';
import {
  buildSnapshotText,
  localFileName,
  loadConfig,
  saveConfig,
  hasToken,
  getLastBackupAt,
  backupToCloud,
  fetchCloudSnapshot,
  restoreFromSnapshot,
  testGithubConnection,
  GithubError,
  type GithubConfig,
  type BackupSnapshot,
  type SnapshotCounts,
} from '../services/backup';
import { planBatch, ensureLimit, type BatchPlan } from './sqlConsole';

const router = useRouter();

// ---------- 流程状态 ----------
type Phase = 'idle' | 'previewed' | 'done';
const phase = ref<Phase>('idle');

const fileName = ref('');
const parseError = ref(''); // 选文件/解析阶段的友好错误
const preview = ref<ImportResult | null>(null); // 预览（不写库）
const parsed = ref<LegacyBackup | null>(null); // 已解析的原始数据（执行时复用）

const importing = ref(false); // 执行中（防重复点击）
const importError = ref(''); // 写库阶段错误
const result = ref<ImportResult | null>(null); // 执行后的结果汇总

// 二次确认弹层（覆盖导入会清空现有数据）。
const confirmMode = ref<ImportMode | null>(null);

const fileInput = ref<HTMLInputElement | null>(null);

// ---------- 计算：预览/汇总的展示数字 ----------
const previewStats = computed(() => preview.value?.stats ?? null);
const resultStats = computed(() => result.value?.stats ?? null);

/** 汇总里展示的失败明细（最多前 8 条，避免过长）。 */
const failuresToShow = computed(() => (result.value?.failures ?? []).slice(0, 8));
const moreFailures = computed(() =>
  Math.max(0, (result.value?.failures.length ?? 0) - failuresToShow.value.length),
);

// ============================================================
// 选文件 → 解析 → 预览
// ============================================================
function pickFile(): void {
  fileInput.value?.click();
}

async function onFileChange(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  // 允许重复选择同名文件：清空 value，否则第二次 change 不触发。
  input.value = '';
  if (!file) return;
  await loadFile(file);
}

/** 拖拽放入文件。 */
async function onDrop(ev: DragEvent): Promise<void> {
  const file = ev.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
}

async function loadFile(file: File): Promise<void> {
  resetOutcome();
  fileName.value = file.name;
  parseError.value = '';
  preview.value = null;
  parsed.value = null;

  let text: string;
  try {
    text = await file.text();
  } catch {
    parseError.value = '读取文件失败，请重试。';
    return;
  }

  if (!text.trim()) {
    parseError.value = '文件为空，请选择有效的备份 JSON。';
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    parseError.value = '不是有效的 JSON 文件，请检查文件内容。';
    return;
  }

  if (typeof data !== 'object' || data === null) {
    parseError.value = 'JSON 顶层不是对象，无法识别为备份文件。';
    return;
  }

  const backup = data as LegacyBackup;
  const hasKnown =
    Array.isArray(backup.accounts) ||
    Array.isArray(backup.categories) ||
    Array.isArray(backup.transactions);
  if (!hasKnown) {
    parseError.value = '文件里找不到 accounts / categories / transactions，可能不是旧备份文件。';
    return;
  }

  // 预览：纯函数计算，绝不写库。
  try {
    preview.value = importLegacyBackup(backup);
    parsed.value = backup;
    phase.value = 'previewed';
  } catch (e) {
    parseError.value = `解析备份失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

// ============================================================
// 确认 → 执行
// ============================================================
/** 点「覆盖导入」/「合并导入」：先弹二次确认。 */
function askConfirm(mode: ImportMode): void {
  if (!preview.value) return;
  confirmMode.value = mode;
}

async function runImport(): Promise<void> {
  const mode = confirmMode.value;
  const backup = parsed.value;
  confirmMode.value = null;
  if (!mode || !backup || importing.value) return;

  importing.value = true;
  importError.value = '';
  try {
    // 重新映射一次（用当前时刻作为 createdAt），再写库。
    const r = importLegacyBackup(backup);
    await persistImport(getAdapter(), r, { mode });
    result.value = r;
    phase.value = 'done';
  } catch (e) {
    importError.value = `导入失败，已回滚，未写入任何数据：${
      e instanceof Error ? e.message : String(e)
    }`;
  } finally {
    importing.value = false;
  }
}

// ============================================================
// 重置
// ============================================================
/** 只清执行结果（重新选文件时用）。 */
function resetOutcome(): void {
  result.value = null;
  importError.value = '';
  phase.value = 'idle';
}

/** 全部重来（回到选文件）。 */
function reset(): void {
  fileName.value = '';
  parseError.value = '';
  preview.value = null;
  parsed.value = null;
  result.value = null;
  importError.value = '';
  phase.value = 'idle';
}

function goOverview(): void {
  void router.push('/overview');
}

const confirmTitle = computed(() =>
  confirmMode.value === 'replace' ? '确认覆盖导入？' : '确认合并导入？',
);

// ============================================================
// 云备份（S8）：本地导出 / GitHub 配置 / 备份·恢复
// ============================================================

/** 统一把错误转成面向用户的文案（GithubError 已是友好文案）。 */
function friendlyError(e: unknown): string {
  if (e instanceof GithubError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---------- 卡片 A：本地导出 ----------
const exporting = ref(false);
const exportMsg = ref('');

async function exportToFile(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  exportMsg.value = '';
  try {
    const text = await buildSnapshotText(getAdapter());
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = localFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportMsg.value = '已导出完整快照到本地下载。';
  } catch (e) {
    exportMsg.value = `导出失败：${friendlyError(e)}`;
  } finally {
    exporting.value = false;
  }
}

// ---------- 卡片 B：GitHub 配置 ----------
// owner/repo/branch/path 已内置为代码常量（见 config/sync-defaults），
// UI 不再让用户编辑；此处只保留 Token 输入。cfgForm 仍存全字段仅为
// 复用既有 saveConfig/resolveConfig（它们从内置默认/已存配置取仓库信息）。
const cfgForm = ref<{ owner: string; repo: string; branch: string; path: string; token: string }>({
  owner: '',
  repo: '',
  branch: 'main',
  path: 'ivy-wallet-snapshot.json',
  token: '',
});
const tokenConfigured = ref(false); // 是否已存 token（不明文回显）
const savingCfg = ref(false);
const cfgMsg = ref('');
const cfgError = ref('');

/** 展示用的内置仓库标识（owner/repo，来自已加载配置）。 */
const repoLabel = computed(() => `${cfgForm.value.owner}/${cfgForm.value.repo}`);

const testing = ref(false);
const testMsg = ref('');
const testOk = ref<boolean | null>(null);

/** 页面加载：回填仓库信息（用于展示）与 token「已配置」状态（不回填明文）。 */
async function loadCfgIntoForm(): Promise<void> {
  const cfg = await loadConfig();
  cfgForm.value = {
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch,
    path: cfg.path,
    token: '', // 永不回填明文
  };
  tokenConfigured.value = await hasToken();
  lastBackupAt.value = await getLastBackupAt();
}

/** 配置是否完整到可以发请求（仓库来自内置常量，故只需 token 已存或本次已输入）。 */
const cfgReady = computed(
  () => tokenConfigured.value || !!cfgForm.value.token.trim(),
);

async function saveCloudConfig(): Promise<void> {
  if (savingCfg.value) return;
  savingCfg.value = true;
  cfgMsg.value = '';
  cfgError.value = '';
  try {
    // 仓库四项沿用已加载值（内置默认或本机已存），只有 token 由用户在此输入。
    await saveConfig({
      owner: cfgForm.value.owner,
      repo: cfgForm.value.repo,
      branch: cfgForm.value.branch,
      path: cfgForm.value.path,
      token: cfgForm.value.token, // 留空则保留原 token
    });
    if (cfgForm.value.token.trim()) tokenConfigured.value = true;
    cfgForm.value.token = ''; // 清空输入框，避免明文停留
    cfgMsg.value = 'Token 已保存。';
  } catch (e) {
    cfgError.value = `保存失败：${friendlyError(e)}`;
  } finally {
    savingCfg.value = false;
  }
}

/** 用当前表单（token 缺省时取已存）拼出请求配置。 */
async function resolveConfig(): Promise<GithubConfig> {
  const stored = await loadConfig();
  return {
    owner: cfgForm.value.owner.trim() || stored.owner,
    repo: cfgForm.value.repo.trim() || stored.repo,
    branch: cfgForm.value.branch.trim() || stored.branch,
    path: cfgForm.value.path.trim() || stored.path,
    token: cfgForm.value.token.trim() || stored.token,
  };
}

async function testConn(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  testMsg.value = '';
  testOk.value = null;
  try {
    const cfg = await resolveConfig();
    const res = await testGithubConnection(cfg);
    testOk.value = res.ok;
    testMsg.value = res.message;
  } catch (e) {
    testOk.value = false;
    testMsg.value = friendlyError(e);
  } finally {
    testing.value = false;
  }
}

// ---------- 卡片 C：备份到云端 / 从云端恢复 ----------
const lastBackupAt = ref<number | null>(null);

const backingUp = ref(false);
const backupMsg = ref('');
const backupError = ref('');

function fmtTime(ms: number | null): string {
  if (!ms) return '从未';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const lastBackupText = computed(() => fmtTime(lastBackupAt.value));

async function doBackup(): Promise<void> {
  if (backingUp.value) return;
  backupMsg.value = '';
  backupError.value = '';
  if (!cfgReady.value) {
    backupError.value = '请先配置 Token。';
    return;
  }
  backingUp.value = true;
  try {
    const cfg = await resolveConfig();
    const res = await backupToCloud(cfg, getAdapter());
    lastBackupAt.value = res.at;
    backupMsg.value = `已备份到云端：账户 ${res.counts.account} · 分类 ${res.counts.category} · 交易 ${res.counts.txn}。`;
  } catch (e) {
    backupError.value = friendlyError(e);
  } finally {
    backingUp.value = false;
  }
}

// 恢复：取快照 → 预览 → 二次确认 → 写回。
const restoreState = ref<'idle' | 'fetching' | 'confirm' | 'restoring'>('idle');
const restoreMsg = ref('');
const restoreError = ref('');
const cloudSnapshot = ref<BackupSnapshot | null>(null);
const cloudCounts = ref<SnapshotCounts | null>(null);

async function startRestore(): Promise<void> {
  if (restoreState.value === 'fetching' || restoreState.value === 'restoring') return;
  restoreMsg.value = '';
  restoreError.value = '';
  cloudSnapshot.value = null;
  cloudCounts.value = null;
  if (!cfgReady.value) {
    restoreError.value = '请先配置 Token。';
    return;
  }
  restoreState.value = 'fetching';
  try {
    const cfg = await resolveConfig();
    const res = await fetchCloudSnapshot(cfg, getAdapter());
    if (!res.ok || !res.snapshot || !res.counts) {
      restoreError.value = res.error ?? '拉取失败。';
      restoreState.value = 'idle';
      return;
    }
    cloudSnapshot.value = res.snapshot;
    cloudCounts.value = res.counts;
    restoreState.value = 'confirm'; // 打开二次确认弹层
  } catch (e) {
    restoreError.value = friendlyError(e);
    restoreState.value = 'idle';
  }
}

function cancelRestore(): void {
  if (restoreState.value === 'restoring') return;
  restoreState.value = 'idle';
  cloudSnapshot.value = null;
  cloudCounts.value = null;
}

async function confirmRestore(): Promise<void> {
  const snap = cloudSnapshot.value;
  if (!snap || restoreState.value === 'restoring') return;
  restoreState.value = 'restoring';
  restoreError.value = '';
  try {
    await restoreFromSnapshot(snap, getAdapter());
    restoreMsg.value = '恢复完成，本机数据已被云端快照覆盖。';
    restoreState.value = 'idle';
    cloudSnapshot.value = null;
    cloudCounts.value = null;
  } catch (e) {
    restoreError.value = `恢复失败，已回滚，未改动本机数据：${friendlyError(e)}`;
    restoreState.value = 'confirm'; // 停在确认态，允许重试/取消
  }
}

// ============================================================
// SQL 控制台（S12）：对本地 SQLite 库执行任意 SQL。
//   - 只读（SELECT/WITH/PRAGMA/EXPLAIN）直接执行、渲染表格；
//   - 含写语句 → 分级二次确认（高危需手输确认词）+ 一键备份联动 → 事务执行。
// 读写判定只靠前端解析首关键词（见 ./sqlConsole），从严：识别不出的当写。
// 所有结果 / 错误一律 {{ }} 文本绑定，绝不 v-html（库里可能存有 XSS 载荷）。
// ============================================================

/** SQL 编辑框内容。 */
const sqlText = ref('');
/** 执行中（防重复点击 / 并发写）。 */
const sqlRunning = ref(false);
/** 执行报错文本（SQLite 原文，纯文本渲染）。 */
const sqlError = ref('');

/** 查询结果：表头（列名，键序即列序）+ 数据行。 */
const sqlColumns = ref<string[]>([]);
const sqlRows = ref<Record<string, unknown>[]>([]);
/** 是否有结果集（区分「查询」与「写操作」两种成功态）。 */
const sqlHasResult = ref(false);
/** 结果区提示文本（如「仅显示前 500 行」「查询成功，0 行」）。 */
const sqlNotice = ref('');
/** 写操作成功后展示「数据已变更，需刷新」提示。 */
const sqlWriteDone = ref(false);

/** 待确认执行的批次（含写语句时进入确认窗）。 */
const sqlPlan = ref<BatchPlan | null>(null);
/** 高危批次需手输的确认词。 */
const sqlConfirmWord = ref('');
const CONFIRM_WORD = 'EXECUTE';
/** 确认窗内「先导出备份」的状态与提示。 */
const sqlBackupExporting = ref(false);
const sqlBackupMsg = ref('');

/** 6 张表名（表结构速查用）。 */
const SQL_TABLES = ['account', 'category', 'txn', 'tag', 'txn_tag', 'setting'] as const;
/** 当前展开查看字段的表名（null = 未展开）。 */
const sqlOpenTable = ref<string | null>(null);
/** 已展开表的字段名列表（动态 PRAGMA 取，与真库一致）。 */
const sqlTableCols = ref<string[]>([]);

/** 常用只读模板（点击填入编辑框、不自动执行）。金额单位是「分」。 */
const SQL_TEMPLATES: { label: string; sql: string }[] = [
  {
    label: '各账户余额',
    sql: `SELECT a.name,
       a.initial_balance
         + COALESCE(SUM(CASE WHEN t.type='income'   AND t.account_id=a.id THEN t.amount END),0)
         - COALESCE(SUM(CASE WHEN t.type='expense'  AND t.account_id=a.id THEN t.amount END),0)
         - COALESCE(SUM(CASE WHEN t.type='transfer' AND t.account_id=a.id THEN t.amount END),0)
         + COALESCE(SUM(CASE WHEN t.type='transfer' AND t.to_account_id=a.id THEN t.amount END),0)
         AS balance_cents
FROM account a LEFT JOIN txn t ON (t.account_id=a.id OR t.to_account_id=a.id)
GROUP BY a.id ORDER BY a.order_num;`,
  },
  {
    label: '最近 50 笔交易',
    sql: `SELECT id,type,amount,account_id,category_id,time,title,note FROM txn ORDER BY time DESC LIMIT 50;`,
  },
  {
    label: '孤儿检查（无分类收支）',
    sql: `SELECT id,type,amount,time,title FROM txn WHERE category_id IS NULL AND type IN ('income','expense');`,
  },
  {
    label: '各表行数',
    sql: `SELECT 'account' AS tbl, COUNT(*) AS n FROM account UNION ALL SELECT 'txn', COUNT(*) FROM txn UNION ALL SELECT 'category', COUNT(*) FROM category UNION ALL SELECT 'tag', COUNT(*) FROM tag;`,
  },
];

/** 把模板 / 表名填入编辑框（不自动执行）。 */
function fillSql(text: string): void {
  sqlText.value = text;
}

/** 展开 / 收起某表的字段速查（动态 PRAGMA table_info）。 */
async function toggleTable(name: string): Promise<void> {
  if (sqlOpenTable.value === name) {
    sqlOpenTable.value = null;
    sqlTableCols.value = [];
    return;
  }
  sqlOpenTable.value = name;
  sqlTableCols.value = [];
  try {
    // 表名来自内部白名单常量，非用户输入，直接内联安全。
    const rows = await getAdapter().all<{ name: string }>(`PRAGMA table_info('${name}')`);
    sqlTableCols.value = rows.map((r) => String(r.name));
  } catch (e) {
    sqlTableCols.value = [];
    sqlError.value = friendlyError(e);
  }
}

/** 清空上一次的结果 / 错误 / 提示。 */
function resetSqlOutput(): void {
  sqlError.value = '';
  sqlColumns.value = [];
  sqlRows.value = [];
  sqlHasResult.value = false;
  sqlNotice.value = '';
  sqlWriteDone.value = false;
}

/** 把一组结果行落到展示态（列序 = 第一行键序）。 */
function showRows(rows: Record<string, unknown>[]): void {
  sqlHasResult.value = true;
  sqlRows.value = rows;
  sqlColumns.value = rows.length > 0 ? Object.keys(rows[0]) : [];
}

/** 点「执行」：判定读写；全只读直接跑，含写则弹确认窗。 */
async function onRunSql(): Promise<void> {
  if (sqlRunning.value) return;
  resetSqlOutput();
  const plan = planBatch(sqlText.value);
  if (plan.statements.length === 0) {
    sqlError.value = '请输入至少一条 SQL 语句。';
    return;
  }
  if (plan.hasWrite) {
    // 含写语句：进入分级确认窗（不在此执行）。
    sqlPlan.value = plan;
    sqlConfirmWord.value = '';
    sqlBackupMsg.value = '';
    return;
  }
  await runReadBatch(plan);
}

/** 执行全只读批次：逐条跑，渲染最后一条结果。 */
async function runReadBatch(plan: BatchPlan): Promise<void> {
  sqlRunning.value = true;
  try {
    const adapter = getAdapter();
    let lastRows: Record<string, unknown>[] = [];
    let limited = false;
    for (const st of plan.statements) {
      const { sql, added } = ensureLimit(st.sql);
      lastRows = await adapter.all(sql);
      limited = added;
    }
    showRows(lastRows);
    if (lastRows.length === 0) {
      sqlNotice.value = '查询成功，0 行。';
    } else if (limited) {
      sqlNotice.value = '仅显示前 500 行（未指定 LIMIT）。';
    }
  } catch (e) {
    resetSqlOutput();
    sqlError.value = friendlyError(e);
  } finally {
    sqlRunning.value = false;
  }
}

/** 关闭确认窗（取消执行）。 */
function cancelSqlConfirm(): void {
  if (sqlRunning.value) return;
  sqlPlan.value = null;
  sqlConfirmWord.value = '';
  sqlBackupMsg.value = '';
  sqlError.value = '';
}

/** 确认窗内「先导出备份再执行」：下载 JSON 快照，但不自动执行 SQL。 */
async function exportBeforeRun(): Promise<void> {
  if (sqlBackupExporting.value) return;
  sqlBackupExporting.value = true;
  sqlBackupMsg.value = '';
  try {
    const text = await buildSnapshotText(getAdapter());
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = localFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    sqlBackupMsg.value = '已导出备份 ✓';
  } catch (e) {
    sqlBackupMsg.value = `备份导出失败：${friendlyError(e)}`;
  } finally {
    sqlBackupExporting.value = false;
  }
}

/** 高危批次是否已满足执行条件（手输确认词精确匹配）。 */
const sqlDangerReady = computed(
  () => !sqlPlan.value?.hasDanger || sqlConfirmWord.value === CONFIRM_WORD,
);

/** 确认执行写批次：整批包一个事务，任一失败整体回滚。 */
async function confirmRunSql(): Promise<void> {
  const plan = sqlPlan.value;
  if (!plan || sqlRunning.value) return;
  if (plan.hasDanger && sqlConfirmWord.value !== CONFIRM_WORD) return;
  sqlRunning.value = true;
  sqlError.value = '';
  try {
    const adapter = getAdapter();
    let lastRead: Record<string, unknown>[] | null = null;
    await adapter.transaction(async (tx) => {
      for (const st of plan.statements) {
        if (st.kind === 'read') {
          lastRead = await tx.all(st.sql);
        } else {
          await tx.run(st.sql);
        }
      }
    });
    // 事务成功：关闭确认窗，展示成功态。
    sqlPlan.value = null;
    sqlConfirmWord.value = '';
    sqlBackupMsg.value = '';
    resetSqlOutput();
    if (lastRead) {
      showRows(lastRead);
    }
    sqlWriteDone.value = true;
  } catch (e) {
    // 失败：停在确认窗，展示错误（整批已回滚）。
    sqlError.value = `执行失败，已回滚，未写入任何数据：${friendlyError(e)}`;
  } finally {
    sqlRunning.value = false;
  }
}

/** 写操作后引导刷新（其它页数据各自查询、不会自动感知变更）。 */
function reloadPage(): void {
  location.reload();
}

/** 单元格值渲染：null / undefined 用灰色 NULL 标识（模板据此判断）。 */
function isNullCell(v: unknown): boolean {
  return v === null || v === undefined;
}

/** 单元格文本（非 null）：一律转成字符串，交由 {{ }} 文本绑定转义。 */
function cellText(v: unknown): string {
  if (typeof v === 'string') return v;
  return String(v);
}

onMounted(() => {
  void loadCfgIntoForm();
});</script>

<template>
  <div class="content">
    <div class="stack gap-4" style="max-width: 720px; margin: 0 auto">
      <!-- ============ 数据导入 ============ -->
      <div class="card">
        <div class="card-head">
          <h3>数据 · 从旧备份导入</h3>
          <span class="faint" style="font-size: 13px">Ivy Wallet 备份 JSON</span>
        </div>

        <div class="card-pad" style="padding-top: 14px">
          <!-- 说明条 -->
          <div class="note-box">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 1px">
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
            </svg>
            <span>
              选择旧应用导出的备份 JSON，先预览将导入的范围，确认后再写入本机数据库。
              <b>借贷、预算、多币种、汇率、旧设置与标签不迁移。</b>
            </span>
          </div>

          <!-- 选文件区 -->
          <div
            class="dropzone"
            :class="{ 'has-file': !!fileName }"
            @click="pickFile"
            @dragover.prevent
            @drop.prevent="onDrop"
          >
            <input
              ref="fileInput"
              type="file"
              accept=".json,application/json"
              style="display: none"
              @change="onFileChange"
            />
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 3v12M8 11l4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
            <div class="dz-main">
              <div class="dz-title">{{ fileName || '点击选择文件，或拖拽到此处' }}</div>
              <div class="dz-sub">仅支持 .json 备份文件</div>
            </div>
            <button class="btn btn-ghost btn-sm" @click.stop="pickFile">选择文件</button>
          </div>

          <!-- 解析错误 -->
          <div v-if="parseError" class="alert error mt-3">{{ parseError }}</div>

          <!-- ===== 预览 ===== -->
          <template v-if="phase === 'previewed' && previewStats">
            <div class="divider" />
            <div class="sec-title" style="font-size: 13px; color: var(--fg-2); margin-bottom: 10px">
              预览 · 将导入的范围（尚未写入）
            </div>
            <div class="grid g-3 stat-row">
              <div class="mini-stat">
                <div class="ms-num num">{{ previewStats.accountCount }}</div>
                <div class="ms-label">账户</div>
              </div>
              <div class="mini-stat">
                <div class="ms-num num">{{ previewStats.categoryCount }}</div>
                <div class="ms-label">分类</div>
              </div>
              <div class="mini-stat">
                <div class="ms-num num">{{ previewStats.txnOk }}</div>
                <div class="ms-label">交易</div>
              </div>
            </div>

            <div class="detail-lines mt-3">
              <div class="dl">
                <span class="dl-k">类型分布</span>
                <span class="dl-v num">
                  支出 {{ previewStats.byType.expense }} · 收入 {{ previewStats.byType.income }} · 转账
                  {{ previewStats.byType.transfer }}
                </span>
              </div>
              <div class="dl">
                <span class="dl-k">无分类交易</span>
                <span class="dl-v num">{{ previewStats.txnNoCategory }}（保留，分类置空）</span>
              </div>
              <div class="dl">
                <span class="dl-k">将跳过</span>
                <span class="dl-v num">{{ previewStats.txnFailed }} 笔非法交易</span>
              </div>
              <div v-if="previewStats.orphanCategories > 0" class="dl">
                <span class="dl-k">孤儿分类</span>
                <span class="dl-v num">{{ previewStats.orphanCategories }}（无归属账户，跳过）</span>
              </div>
            </div>

            <div v-if="importError" class="alert error mt-3">{{ importError }}</div>

            <div class="row gap-3 mt-4">
              <button class="btn btn-ghost" :disabled="importing" @click="reset">重新选择</button>
              <span style="flex: 1" />
              <button class="btn btn-ghost" :disabled="importing" @click="askConfirm('merge')">
                合并导入
              </button>
              <button class="btn btn-primary" :disabled="importing" @click="askConfirm('replace')">
                {{ importing ? '导入中…' : '覆盖导入' }}
              </button>
            </div>
            <div class="faint" style="font-size: 12px; margin-top: 10px; line-height: 1.6">
              <b>覆盖导入</b>会先清空本机现有账户 / 分类 / 交易再写入（结果稳定，推荐）；
              <b>合并导入</b>按原 id 保留、已存在的记录不重复写入。
            </div>
          </template>

          <!-- ===== 结果汇总 ===== -->
          <template v-if="phase === 'done' && resultStats">
            <div class="divider" />
            <div class="alert success">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" style="flex-shrink: 0">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <span>导入完成，数据已写入本机数据库。</span>
            </div>

            <div class="grid g-3 stat-row mt-3">
              <div class="mini-stat">
                <div class="ms-num num">{{ resultStats.accountCount }}</div>
                <div class="ms-label">账户</div>
              </div>
              <div class="mini-stat">
                <div class="ms-num num">{{ resultStats.categoryCount }}</div>
                <div class="ms-label">分类</div>
              </div>
              <div class="mini-stat">
                <div class="ms-num num">{{ resultStats.txnOk }}</div>
                <div class="ms-label">交易</div>
              </div>
            </div>

            <div class="detail-lines mt-3">
              <div class="dl">
                <span class="dl-k">类型分布</span>
                <span class="dl-v num">
                  支出 {{ resultStats.byType.expense }} · 收入 {{ resultStats.byType.income }} · 转账
                  {{ resultStats.byType.transfer }}
                </span>
              </div>
              <div class="dl">
                <span class="dl-k">失败 / 跳过</span>
                <span class="dl-v num">{{ resultStats.txnFailed }} 笔</span>
              </div>
              <div class="dl">
                <span class="dl-k">孤儿分类</span>
                <span class="dl-v num">{{ resultStats.orphanCategories }}</span>
              </div>
              <div class="dl">
                <span class="dl-k">无分类交易</span>
                <span class="dl-v num">{{ resultStats.txnNoCategory }}（分类置空保留）</span>
              </div>
            </div>

            <!-- 失败明细 -->
            <div v-if="failuresToShow.length" class="fail-list mt-3">
              <div class="sec-title" style="font-size: 12px; color: var(--expense)">失败明细</div>
              <div v-for="f in failuresToShow" :key="f.txnId" class="fail-item num">
                {{ f.txnId }} — {{ f.reason }}
              </div>
              <div v-if="moreFailures > 0" class="faint" style="font-size: 12px">
                …另有 {{ moreFailures }} 条
              </div>
            </div>

            <div class="row gap-3 mt-4">
              <button class="btn btn-ghost" @click="reset">再导入一次</button>
              <span style="flex: 1" />
              <button class="btn btn-primary" @click="goOverview">去概览看看</button>
            </div>
          </template>
        </div>
      </div>

      <!-- ============ 云备份 · 本地导出 ============ -->
      <div class="card">
        <div class="card-head">
          <h3>数据 · 本地导出</h3>
          <span class="faint" style="font-size: 13px">JSON 快照</span>
        </div>
        <div class="card-pad" style="padding-top: 14px">
          <div class="detail-lines" style="margin-bottom: 14px">
            <div class="faint" style="font-size: 13px; line-height: 1.6">
              导出一份包含账户 / 分类 / 交易 / 标签 / 关联 / 设置的<b>完整快照</b>（6 张表）。
              快照<b>不含 GitHub 配置与 Token</b>，可安全保存到本地或版本库。
            </div>
          </div>
          <div class="row gap-3">
            <button class="btn btn-primary" :disabled="exporting" @click="exportToFile">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 3v12M8 11l4 4 4-4" />
                <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
              {{ exporting ? '导出中…' : '导出为 JSON 文件' }}
            </button>
            <span v-if="exportMsg" class="faint" style="font-size: 13px">{{ exportMsg }}</span>
          </div>
        </div>
      </div>

      <!-- ============ 云备份 · GitHub 配置 ============ -->
      <div class="card">
        <div class="card-head">
          <h3>云备份 · GitHub 私有仓</h3>
          <span class="faint" style="font-size: 13px">Contents API</span>
        </div>
        <div class="card-pad" style="padding-top: 14px">
          <div class="note-box" style="margin-bottom: 16px">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 1px">
              <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
            </svg>
            <span>
              备份仓库已内置为 <b class="num">{{ repoLabel }}</b>，无需在此配置。
              新设备只需粘贴一次 <b>Token</b> 即可备份 / 恢复。建议使用
              <b>fine-grained PAT</b>，权限最小化（只授予<b>目标单仓</b>的 <b>Contents 读写</b>），便于随时吊销。
              Token 仅存于本机、不写入任何快照。
            </span>
          </div>

          <div class="form-grid">
            <div class="field field-full">
              <label class="field-label">
                Token（Personal Access Token）
                <span v-if="tokenConfigured" class="tag-inline" style="margin-left: 6px">已配置</span>
              </label>
              <input
                v-model="cfgForm.token"
                class="input"
                type="password"
                autocomplete="off"
                :placeholder="tokenConfigured ? '已配置（留空则保留原 Token）' : '粘贴 PAT，仅存本机'"
              />
            </div>
          </div>

          <div v-if="cfgError" class="alert error mt-3">{{ cfgError }}</div>

          <div class="row gap-3 mt-4">
            <button class="btn btn-primary" :disabled="savingCfg" @click="saveCloudConfig">
              {{ savingCfg ? '保存中…' : '保存 Token' }}
            </button>
            <button class="btn btn-ghost" :disabled="testing || !cfgReady" @click="testConn">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
            <span v-if="cfgMsg" class="faint" style="font-size: 13px">{{ cfgMsg }}</span>
          </div>
          <div
            v-if="testMsg"
            class="mt-3"
            :class="testOk ? 'alert success' : 'alert error'"
          >
            {{ testMsg }}
          </div>
        </div>
      </div>

      <!-- ============ 云备份 · 备份 / 恢复 ============ -->
      <div class="card">
        <div class="card-head">
          <h3>云备份 · 备份与恢复</h3>
          <span class="faint" style="font-size: 13px">固定单文件覆盖</span>
        </div>
        <div class="card-pad" style="padding-top: 14px">
          <div class="dl" style="margin-bottom: 14px">
            <span class="dl-k">上次备份</span>
            <span class="dl-v num">{{ lastBackupText }}</span>
          </div>

          <div class="row gap-3 wrap">
            <button class="btn btn-primary" :disabled="backingUp || !cfgReady" @click="doBackup">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 21v-12M8 13l4-4 4 4" />
                <path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />
              </svg>
              {{ backingUp ? '备份中…' : '备份到云端' }}
            </button>
            <button
              class="btn btn-ghost"
              :disabled="restoreState === 'fetching' || restoreState === 'restoring' || !cfgReady"
              @click="startRestore"
            >
              {{ restoreState === 'fetching' ? '拉取中…' : '从云端恢复' }}
            </button>
          </div>

          <div v-if="!cfgReady" class="faint mt-3" style="font-size: 12px">
            需先在上方配置 Token，才能备份或恢复。
          </div>

          <div v-if="backupMsg" class="alert success mt-3">{{ backupMsg }}</div>
          <div v-if="backupError" class="alert error mt-3">{{ backupError }}</div>
          <div v-if="restoreMsg" class="alert success mt-3">
            <span>{{ restoreMsg }}</span>
            <button class="btn btn-ghost btn-sm" style="margin-left: auto" @click="goOverview">去概览</button>
          </div>
          <div v-if="restoreError" class="alert error mt-3">{{ restoreError }}</div>
        </div>
      </div>

      <!-- ============ 数据 · SQL 控制台（S12） ============ -->
      <div class="card">
        <div class="card-head">
          <h3>数据 · SQL 控制台</h3>
          <span class="faint" style="font-size: 13px">直连本地数据库</span>
        </div>
        <div class="card-pad" style="padding-top: 14px">
          <!-- 说明条 -->
          <div class="note-box" style="margin-bottom: 14px">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 1px">
              <path d="M12 9v4M12 17h.01" /><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            <span>
              直接对本地数据库执行 SQL。只读查询直接运行；<b>写操作不可撤销，请谨慎操作</b>，
              执行前会二次确认并可一键导出备份。金额单位为「分」，此处原样显示、不做换算。
            </span>
          </div>

          <!-- 表结构速查 -->
          <div class="sec-title" style="font-size: 12px; color: var(--fg-3); margin-bottom: 8px">表结构速查</div>
          <div class="chip-row">
            <button
              v-for="t in SQL_TABLES"
              :key="t"
              class="chip"
              :class="{ active: sqlOpenTable === t }"
              @click="toggleTable(t)"
            >
              {{ t }}
            </button>
          </div>
          <div v-if="sqlOpenTable" class="cols-box">
            <span class="cols-head">{{ sqlOpenTable }} 字段：</span>
            <button
              v-for="c in sqlTableCols"
              :key="c"
              class="col-chip"
              @click="fillSql(sqlText + c)"
            >
              {{ c }}
            </button>
            <span v-if="sqlTableCols.length === 0" class="faint" style="font-size: 12px">（无字段或读取失败）</span>
          </div>

          <!-- 常用模板 -->
          <div class="sec-title" style="font-size: 12px; color: var(--fg-3); margin: 14px 0 8px">常用查询模板（点击填入编辑框）</div>
          <div class="chip-row">
            <button
              v-for="tpl in SQL_TEMPLATES"
              :key="tpl.label"
              class="chip"
              @click="fillSql(tpl.sql)"
            >
              {{ tpl.label }}
            </button>
          </div>

          <!-- SQL 编辑框 -->
          <textarea
            v-model="sqlText"
            class="sql-input mt-3"
            rows="6"
            spellcheck="false"
            placeholder="例如：SELECT * FROM account"
          />

          <!-- 执行按钮 -->
          <div class="row gap-3 mt-3">
            <button class="btn btn-primary" :disabled="sqlRunning || !sqlText.trim()" @click="onRunSql">
              {{ sqlRunning ? '执行中…' : '执行' }}
            </button>
            <span class="faint" style="font-size: 12px; align-self: center">
              只读语句直接执行；写操作需二次确认。
            </span>
          </div>

          <!-- 结果区 -->
          <div v-if="sqlError" class="alert error mt-3">{{ sqlError }}</div>

          <div v-if="sqlWriteDone" class="alert success mt-3">
            <span>执行成功。数据已变更，其它页面需刷新后生效。</span>
            <button class="btn btn-ghost btn-sm" style="margin-left: auto" @click="reloadPage">刷新页面</button>
          </div>

          <template v-if="sqlHasResult">
            <div v-if="sqlNotice" class="faint mt-3" style="font-size: 12px">{{ sqlNotice }}</div>
            <div v-if="sqlColumns.length" class="table-scroll mt-3">
              <table class="sql-table">
                <thead>
                  <tr>
                    <th v-for="col in sqlColumns" :key="col">{{ col }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(r, i) in sqlRows" :key="i">
                    <td v-for="col in sqlColumns" :key="col">
                      <span v-if="isNullCell(r[col])" class="cell-null">NULL</span>
                      <template v-else>{{ cellText(r[col]) }}</template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ==================== SQL 写操作 · 分级确认弹层 ==================== -->
    <div
      v-if="sqlPlan"
      class="modal-backdrop"
      @click.self="cancelSqlConfirm"
    >
      <div class="modal modal-sm">
        <div class="modal-head"><h3>确认执行 SQL？</h3></div>
        <div class="modal-body">
          <div v-if="sqlPlan.hasDanger" class="alert error" style="margin-bottom: 12px">
            ⚠️ 本批含高危操作。<b class="neg">此操作不可撤销，建议先导出备份</b>。
          </div>
          <p v-else style="color: var(--fg-2); font-size: 14px; line-height: 1.6">
            将执行以下写操作。<b class="neg">此操作不可撤销，建议先导出备份</b>。
          </p>

          <!-- 语句清单 -->
          <div class="stmt-list mt-3">
            <div v-for="(st, i) in sqlPlan.statements" :key="i" class="stmt-item">
              <div class="stmt-tags">
                <span class="tag-kind" :class="st.kind">{{ st.kind === 'read' ? '读' : '写' }}</span>
                <span v-if="st.danger" class="tag-danger">⚠️ 高危</span>
              </div>
              <code class="stmt-sql">{{ st.sql }}</code>
              <div v-if="st.reason" class="stmt-reason">{{ st.reason }}</div>
            </div>
          </div>

          <!-- 一键备份联动 -->
          <div class="row gap-3 mt-3 wrap">
            <button class="btn btn-ghost btn-sm" :disabled="sqlBackupExporting" @click="exportBeforeRun">
              {{ sqlBackupExporting ? '导出中…' : '先导出备份再执行' }}
            </button>
            <span v-if="sqlBackupMsg" class="faint" style="font-size: 12px; align-self: center">{{ sqlBackupMsg }}</span>
          </div>

          <!-- 高危：手输确认词 -->
          <div v-if="sqlPlan.hasDanger" class="field mt-3">
            <label class="field-label">
              高危操作，请手动输入确认词 <b class="num">{{ CONFIRM_WORD }}</b> 后才能执行
            </label>
            <input
              v-model="sqlConfirmWord"
              class="input"
              autocomplete="off"
              spellcheck="false"
              :placeholder="CONFIRM_WORD"
            />
          </div>

          <div v-if="sqlError" class="alert error mt-3">{{ sqlError }}</div>
        </div>
        <div class="modal-foot">
          <span style="flex: 1" />
          <button class="btn btn-ghost" :disabled="sqlRunning" @click="cancelSqlConfirm">取消</button>
          <button
            class="btn btn-danger"
            :disabled="sqlRunning || !sqlDangerReady"
            @click="confirmRunSql"
          >
            {{ sqlRunning ? '执行中…' : '确认执行' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 从云端恢复 · 二次确认弹层 ==================== -->
    <div
      v-if="restoreState === 'confirm' || restoreState === 'restoring'"
      class="modal-backdrop"
      @click.self="cancelRestore"
    >
      <div class="modal modal-sm">
        <div class="modal-head"><h3>确认从云端恢复？</h3></div>
        <div class="modal-body">
          <p style="color: var(--fg-2); font-size: 14px; line-height: 1.6">
            这会<b class="neg">清空并覆盖本机现有的全部数据</b>（账户 / 分类 / 交易 / 标签），
            替换为云端快照内容。<b class="neg">此操作不可撤销</b>，建议先在「本地导出」卡片导出一份备份。
          </p>
          <div v-if="cloudCounts" class="grid g-3 stat-row mt-3">
            <div class="mini-stat">
              <div class="ms-num num">{{ cloudCounts.account }}</div>
              <div class="ms-label">账户</div>
            </div>
            <div class="mini-stat">
              <div class="ms-num num">{{ cloudCounts.category }}</div>
              <div class="ms-label">分类</div>
            </div>
            <div class="mini-stat">
              <div class="ms-num num">{{ cloudCounts.txn }}</div>
              <div class="ms-label">交易</div>
            </div>
          </div>
          <div v-if="cloudCounts" class="dl mt-3">
            <span class="dl-k">标签 / 关联</span>
            <span class="dl-v num">{{ cloudCounts.tag }} · {{ cloudCounts.txn_tag }}</span>
          </div>
          <div v-if="restoreError" class="alert error mt-3">{{ restoreError }}</div>
        </div>
        <div class="modal-foot">
          <span style="flex: 1" />
          <button class="btn btn-ghost" :disabled="restoreState === 'restoring'" @click="cancelRestore">
            取消
          </button>
          <button class="btn btn-danger" :disabled="restoreState === 'restoring'" @click="confirmRestore">
            {{ restoreState === 'restoring' ? '恢复中…' : '清空并恢复' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 二次确认弹层 ==================== -->
    <div v-if="confirmMode" class="modal-backdrop" @click.self="confirmMode = null">
      <div class="modal modal-sm">
        <div class="modal-head"><h3>{{ confirmTitle }}</h3></div>
        <div class="modal-body">
          <p v-if="confirmMode === 'replace'" style="color: var(--fg-2); font-size: 14px; line-height: 1.6">
            这会<b class="neg">清空本机现有的全部账户、分类与交易</b>，再写入本次预览的
            <b class="num">{{ previewStats?.accountCount }}</b> 账户 /
            <b class="num">{{ previewStats?.categoryCount }}</b> 分类 /
            <b class="num">{{ previewStats?.txnOk }}</b> 交易。此操作不可撤销。
          </p>
          <p v-else style="color: var(--fg-2); font-size: 14px; line-height: 1.6">
            将按原 id 合并写入本次预览的数据，已存在的同 id 记录会原样保留、不重复写入。
            现有其它数据不会被清空。
          </p>
        </div>
        <div class="modal-foot">
          <span style="flex: 1" />
          <button class="btn btn-ghost" @click="confirmMode = null">取消</button>
          <button
            class="btn"
            :class="confirmMode === 'replace' ? 'btn-danger' : 'btn-primary'"
            @click="runImport"
          >
            {{ confirmMode === 'replace' ? '清空并导入' : '合并导入' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 说明条：与设计稿 primary-soft 提示块一致。 */
.note-box {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--primary-soft);
  color: var(--primary);
  border-radius: var(--r-md);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
}
.note-box b {
  font-weight: 700;
}

/* 选文件拖拽区 */
.dropzone {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
  padding: 18px;
  border: 1.5px dashed var(--border);
  border-radius: var(--r-lg);
  cursor: pointer;
  color: var(--fg-2);
  transition:
    border-color 0.12s,
    background 0.12s;
}
.dropzone:hover {
  border-color: var(--primary);
  background: var(--surface-2);
}
.dropzone.has-file {
  border-style: solid;
  border-color: var(--primary);
}
.dz-main {
  flex: 1;
  min-width: 0;
}
.dz-title {
  font-weight: 700;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dz-sub {
  font-size: 12px;
  color: var(--fg-3);
  margin-top: 2px;
}

/* 提示条 */
.alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--r-md);
  font-size: 13px;
  line-height: 1.5;
}
.alert.error {
  background: var(--expense-soft);
  color: var(--expense);
}
.alert.success {
  background: var(--income-soft);
  color: var(--income);
}

/* 迷你统计卡（预览/汇总三格） */
.stat-row {
  gap: 12px;
}
.mini-stat {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: 14px 12px;
  text-align: center;
}
.ms-num {
  font-size: 24px;
  font-weight: 800;
  color: var(--fg);
}
.ms-label {
  font-size: 12px;
  color: var(--fg-3);
  margin-top: 2px;
}

/* 明细行 */
.detail-lines {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dl {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 13px;
}
.dl-k {
  color: var(--fg-3);
}
.dl-v {
  color: var(--fg-2);
  font-weight: 600;
}

/* 失败明细 */
.fail-list {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.fail-item {
  font-size: 12px;
  color: var(--fg-2);
  word-break: break-all;
}

/* 云备份配置表单：两列自适应，token 独占整行 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 14px;
}
.field {
  min-width: 0;
}
.field-full {
  grid-column: 1 / -1;
}

/* 弹层（与 Accounts.vue 保持一致的视觉） */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(16, 24, 40, 0.32);
  display: grid;
  place-items: center;
  padding: 20px;
}
.modal {
  width: 100%;
  max-width: 440px;
  background: var(--surface);
  border-radius: var(--r-xl);
  box-shadow: var(--sh-3);
  overflow: hidden;
}
.modal-sm {
  max-width: 380px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-head h3 {
  font-size: var(--fs-h3);
  font-weight: 700;
}
.modal-body {
  padding: 18px 20px;
}
.modal-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

/* ============================================================
   SQL 控制台（S12）
   ============================================================ */
/* chips 行（表结构速查 / 模板） */
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--fg-2);
  cursor: pointer;
  transition:
    border-color 0.12s,
    color 0.12s,
    background 0.12s;
}
.chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.chip.active {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-soft);
}

/* 字段速查框 */
.cols-box {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--surface-2);
  border-radius: var(--r-md);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.cols-head {
  font-size: 12px;
  color: var(--fg-3);
  margin-right: 4px;
}
.col-chip {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--r-sm, 6px);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg-2);
  cursor: pointer;
}
.col-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* SQL 编辑框 */
.sql-input {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.6;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--fg);
  resize: vertical;
  min-height: 120px;
}
.sql-input:focus {
  outline: none;
  border-color: var(--primary);
}

/* 结果表格：横向可滚动，不撑破布局 */
.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  -webkit-overflow-scrolling: touch;
}
.sql-table {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
  font-size: 12px;
}
.sql-table th,
.sql-table td {
  border-bottom: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
  color: var(--fg-2);
  vertical-align: top;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sql-table th {
  background: var(--surface-2);
  color: var(--fg);
  font-weight: 700;
  position: sticky;
  top: 0;
}
.sql-table tbody tr:last-child td {
  border-bottom: none;
}
.cell-null {
  color: var(--fg-3);
  font-style: italic;
}

/* 确认窗内语句清单 */
.stmt-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 240px;
  overflow-y: auto;
}
.stmt-item {
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: 8px 10px;
}
.stmt-tags {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
}
.tag-kind {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
}
.tag-kind.read {
  background: var(--primary-soft);
  color: var(--primary);
}
.tag-kind.write {
  background: var(--expense-soft);
  color: var(--expense);
}
.tag-danger {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--expense-soft);
  color: var(--expense);
}
.stmt-sql {
  display: block;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--fg-2);
  white-space: pre-wrap;
  word-break: break-all;
}
.stmt-reason {
  font-size: 11px;
  color: var(--expense);
  margin-top: 4px;
}

@media (max-width: 900px) {
  .grid.g-3.stat-row {
    grid-template-columns: repeat(3, 1fr);
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
}

/* ============================================================
   手机端（≤720px）：单列表单已居中铺满（max-width:720px 容器天然自适应）；
   此处补齐弹层不溢出、统计三卡在极窄屏收紧。不改任何导入/导出/备份逻辑。
   ============================================================ */
@media (max-width: 720px) {
  /* 弹层近满宽居中，不超出视口 */
  .modal {
    width: calc(100vw - 32px);
    max-width: 440px;
  }

  /* 统计三卡在极窄屏字号收紧，避免数字换行溢出 */
  .stat-row .ms-num {
    font-size: var(--fs-h3);
  }
}

</style>
