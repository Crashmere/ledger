<script setup lang="ts">
// ============================================================
// Accounts.vue —— 账户 / 分类 / 标签 管理 + 账户页（S4 · Priority 3）
// ============================================================
// 对照 设计稿/accounts.html 桌面双栏还原：
//   顶部「账户 / 标签」次级 tab（页面内状态，不新增路由）。
//   账户视图（双栏）：
//     左 = 账户列表（选中态 + 拖拽排序 + 新建）；
//     右 = 选中账户详情三卡：①头部色块卡（余额 + 本月流入/流出）
//          ②账户内分类网格（增/改/删/排序，accountId 固定当前账户）
//          ③该账户交易明细（按日期分组，复用概览的符号/色逻辑）。
//   标签视图：全局标签 CRUD（标签不归属账户，故单独一个 tab）。
//
// 红线：
//   ② 分类归属账户：右栏分类只列当前选中账户，新建分类 accountId 固定当前账户。
//   ③ 转账账户内计入：账户明细里"转入本账户"的转账也出现（query 已用
//      account_id OR to_account_id 命中）；本月流入/流出必须含转账。
//   ⑤ 界面不出现"记账人/成员/协作/TA"字样。
//   删除连锁三分支（本阶段核心）：
//     · 删账户 = RESTRICT：AccountService.remove 抛 AppError('RESTRICT')，
//       try/catch 判 code 后友好提示，不当崩溃。
//     · 删分类 = SET NULL：交易保留、分类置空。删前二次确认。
//     · 删标签 = CASCADE：关联清除、交易保留。删前二次确认。
//
// 口径要点（坑位）：
//   · 本月流入/流出【禁用 summary】（summary 排除转账），用 TxnService.query
//     取本月该账户交易后前端聚合：流入 = income + 转入本账户的 transfer；
//     流出 = expense + 从本账户转出的 transfer。
//   · 月份边界与 S3 一致：timeTo = 次月1号00:00 − 1ms（服务层 time <= ? 闭区间）。
//   · 颜色是 ARGB 整数，渲染取低 24 位（复用 argbToCss）；表单选色转回整数存。
//   · 金额一律 Cents，展示只经 money.format，禁手写 /100。
//   · 只写页面层：不改 src/services/** 与 src/db/**，服务层只当消费方调用。
// ============================================================
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  accountService,
  categoryService,
  tagService,
  txnService,
  yuanToCents,
  centsToYuan,
  format,
  AppError,
  type Account,
  type Category,
  type Tag,
  type TxnWithTags,
  type Id,
} from '../services';

// ---------- 次级 tab ----------
const tab = ref<'accounts' | 'tags'>('accounts');

const router = useRouter();
const route = useRoute();

/**
 * 选中账户 + 分类筛选写入 URL query（?account=..&cat=..），使「点交易进编辑页 →
 *   router.back() 返回」后筛选与选中账户自动恢复（组件重挂载时从 query 读回）。
 *   用 replace 不 push：账户页内切换不该在历史里堆条目，否则会污染编辑页的 back()。
 *   值为 null 时删除对应 query 键，保持 URL 干净。
 */
function syncQuery(): void {
  const q: Record<string, string> = {};
  if (selectedAccountId.value) q.account = selectedAccountId.value;
  if (categoryFilterId.value) q.cat = categoryFilterId.value;
  void router.replace({ query: q });
}

/** 点该账户明细里的流水行 → 进入编辑该笔（方案 A：复用 AddTxn 表单）。转账行同样可编辑。 */
function openEdit(id: Id): void {
  void router.push(`/txn/${id}/edit`);
}

// ---------- 本月区间（当前自然月，边界同 S3：timeTo = 次月1号 − 1ms） ----------
const now = new Date();
const timeFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
const timeTo = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).getTime() - 1;

// ---------- 数据源 ----------
const accounts = ref<Account[]>([]);
const balanceById = ref<Map<Id, number>>(new Map());
const categoriesByAccount = ref<Map<Id, Category[]>>(new Map());
const categoryById = ref<Map<Id, Category>>(new Map());
const tags = ref<Tag[]>([]);

const selectedAccountId = ref<Id | null>(null);
const selectedCategories = ref<Category[]>([]); // 右栏分类网格（可拖拽重排）
const monthTxns = ref<TxnWithTags[]>([]); // 本月该账户相关交易（算流入/流出、分类小计）
const allTxns = ref<TxnWithTags[]>([]); // 该账户全部交易（明细列表）
const categoryFilterId = ref<Id | null>(null); // 明细按分类筛选（null = 全部）；点分类网格切换

// ---------- UI 状态 ----------
type Modal = { kind: 'account' | 'category' | 'tag'; mode: 'create' | 'edit'; id?: Id } | null;
const modal = ref<Modal>(null);
const saving = ref(false);

// 表单字段（新建/编辑共用）
const DEFAULT_COLOR = hexToArgb('#1a73e8');
const fName = ref('');
const fColor = ref<number>(DEFAULT_COLOR);
// 随机色：色板第一枚「随机」芯片当前展示/可被选中的颜色（ARGB 整数）。
const randomColor = ref<number>(DEFAULT_COLOR);
const fInitialBalance = ref('0'); // 元字符串，仅账户用
const fIncludeInBalance = ref(true); // 仅账户用
// 专项账户表单字段（仅 account 且 kind=project 时有意义）
const fKind = ref<'normal' | 'project'>('normal');
const fPeriodStart = ref(''); // yyyy-mm-dd（可空）
const fPeriodEnd = ref(''); // yyyy-mm-dd（可空）
const fArchived = ref(false); // 是否已归档（结束）

// 预设色板（来自设计 token）；存储为 ARGB 整数。
const COLOR_PRESETS = [
  '#1a73e8', '#1e8e3e', '#d93025', '#f29900',
  '#9334e6', '#00acc1', '#ff7043', '#6c5ce7',
  '#34a853', '#ea4335', '#4285f4', '#fbbc05',
];

// 二次确认弹层
interface ConfirmState {
  title: string;
  message: string;
  confirmText: string;
  onConfirm: () => void | Promise<void>;
}
const confirmState = ref<ConfirmState | null>(null);

// 轻提示 toast
const feedback = ref<{ kind: 'success' | 'error'; msg: string } | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

// 拖拽排序临时态
const drag = ref<{ kind: 'account' | 'category'; index: number } | null>(null);

// ============================================================
// 计算属性
// ============================================================
const selectedAccount = computed(
  () => accounts.value.find((a) => a.id === selectedAccountId.value) ?? null,
);

/** 普通账户（列表主区）：kind !== 'project'。 */
const normalAccounts = computed(() => accounts.value.filter((a) => a.kind !== 'project'));
/** 专项账户（独立分区）：kind === 'project'。 */
const projectAccounts = computed(() => accounts.value.filter((a) => a.kind === 'project'));

/** 当前选中账户是否专项账户（决定右栏是否显示时间段/归档信息）。 */
const isProjectSelected = computed(() => selectedAccount.value?.kind === 'project');

/** 把 epoch ms 格式化成 yyyy-mm-dd（本地时区）用于展示与 date input 回填。 */
function fmtDateInput(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 把 date input 的 yyyy-mm-dd 解析为当天本地零点 epoch ms；空串 → null。 */
function parseDateInput(s: string): number | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
/** 专项账户时间段的可读展示（卡头副标题用）。 */
function periodText(a: Account): string {
  const s = a.periodStart !== null ? fmtDateInput(a.periodStart) : '';
  const e = a.periodEnd !== null ? fmtDateInput(a.periodEnd) : '';
  if (s && e) return `${s} ~ ${e}`;
  if (s) return `${s} 起`;
  if (e) return `截至 ${e}`;
  return '未设时间段';
}

/** 卡头「总额」：只累加 includeInBalance=true 的账户余额（false 的仍在列表但不计入）。 */
const totalBalance = computed(() => {
  let sum = 0;
  for (const a of accounts.value) {
    if (a.includeInBalance) sum += balanceById.value.get(a.id) ?? 0;
  }
  return sum;
});

/** 本月流入/流出（含转账，禁用 summary）：对 monthTxns 前端聚合。 */
const monthFlow = computed(() => {
  const id = selectedAccountId.value;
  let inflow = 0;
  let outflow = 0;
  if (!id) return { inflow, outflow };
  for (const t of monthTxns.value) {
    if (t.type === 'income' && t.accountId === id) inflow += t.amount;
    else if (t.type === 'expense' && t.accountId === id) outflow += t.amount;
    else if (t.type === 'transfer') {
      if (t.toAccountId === id) inflow += t.amount; // 转入本账户 = 流入
      if (t.accountId === id) outflow += t.amount; // 从本账户转出 = 流出
    }
  }
  return { inflow, outflow };
});

const modalTitle = computed(() => {
  const m = modal.value;
  if (!m) return '';
  const noun =
    m.kind === 'account'
      ? fKind.value === 'project'
        ? '专项账户'
        : '账户'
      : m.kind === 'category'
        ? '分类'
        : '标签';
  return `${m.mode === 'create' ? '新建' : '编辑'}${noun}`;
});

// ============================================================
// 加载
// ============================================================
/** 账户列表 + 各账户余额 + 各账户分类（供左栏计数 & 明细分类映射）。 */
async function reloadAccounts(): Promise<void> {
  accounts.value = await accountService.list();

  const balMap = new Map<Id, number>();
  const catMap = new Map<Id, Category[]>();
  const catByIdMap = new Map<Id, Category>();
  for (const acc of accounts.value) {
    balMap.set(acc.id, await accountService.balance(acc.id));
    const cats = await categoryService.listByAccount(acc.id);
    catMap.set(acc.id, cats);
    for (const c of cats) catByIdMap.set(c.id, c);
  }
  balanceById.value = balMap;
  categoriesByAccount.value = catMap;
  categoryById.value = catByIdMap;

  // 选中态兜底：无选中或选中已被删除时，回到第一个账户。
  if (!accounts.value.some((a) => a.id === selectedAccountId.value)) {
    selectedAccountId.value = accounts.value[0]?.id ?? null;
  }
}

/** 选中账户详情：本月交易（流入/流出、分类小计）+ 全部交易（明细）+ 分类网格。 */
async function reloadDetail(): Promise<void> {
  const id = selectedAccountId.value;
  if (!id) {
    selectedCategories.value = [];
    monthTxns.value = [];
    allTxns.value = [];
    return;
  }
  selectedCategories.value = categoriesByAccount.value.get(id) ?? [];
  monthTxns.value = await txnService.query({ accountIds: [id], timeFrom, timeTo });
  allTxns.value = await txnService.query({ accountIds: [id], sortBy: 'time', sortDir: 'desc' });
}

async function reloadTags(): Promise<void> {
  tags.value = await tagService.list();
}

async function selectAccount(id: Id): Promise<void> {
  selectedAccountId.value = id;
  categoryFilterId.value = null; // 切换账户清空明细的分类筛选
  syncQuery();
  await reloadDetail();
}

/** 点分类网格：切换明细筛选。再次点击已选分类则取消筛选。 */
function toggleCategoryFilter(catId: Id): void {
  categoryFilterId.value = categoryFilterId.value === catId ? null : catId;
  syncQuery();
}

onMounted(async () => {
  // 从 URL query 预置选中账户：reloadAccounts 内的存在性兜底会校验其有效性
  //（query 账户已被删/不存在 → 自动回退到第一个账户）。
  const qAccount = route.query.account;
  if (typeof qAccount === 'string' && qAccount) selectedAccountId.value = qAccount;

  await reloadAccounts();
  await reloadTags();

  // 恢复分类筛选：仅当该分类确属当前选中账户时才生效（防串账户/已删分类）。
  const qCat = route.query.cat;
  if (typeof qCat === 'string' && qCat && selectedAccountId.value) {
    const cats = categoriesByAccount.value.get(selectedAccountId.value) ?? [];
    if (cats.some((c) => c.id === qCat)) categoryFilterId.value = qCat;
  }

  await reloadDetail();
  // query 里可能残留失效的 account/cat（已删除等）→ 用兜底后的真实状态回写，保持 URL 一致。
  syncQuery();
  window.addEventListener('keydown', onGlobalKeydown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
});

// 桌面键盘：Esc 分层关闭最上层弹层——先关二次确认（confirmState），
//   再关新建/编辑弹窗（modal）。均不触发页面返回（本页不需要）。
//   输入框/文本域聚焦时也允许 Esc 关闭（弹窗内 name 输入很常见），
//   但其余键在输入态一律放行，避免抢字符输入。
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  if (confirmState.value) {
    confirmState.value = null;
    e.preventDefault();
  } else if (modal.value) {
    closeModal();
    e.preventDefault();
  }
}

// ============================================================
// 拖拽排序（原生 HTML5 drag，无新依赖）
// ============================================================
function onDragStart(kind: 'account' | 'category', index: number): void {
  drag.value = { kind, index };
}

async function onDrop(kind: 'account' | 'category', index: number): Promise<void> {
  const d = drag.value;
  drag.value = null;
  if (!d || d.kind !== kind || d.index === index) return;

  if (kind === 'account') {
    // 左栏只对普通账户开放拖拽；索引基于 normalAccounts。重排后与专项账户拼回
    // 完整顺序（专项保持原相对次序）一起 reorder，避免 order_num 混乱。
    const normals = normalAccounts.value.slice();
    const [moved] = normals.splice(d.index, 1);
    normals.splice(index, 0, moved);
    const orderedIds = [...normals, ...projectAccounts.value].map((a) => a.id);
    // 本地即时反映（accounts 需与新顺序一致，computed 会重新过滤出两个分区）。
    const byId = new Map(accounts.value.map((a) => [a.id, a]));
    accounts.value = orderedIds.map((id) => byId.get(id)!);
    await accountService.reorder(orderedIds);
  } else {
    const accId = selectedAccountId.value;
    if (!accId) return;
    const arr = selectedCategories.value.slice();
    const [moved] = arr.splice(d.index, 1);
    arr.splice(index, 0, moved);
    selectedCategories.value = arr;
    categoriesByAccount.value.set(accId, arr);
    await categoryService.reorder(accId, arr.map((c) => c.id));
  }
}

// ============================================================
// 表单：打开 / 保存
// ============================================================
function openAccountCreate(): void {
  fName.value = '';
  randomColor.value = makeRandomColor();
  fColor.value = randomColor.value; // 默认选中随机色
  fInitialBalance.value = '0';
  fIncludeInBalance.value = true;
  fKind.value = 'normal';
  fPeriodStart.value = '';
  fPeriodEnd.value = '';
  fArchived.value = false;
  modal.value = { kind: 'account', mode: 'create' };
}
/** 新建专项账户：预置 kind=project、默认不计入总额（自成小账本）。 */
function openProjectCreate(): void {
  fName.value = '';
  randomColor.value = makeRandomColor();
  fColor.value = randomColor.value; // 默认选中随机色
  fInitialBalance.value = '0';
  fIncludeInBalance.value = false; // 专项默认不计入左栏总额
  fKind.value = 'project';
  fPeriodStart.value = '';
  fPeriodEnd.value = '';
  fArchived.value = false;
  modal.value = { kind: 'account', mode: 'create' };
}
function openAccountEdit(acc: Account): void {
  fName.value = acc.name;
  randomColor.value = makeRandomColor(); // 备一枚随机色供重选，但保持原色选中
  fColor.value = acc.color;
  fInitialBalance.value = centsToYuan(acc.initialBalance);
  fIncludeInBalance.value = acc.includeInBalance;
  fKind.value = acc.kind === 'project' ? 'project' : 'normal';
  fPeriodStart.value = fmtDateInput(acc.periodStart);
  fPeriodEnd.value = fmtDateInput(acc.periodEnd);
  fArchived.value = acc.archivedAt !== null;
  modal.value = { kind: 'account', mode: 'edit', id: acc.id };
}
function openCategoryCreate(): void {
  fName.value = '';
  randomColor.value = makeRandomColor();
  fColor.value = randomColor.value; // 默认选中随机色
  modal.value = { kind: 'category', mode: 'create' };
}
function openCategoryEdit(cat: Category): void {
  fName.value = cat.name;
  randomColor.value = makeRandomColor();
  fColor.value = cat.color;
  modal.value = { kind: 'category', mode: 'edit', id: cat.id };
}
function openTagCreate(): void {
  fName.value = '';
  randomColor.value = makeRandomColor();
  fColor.value = randomColor.value; // 默认选中随机色
  modal.value = { kind: 'tag', mode: 'create' };
}
function openTagEdit(t: Tag): void {
  fName.value = t.name;
  randomColor.value = makeRandomColor();
  fColor.value = t.color;
  modal.value = { kind: 'tag', mode: 'edit', id: t.id };
}
function closeModal(): void {
  modal.value = null;
}

async function saveModal(): Promise<void> {
  const m = modal.value;
  if (!m) return;
  const name = fName.value.trim();
  if (!name) {
    showFeedback('error', '名称不能为空');
    return;
  }

  saving.value = true;
  try {
    if (m.kind === 'account') {
      // 归档时间戳：勾选“已归档”则写当前时间（若原本已归档，编辑分支下方会保留原值优先）。
      const draft = {
        name,
        color: fColor.value,
        initialBalance: yuanToCents(fInitialBalance.value || '0'),
        includeInBalance: fIncludeInBalance.value,
        kind: fKind.value,
        periodStart: parseDateInput(fPeriodStart.value),
        periodEnd: parseDateInput(fPeriodEnd.value),
      };
      if (m.mode === 'create') {
        const created = await accountService.create({
          ...draft,
          archivedAt: fArchived.value ? Date.now() : null,
        });
        await reloadAccounts();
        selectedAccountId.value = created.id;
      } else {
        // 归档标记：未归档→勾选=写入当前时间；已归档保持原值；取消勾选=清空。
        const existing = accounts.value.find((a) => a.id === m.id);
        const archivedAt = fArchived.value
          ? (existing?.archivedAt ?? Date.now())
          : null;
        await accountService.update(m.id!, { ...draft, archivedAt });
        await reloadAccounts();
      }
      await reloadDetail();
    } else if (m.kind === 'category') {
      const accId = selectedAccountId.value;
      if (!accId) {
        showFeedback('error', '请先选择账户');
        return;
      }
      if (m.mode === 'create') {
        await categoryService.create({ accountId: accId, name, color: fColor.value });
      } else {
        await categoryService.update(m.id!, { name, color: fColor.value });
      }
      await reloadAccounts(); // 刷新分类计数/映射
      await reloadDetail();
    } else {
      if (m.mode === 'create') {
        await tagService.create({ name, color: fColor.value });
      } else {
        await tagService.update(m.id!, { name, color: fColor.value });
      }
      await reloadTags();
      await reloadDetail(); // 明细里的标签名可能变化
    }
    closeModal();
    showFeedback('success', '已保存 ✓');
  } catch (e) {
    showFeedback('error', e instanceof AppError ? e.message : '保存失败，请重试');
  } finally {
    saving.value = false;
  }
}

// ============================================================
// 删除三分支（本阶段核心）
// ============================================================
/** 删账户 = RESTRICT：try/catch 判 code 友好提示；空账户才能删成功。 */
function deleteAccount(acc: Account): void {
  confirmState.value = {
    title: '删除账户',
    message: '确定删除该账户？只有没有任何交易和分类的空账户才能删除；若账户下仍有交易或分类，将被拦截。',
    confirmText: '删除账户',
    onConfirm: async () => {
      try {
        await accountService.remove(acc.id);
        closeModal();
        await reloadAccounts();
        await reloadDetail();
        showFeedback('success', '账户已删除');
      } catch (e) {
        if (e instanceof AppError && e.code === 'RESTRICT') {
          showFeedback('error', '该账户下还有交易或分类，请先删除或转移后再删除账户');
        } else {
          showFeedback('error', e instanceof AppError ? e.message : '删除失败，请重试');
        }
      }
    },
  };
}

/** 删分类 = SET NULL：交易保留、分类置空。删前二次确认。 */
function deleteCategory(cat: Category): void {
  confirmState.value = {
    title: '删除分类',
    message: '删除后，该分类下的交易会保留，但将不再有分类（分类显示为空）。确定删除吗？',
    confirmText: '删除分类',
    onConfirm: async () => {
      try {
        await categoryService.remove(cat.id);
        if (categoryFilterId.value === cat.id) categoryFilterId.value = null;
        await reloadAccounts();
        await reloadDetail();
        showFeedback('success', '分类已删除，相关交易保留');
      } catch (e) {
        showFeedback('error', e instanceof AppError ? e.message : '删除失败，请重试');
      }
    },
  };
}

/** 删标签 = CASCADE：关联清除、交易保留。删前二次确认。 */
function deleteTag(t: Tag): void {
  confirmState.value = {
    title: '删除标签',
    message: '删除后，该标签会从所有交易上移除，但交易本身保留。确定删除吗？',
    confirmText: '删除标签',
    onConfirm: async () => {
      try {
        await tagService.remove(t.id);
        await reloadTags();
        await reloadDetail();
        showFeedback('success', '标签已删除，相关交易保留');
      } catch (e) {
        showFeedback('error', e instanceof AppError ? e.message : '删除失败，请重试');
      }
    },
  };
}

async function runConfirm(): Promise<void> {
  const c = confirmState.value;
  if (!c) return;
  confirmState.value = null;
  await c.onConfirm();
}

// ============================================================
// 反馈
// ============================================================
function showFeedback(kind: 'success' | 'error', msg: string): void {
  feedback.value = { kind, msg };
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedback.value = null;
  }, 2400);
}

// ============================================================
// 纯函数工具
// ============================================================
/** #RRGGBB -> 不透明 ARGB 整数（与 seed/服务层一致，用加法避免有符号溢出）。 */
function hexToArgb(hex: string): number {
  const rgb = parseInt(hex.replace('#', ''), 16);
  return 0xff000000 + rgb;
}

/** ARGB 整数（可能是有符号 32 位）转 CSS rgba，用于账户/分类色标（与 Overview/AddTxn 一致）。 */
function argbToCss(argb: number): string {
  const u = argb >>> 0;
  const a = ((u >>> 24) & 0xff) / 255;
  const r = (u >>> 16) & 0xff;
  const g = (u >>> 8) & 0xff;
  const b = u & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a === 0 ? 1 : a})`;
}

/** 判断某预设色是否 = 当前选中色（都归一到 ARGB 整数比较）。 */
function isColorSelected(hex: string): boolean {
  return hexToArgb(hex) === fColor.value;
}

// ---------- 随机色生成 ----------
// 目标：生成的颜色与既有色板「视觉统一」，同时「避免撞上已有颜色」。
// 做法：在 HSL 空间取色——
//   1) 饱和度/明度限定在既有 Material 风格色板的分布带内（S 68-82%、L 46-60%），
//      保证不产生灰调或荧光色，风格与预设一致；
//   2) 色相与「已用色相」（预设色板 + 当前账户/分类/标签在用色）尽量拉开，
//      多次随机采样，取第一个与所有已用色相都相距 ≥ 阈值的候选（保留随机性），
//      都不够远时兜底取「离最近已用色相最远」的那个。
function argbToRgb(argb: number): [number, number, number] {
  const u = argb >>> 0;
  return [(u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff];
}
/** RGB(0-255) → 色相 h(0-360) 与饱和度 s(0-1)（明度用不到，省略）。 */
function rgbToHueSat(r: number, g: number, b: number): { h: number; s: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = (((gn - bn) / d) % 6 + 6) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s };
}
/** HSL(h:0-360, s/l:0-1) → 不透明 ARGB 整数（加法避免 32 位有符号溢出）。 */
function hslToArgb(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return 0xff000000 + (R << 16) + (G << 8) + B;
}
/** 两个色相在色环上的最短夹角（0-180）。 */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
/** 收集当前场景「已用色相」：预设色板 + 现存账户/分类/标签的颜色（忽略近灰色）。 */
function collectUsedHues(): number[] {
  const argbList: number[] = COLOR_PRESETS.map(hexToArgb);
  for (const a of accounts.value) argbList.push(a.color);
  for (const c of categoryById.value.values()) argbList.push(c.color);
  for (const t of tags.value) argbList.push(t.color);
  const hues: number[] = [];
  for (const argb of argbList) {
    const [r, g, b] = argbToRgb(argb);
    const { h, s } = rgbToHueSat(r, g, b);
    if (s > 0.15) hues.push(h); // 近灰色的色相无意义，跳过
  }
  return hues;
}
/** 生成一枚与色板统一、且尽量不撞已有色的随机颜色（ARGB 整数）。 */
function makeRandomColor(): number {
  const used = collectUsedHues();
  const MIN_GAP = 24; // 与任一已用色相至少相隔 24°
  let hue = Math.random() * 360;
  let bestGap = -1;
  for (let i = 0; i < 32; i++) {
    const h = Math.random() * 360;
    let nearest = 360;
    for (const u of used) nearest = Math.min(nearest, hueGap(h, u));
    if (nearest >= MIN_GAP) {
      hue = h; // 第一个够远的随机候选即采用，保持随机性
      bestGap = nearest;
      break;
    }
    if (nearest > bestGap) {
      bestGap = nearest; // 兜底：都不够远时取离最近已用色相最远者
      hue = h;
    }
  }
  const s = 0.68 + Math.random() * 0.14; // 68%-82%
  const l = 0.46 + Math.random() * 0.14; // 46%-60%
  return hslToArgb(hue, s, l);
}
/** 重掷随机色并选中它（点击色板首枚「随机」芯片时用）。 */
function rerollRandomColor(): void {
  randomColor.value = makeRandomColor();
  fColor.value = randomColor.value;
}

function accountName(id: Id | null): string {
  if (!id) return '';
  return accounts.value.find((a) => a.id === id)?.name ?? '';
}
function categoryName(id: Id | null): string {
  if (!id) return '';
  return categoryById.value.get(id)?.name ?? '';
}

/** 某分类本月支出小计（分）：从 monthTxns 聚合（只算 expense）。 */
function categoryMonthExpense(catId: Id): number {
  let sum = 0;
  for (const t of monthTxns.value) {
    if (t.type === 'expense' && t.categoryId === catId) sum += t.amount;
  }
  return sum;
}

// ---- 明细：按日期分组（复用概览逻辑） ----
interface DayGroup {
  key: string;
  label: string;
  expense: number;
  income: number;
  items: TxnWithTags[];
}
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 当前筛选的分类对象（用于明细卡头展示 chip）；null = 未筛选。 */
const filteredCategory = computed<Category | null>(() =>
  categoryFilterId.value ? (categoryById.value.get(categoryFilterId.value) ?? null) : null,
);

/** 明细列表数据源：按选中分类过滤（null = 全部）。 */
const filteredTxns = computed<TxnWithTags[]>(() => {
  const cid = categoryFilterId.value;
  if (!cid) return allTxns.value;
  return allTxns.value.filter((t) => t.categoryId === cid);
});

const groups = computed<DayGroup[]>(() => {
  const map = new Map<string, DayGroup>();
  const order: string[] = [];
  for (const t of filteredTxns.value) {
    const d = new Date(t.time);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = map.get(key);
    if (!g) {
      g = { key, label: dayLabel(d), expense: 0, income: 0, items: [] };
      map.set(key, g);
      order.push(key);
    }
    g.items.push(t);
    if (t.type === 'expense') g.expense += t.amount;
    else if (t.type === 'income') g.income += t.amount;
  }
  return order.map((k) => map.get(k)!);
});

function isToday(d: Date): boolean {
  const t = new Date();
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  );
}
function dayLabel(d: Date): string {
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const suffix = isToday(d) ? '今天' : WEEKDAYS[d.getDay()];
  return `${md} · ${suffix}`;
}
function daySummaryText(g: DayGroup): string {
  return `支出 ${format(g.expense)} · 收入 ${format(g.income)}`;
}

/** 交易左侧色块：转账中性靛紫；收支优先分类色、回退账户色。 */
function txnColor(t: TxnWithTags): string {
  if (t.type === 'transfer') return 'var(--transfer)';
  if (t.categoryId) {
    const cat = categoryById.value.get(t.categoryId);
    if (cat) return argbToCss(cat.color);
  }
  const acc = accounts.value.find((a) => a.id === t.accountId);
  return acc ? argbToCss(acc.color) : 'var(--fg-3)';
}
function txnTitle(t: TxnWithTags): string {
  if (t.title && t.title.trim()) return t.title;
  const cat = categoryName(t.categoryId);
  if (cat) return cat;
  if (t.type === 'transfer') return '转账';
  return '(无标题)';
}
/** 副标题：转账「转出 → 转入」；收支「账户 · 分类」（分类删除后置空 → 只剩账户）。 */
function txnSub(t: TxnWithTags): string {
  if (t.type === 'transfer') {
    return `${accountName(t.accountId)} → ${accountName(t.toAccountId)}`;
  }
  const cat = categoryName(t.categoryId);
  return cat ? `${accountName(t.accountId)} · ${cat}` : `${accountName(t.accountId)} · 未分类`;
}
function txnAmountText(t: TxnWithTags): string {
  if (t.type === 'expense') return `−${format(t.amount)}`;
  if (t.type === 'income') return `+${format(t.amount)}`;
  return format(t.amount); // transfer：中性、无正负号
}
function txnAmountClass(t: TxnWithTags): string {
  if (t.type === 'expense') return 'neg';
  if (t.type === 'income') return 'pos';
  return 'tr';
}
</script>

<template>
  <div class="content acc-content">
    <!-- 账户 / 标签 次级 tab：投放到顶栏（与页标题同高、右对齐），页内不再单独占一行。 -->
    <Teleport to="#topbar-slot">
      <div class="subtabs">
        <button class="subtab" :class="{ on: tab === 'accounts' }" @click="tab = 'accounts'">账户</button>
        <button class="subtab" :class="{ on: tab === 'tags' }" @click="tab = 'tags'">标签</button>
      </div>
    </Teleport>

    <!-- ==================== 账户视图（双栏） ==================== -->
    <div v-if="tab === 'accounts'" class="two-col acc-two-col">
      <!-- 左栏：账户列表 -->
      <div class="card acc-list-card">
        <div class="card-head">
          <h3>账户</h3>
          <span class="faint" style="font-size: 13px">
            {{ accounts.length }} 个 · 总额 {{ format(totalBalance) }}
          </span>
        </div>
        <div class="card-pad" style="padding-top: 6px">
          <div
            v-for="(acc, idx) in normalAccounts"
            :key="acc.id"
            class="acc-row"
            :class="{ on: acc.id === selectedAccountId }"
            draggable="true"
            @click="selectAccount(acc.id)"
            @dragstart="onDragStart('account', idx)"
            @dragover.prevent
            @drop="onDrop('account', idx)"
          >
            <span v-if="acc.id === selectedAccountId" class="acc-row-bar" :style="{ background: argbToCss(acc.color) }" />
            <div class="ic-tile sm" :style="{ background: argbToCss(acc.color) }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M3 6h18l-2 13H5z" />
                <path d="M9 6V4h6v2" />
              </svg>
            </div>
            <div class="txn-main">
              <div class="txn-title" style="font-size: 14px">
                {{ acc.name }}
                <span v-if="!acc.includeInBalance" class="badge" style="background: var(--surface-2); color: var(--fg-3); margin-left: 6px">不计入总额</span>
              </div>
              <div class="txn-sub">{{ (categoriesByAccount.get(acc.id) ?? []).length }} 个分类</div>
            </div>
            <div class="num" style="font-weight: 700">{{ format(balanceById.get(acc.id) ?? 0) }}</div>
            <svg class="drag-handle" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--fg-3)" stroke-width="2" aria-label="拖拽排序">
              <circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" />
              <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
              <circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" />
            </svg>
          </div>

          <div v-if="accounts.length === 0" class="empty" style="padding: 24px 12px">
            <div style="font-weight: 700; color: var(--fg-2)">还没有账户</div>
          </div>

          <div class="divider" style="margin: 12px 0" />
          <button class="btn btn-ghost btn-block" style="border-style: dashed; color: var(--fg-2)" @click="openAccountCreate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14" /></svg>
            新建账户
          </button>

          <!-- 专项账户分区：独立于日常账户，统计默认排除。彼此隔离、又聚在一起。 -->
          <div class="proj-section">
            <div class="proj-section-head">
              <span>专项账户</span>
              <span class="faint" style="font-size: 12px; font-weight: 600">不计入统计 · {{ projectAccounts.length }} 个</span>
            </div>
            <div
              v-for="acc in projectAccounts"
              :key="acc.id"
              class="acc-row"
              :class="{ on: acc.id === selectedAccountId }"
              @click="selectAccount(acc.id)"
            >
              <span v-if="acc.id === selectedAccountId" class="acc-row-bar" :style="{ background: argbToCss(acc.color) }" />
              <div class="ic-tile sm" :style="{ background: argbToCss(acc.color) }">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M3 7h18M3 7l2-3h14l2 3M5 7v13h14V7" /><path d="M9 11h6" />
                </svg>
              </div>
              <div class="txn-main">
                <div class="txn-title" style="font-size: 14px">
                  {{ acc.name }}
                  <span v-if="acc.archivedAt !== null" class="badge" style="background: var(--surface-2); color: var(--fg-3); margin-left: 6px">已归档</span>
                </div>
                <div class="txn-sub">{{ periodText(acc) }}</div>
              </div>
              <div class="num" style="font-weight: 700">{{ format(balanceById.get(acc.id) ?? 0) }}</div>
            </div>
            <button class="btn btn-ghost btn-block mt-2" style="border-style: dashed; color: var(--fg-2)" @click="openProjectCreate">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14" /></svg>
              新建专项账户
            </button>
          </div>
        </div>
      </div>

      <!-- 右栏：选中账户详情 -->
      <div v-if="selectedAccount" class="stack gap-4">
        <!-- (a) 账户头部色块卡 -->
        <div
          class="card card-pad acc-hero"
          :style="{ background: `linear-gradient(135deg, ${argbToCss(selectedAccount.color)}, #34a853)` }"
        >
          <div class="row gap-3" style="align-items: flex-start">
            <div class="ic-tile lg" style="background: rgba(255, 255, 255, 0.22)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M3 6h18l-2 13H5z" /><path d="M9 6V4h6v2" />
              </svg>
            </div>
            <div style="flex: 1; min-width: 0">
              <div style="font-size: 13px; opacity: 0.9; font-weight: 600">{{ selectedAccount.name }} · 当前余额</div>
              <div class="num acc-hero-amt">¥{{ format(balanceById.get(selectedAccount.id) ?? 0) }}</div>
              <div v-if="isProjectSelected" style="font-size: 12px; opacity: 0.9; font-weight: 600">
                专项 · {{ periodText(selectedAccount) }}<template v-if="selectedAccount.archivedAt !== null"> · 已归档</template>
              </div>
            </div>
            <button class="btn btn-sm acc-hero-edit" @click="openAccountEdit(selectedAccount)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              编辑
            </button>
          </div>
          <div class="row gap-4 mt-4" style="font-size: 13px; flex-wrap: wrap">
            <span style="opacity: 0.95">本月流入 <b class="num">+{{ format(monthFlow.inflow) }}</b></span>
            <span style="opacity: 0.9">本月流出 <b class="num">−{{ format(monthFlow.outflow) }}</b></span>
          </div>
        </div>

        <!-- (b) 账户内分类网格 -->
        <div class="card">
          <div class="card-head">
            <h3>账户内分类</h3>
            <span class="faint" style="font-size: 13px">{{ selectedAccount.name }} · {{ selectedCategories.length }} 个</span>
          </div>
          <div class="card-pad" style="padding-top: 14px">
            <div v-if="selectedCategories.length" class="grid g-3">
              <div
                v-for="(cat, idx) in selectedCategories"
                :key="cat.id"
                class="cat-item"
                :class="{ 'cat-item-on': categoryFilterId === cat.id }"
                role="button"
                tabindex="0"
                :aria-pressed="categoryFilterId === cat.id"
                :title="categoryFilterId === cat.id ? '点击取消筛选' : '点击只看该分类的交易'"
                draggable="true"
                @click="toggleCategoryFilter(cat.id)"
                @keydown.enter="toggleCategoryFilter(cat.id)"
                @dragstart="onDragStart('category', idx)"
                @dragover.prevent
                @drop="onDrop('category', idx)"
              >
                <div class="ic-tile sm" :style="{ background: argbToCss(cat.color) }">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.6 13.4 12 22l-8.6-8.6a2 2 0 0 1 0-2.8L11 3.4a2 2 0 0 1 1.4-.6H20a2 2 0 0 1 2 2v7.6a2 2 0 0 1-.6 1.4z" />
                    <circle cx="16.5" cy="7.5" r="1.2" />
                  </svg>
                </div>
                <div style="min-width: 0; flex: 1">
                  <div style="font-weight: 600; font-size: 13px" class="ellipsis">{{ cat.name }}</div>
                  <div v-if="categoryMonthExpense(cat.id) > 0" class="num neg" style="font-size: 11px">
                    −{{ format(categoryMonthExpense(cat.id)) }}
                  </div>
                </div>
                <div class="cat-actions">
                  <button class="icon-btn icon-btn-sm" aria-label="编辑分类" @click.stop="openCategoryEdit(cat)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                  </button>
                  <button class="icon-btn icon-btn-sm danger" aria-label="删除分类" @click.stop="deleteCategory(cat)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="faint" style="padding: 6px 0 12px">该账户暂无分类</div>
            <button class="btn btn-ghost btn-block mt-3" style="border-style: dashed; color: var(--fg-2)" @click="openCategoryCreate">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14" /></svg>
              新建分类
            </button>
          </div>
        </div>

        <!-- (c) 该账户交易明细 -->
        <div class="card">
          <div class="card-head">
            <h3>该账户交易明细</h3>
            <button
              v-if="filteredCategory"
              class="filter-chip"
              title="点击清除分类筛选"
              @click="categoryFilterId = null"
            >
              <span class="fc-dot" :style="{ background: argbToCss(filteredCategory.color) }" />
              <span class="ellipsis">{{ filteredCategory.name }}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <span v-else class="faint" style="font-size: 13px">仅显示「{{ selectedAccount.name }}」</span>
          </div>
          <div class="card-pad" style="padding-top: 4px">
            <div v-if="groups.length === 0" class="empty" style="padding: 28px 12px">
              <div v-if="filteredCategory" style="font-weight: 700; color: var(--fg-2)">该分类下暂无交易</div>
              <div v-else style="font-weight: 700; color: var(--fg-2)">该账户还没有交易</div>
            </div>
            <template v-for="g in groups" :key="g.key">
              <div class="day-head">
                <span class="d-date">{{ g.label }}</span>
                <span class="d-sum">{{ daySummaryText(g) }}</span>
              </div>
              <div
                v-for="t in g.items"
                :key="t.id"
                class="txn txn-clickable"
                role="button"
                tabindex="0"
                @click="openEdit(t.id)"
                @keydown.enter="openEdit(t.id)"
              >
                <div class="ic-tile sm" :style="{ background: txnColor(t) }">
                  <svg v-if="t.type === 'expense'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                  <svg v-else-if="t.type === 'income'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3l4 4-4 4M7 21l-4-4 4-4M21 7H8M3 17h13" /></svg>
                </div>
                <div class="txn-main">
                  <div class="txn-title">
                    {{ txnTitle(t) }}
                    <span v-if="t.type === 'transfer'" class="badge badge-transfer" style="margin-left: 6px">转账</span>
                  </div>
                  <div class="txn-sub">
                    {{ txnSub(t) }}
                    <template v-if="t.tags.length">
                      <span class="sep" />
                      <span v-for="tag in t.tags" :key="tag.id" class="tag-inline">{{ tag.name }}</span>
                    </template>
                  </div>
                  <!-- S7.1：有备注时在副标题下方多显示一行（灰色小字，单行省略，悬停看全文） -->
                  <div v-if="t.note && t.note.trim()" class="txn-note" :title="t.note">{{ t.note }}</div>
                </div>
                <div class="txn-amt num" :class="txnAmountClass(t)">{{ txnAmountText(t) }}</div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 右栏空态（无账户时） -->
      <div v-else class="card card-pad empty">
        <div style="font-weight: 700; color: var(--fg-2)">先在左侧新建一个账户</div>
      </div>
    </div>

    <!-- ==================== 标签视图（全局 CRUD） ==================== -->
    <div v-else class="tags-wrap">
      <div class="card">
        <div class="card-head">
          <h3>标签</h3>
          <span class="faint" style="font-size: 13px">{{ tags.length }} 个 · 全局共用</span>
        </div>
        <div class="card-pad" style="padding-top: 8px">
          <div v-for="t in tags" :key="t.id" class="txn tag-row">
            <div class="ic-tile sm" :style="{ background: argbToCss(t.color) }">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20.6 13.4 12 22l-8.6-8.6a2 2 0 0 1 0-2.8L11 3.4a2 2 0 0 1 1.4-.6H20a2 2 0 0 1 2 2v7.6a2 2 0 0 1-.6 1.4z" />
                <circle cx="16.5" cy="7.5" r="1.2" />
              </svg>
            </div>
            <div class="txn-main">
              <div class="txn-title" style="font-size: 14px">{{ t.name }}</div>
            </div>
            <div class="cat-actions" style="opacity: 1">
              <button class="icon-btn icon-btn-sm" aria-label="编辑标签" @click="openTagEdit(t)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </button>
              <button class="icon-btn icon-btn-sm danger" aria-label="删除标签" @click="deleteTag(t)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
              </button>
            </div>
          </div>

          <div v-if="tags.length === 0" class="empty" style="padding: 24px 12px">
            <div style="font-weight: 700; color: var(--fg-2)">还没有标签</div>
          </div>

          <div class="divider" style="margin: 12px 0" />
          <button class="btn btn-ghost btn-block" style="border-style: dashed; color: var(--fg-2)" @click="openTagCreate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14" /></svg>
            新建标签
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 表单弹层（账户/分类/标签共用） ==================== -->
    <div v-if="modal" class="modal-backdrop" @click.self="closeModal">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ modalTitle }}</h3>
          <button class="icon-btn" aria-label="关闭" @click="closeModal">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div class="modal-body">
          <!-- 名称 -->
          <div class="field">
            <label class="field-label">名称</label>
            <input v-model="fName" class="input" placeholder="必填，如：生活费" @keyup.enter="saveModal" />
          </div>

          <!-- 颜色 -->
          <div class="field">
            <label class="field-label">颜色</label>
            <div class="swatches">
              <!-- 首枚：随机色。默认选中；点击可重掷一枚新的随机色。 -->
              <button
                type="button"
                class="swatch swatch-random"
                :class="{ on: fColor === randomColor }"
                :style="{ background: argbToCss(randomColor) }"
                :aria-label="'随机颜色（点击换一个）'"
                title="随机颜色（点击换一个）"
                @click="rerollRandomColor"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" />
                </svg>
              </button>
              <button
                v-for="hex in COLOR_PRESETS"
                :key="hex"
                type="button"
                class="swatch"
                :class="{ on: isColorSelected(hex) }"
                :style="{ background: hex }"
                :aria-label="`颜色 ${hex}`"
                @click="fColor = hexToArgb(hex)"
              />
            </div>
          </div>

          <!-- 账户专属：初始余额 + 计入总额 -->
          <template v-if="modal.kind === 'account'">
            <div class="field">
              <label class="field-label">初始余额（元）</label>
              <input v-model="fInitialBalance" class="input" inputmode="decimal" placeholder="0" />
            </div>
            <div class="field">
              <label class="field-label">计入总额</label>
              <div class="row gap-3">
                <button class="switch" :class="{ on: fIncludeInBalance }" role="switch" :aria-checked="fIncludeInBalance" @click="fIncludeInBalance = !fIncludeInBalance">
                  <span class="knob" />
                </button>
                <span class="faint" style="font-size: 13px">{{ fIncludeInBalance ? '计入左栏总额' : '不计入左栏总额' }}</span>
              </div>
            </div>

            <!-- 专项账户专属：时间段 + 归档。专项账户交易被全局统计排除。 -->
            <template v-if="fKind === 'project'">
              <div class="divider" style="margin: 2px 0" />
              <div class="faint" style="font-size: 12px; line-height: 1.5">
                专项账户用于记录某段时间的特殊开支（如一次旅行），其交易不计入概览/报告等日常统计。
              </div>
              <div class="row gap-3">
                <div class="field" style="flex: 1">
                  <label class="field-label">开始日期</label>
                  <input v-model="fPeriodStart" class="input" type="date" />
                </div>
                <div class="field" style="flex: 1">
                  <label class="field-label">结束日期</label>
                  <input v-model="fPeriodEnd" class="input" type="date" />
                </div>
              </div>
              <div class="field">
                <label class="field-label">已结束（归档）</label>
                <div class="row gap-3">
                  <button class="switch" :class="{ on: fArchived }" role="switch" :aria-checked="fArchived" @click="fArchived = !fArchived">
                    <span class="knob" />
                  </button>
                  <span class="faint" style="font-size: 13px">{{ fArchived ? '已归档：标记该专项已结束' : '进行中' }}</span>
                </div>
              </div>
            </template>
          </template>
        </div>

        <div class="modal-foot">
          <button
            v-if="modal.mode === 'edit' && modal.kind === 'account' && selectedAccount"
            class="btn btn-ghost danger-text"
            @click="deleteAccount(selectedAccount)"
          >
            删除账户
          </button>
          <span style="flex: 1" />
          <span class="kbd-hint" aria-hidden="true"><span class="kbd">Esc</span>取消</span>
          <button class="btn btn-ghost" @click="closeModal">取消</button>
          <button class="btn btn-primary" :disabled="saving || !fName.trim()" @click="saveModal">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ==================== 二次确认弹层 ==================== -->
    <div v-if="confirmState" class="modal-backdrop" @click.self="confirmState = null">
      <div class="modal modal-sm">
        <div class="modal-head"><h3>{{ confirmState.title }}</h3></div>
        <div class="modal-body">
          <p style="color: var(--fg-2); font-size: 14px; line-height: 1.6">{{ confirmState.message }}</p>
        </div>
        <div class="modal-foot">
          <span style="flex: 1" />
          <span class="kbd-hint" aria-hidden="true"><span class="kbd">Esc</span>取消</span>
          <button class="btn btn-ghost" @click="confirmState = null">取消</button>
          <button class="btn btn-danger" @click="runConfirm">{{ confirmState.confirmText }}</button>
        </div>
      </div>
    </div>

    <!-- ==================== toast ==================== -->
    <div v-if="feedback" class="toast" :class="feedback.kind">{{ feedback.msg }}</div>
  </div>
</template>

<style scoped>
/* S7.1：流水行备注（层级低于 .txn-sub 的最次要一行；单行省略，悬停看全文）。
   与 Overview.vue 的 .txn-note 保持一致：--fg-3 叠加 opacity 再淡一级，不硬编码色值。 */
.txn-note {
  font-size: var(--fs-xs);
  color: var(--fg-3);
  opacity: 0.75;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 次级 tab（已投放到顶栏 #topbar-slot；顶栏用 flex 居中，无需下外边距） */
.subtabs {
  display: inline-flex;
  gap: 4px;
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: 4px;
}
.subtab {
  padding: 6px 18px;
  border-radius: 7px;
  font-weight: 700;
  color: var(--fg-2);
  font-size: var(--fs-sm);
}
.subtab:hover {
  color: var(--fg);
}
.subtab.on {
  background: var(--surface);
  color: var(--primary);
  box-shadow: var(--sh-1);
}

/* 账户视图双栏：左固定 340px、右自适应，顶对齐 */
.acc-two-col {
  grid-template-columns: 340px 1fr;
  align-items: start;
}
.acc-list-card {
  position: sticky;
  top: 0;
}

/* 账户行（选中态 + 拖拽） */
.acc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-radius: var(--r-md);
  position: relative;
  overflow: hidden;
  cursor: pointer;
}
.acc-row:hover {
  background: var(--surface-2);
}
.acc-row.on {
  background: var(--primary-soft);
}
.acc-row-bar {
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 4px;
  border-radius: 0 4px 4px 0;
}
.drag-handle {
  cursor: grab;
  flex-shrink: 0;
}
.drag-handle:active {
  cursor: grabbing;
}

/* 专项账户分区：与日常账户视觉分隔（顶部分隔线 + 区标题） */
.proj-section {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.proj-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 700;
  font-size: var(--fs-sm);
  color: var(--fg-2);
  padding: 0 8px 6px;
}

/* 账户头部色块卡 */
.acc-hero {
  border: none;
  color: #fff;
}
.acc-hero-amt {
  font-size: 34px;
  font-weight: 800;
  margin: 2px 0;
}
.acc-hero-edit {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}
.acc-hero-edit:hover {
  background: rgba(255, 255, 255, 0.32);
}

/* 分类网格项 */
.cat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  cursor: pointer;
}
.cat-item:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}
.cat-item-on {
  border-color: transparent;
  background: var(--primary-soft);
  box-shadow: inset 0 0 0 1px var(--primary);
}
.cat-item-on:hover {
  background: var(--primary-soft);
  border-color: transparent;
}
/* 明细卡头：可点击清除的分类筛选 chip */
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 60%;
  background: var(--primary-soft);
  color: var(--primary);
  border: none;
  border-radius: var(--r-pill);
  padding: 4px 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.filter-chip:hover {
  background: var(--primary);
  color: var(--primary-fg);
}
.filter-chip .fc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.filter-chip svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.cat-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: 0.12s;
  flex-shrink: 0;
}
.cat-item:hover .cat-actions {
  opacity: 1;
}
.icon-btn-sm {
  width: 28px;
  height: 28px;
}
.icon-btn-sm svg {
  width: 15px;
  height: 15px;
}
.icon-btn.danger:hover {
  background: var(--expense-soft);
  color: var(--expense);
}
.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 标签视图 */
.tags-wrap {
  max-width: 560px;
}
.tag-row .cat-actions {
  opacity: 1;
}

/* 弹层 */
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
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.modal-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field .field-label {
  margin-bottom: 0;
}
.danger-text {
  color: var(--expense);
  border-color: transparent;
}
.danger-text:hover {
  background: var(--expense-soft);
}

/* 色板 */
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.swatch {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 2px solid transparent;
  box-shadow: 0 0 0 1px var(--border) inset;
}
.swatch.on {
  border-color: var(--fg);
  box-shadow: 0 0 0 3px var(--ring);
}
/* 随机色芯片：色块基础上叠一个刷新图标，提示可点击重掷 */
.swatch-random {
  display: grid;
  place-items: center;
  color: #fff;
  cursor: pointer;
}
.swatch-random svg {
  width: 16px;
  height: 16px;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
}

/* 开关 */
.switch {
  width: 44px;
  height: 26px;
  border-radius: 999px;
  background: var(--surface-3);
  position: relative;
  transition: 0.15s;
  flex-shrink: 0;
}
.switch.on {
  background: var(--primary);
}
.switch .knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  box-shadow: var(--sh-1);
  transition: 0.15s;
}
.switch.on .knob {
  left: 21px;
}

/* toast */
.toast {
  position: fixed;
  top: 76px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  padding: 10px 18px;
  border-radius: var(--r-pill);
  font-size: var(--fs-sm);
  font-weight: 700;
  box-shadow: var(--sh-3);
}
.toast.success {
  background: var(--income-soft);
  color: var(--income);
}
.toast.error {
  background: var(--expense-soft);
  color: var(--expense);
}

/* 窄视口退化为单列（S9 手机端再细做，本次仅留伏笔） */
@media (max-width: 960px) {
  .acc-two-col {
    grid-template-columns: 1fr;
  }
  /* 单列后 grid 列默认 minmax(auto,1fr)，auto 最小值=子项 max-content 宽，
     会被卡头「N 个 · 总额」等不换行长行撑破视口 → 窄屏横向滚动（iPhone SE 320px 复现）。
     给两列子项补 min-width:0，让列可收缩到容器宽度。（桌面双栏用固定 340px 列，不受影响。） */
  .acc-two-col > * {
    min-width: 0;
  }
  .acc-list-card {
    position: static;
  }
}

/* S5：明细流水行可点击进入编辑，hover 有底色/指针反馈。 */
.txn-clickable {
  cursor: pointer;
  margin: 0 -8px;
  padding-left: 8px;
  padding-right: 8px;
  border-radius: var(--r-md);
  transition: background 0.12s;
}
.txn-clickable:hover {
  background: var(--surface-2);
}
.txn-clickable:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}

/* ============================================================
   手机端（≤720px）：双栏已在 960px 断点塌单列；此处补齐分类网格、弹层、
   悬停才显的操作按钮改常显。仅样式，不动逻辑。
   ============================================================ */
@media (max-width: 720px) {
  /* 分类网格：三列 → 单列铺满，避免挤压 */
  .grid.g-3 {
    grid-template-columns: 1fr;
  }

  /* 弹层：近满宽居中，不溢出（max-width 560/440/380 在窄屏统一收敛） */
  .modal {
    width: calc(100vw - 32px);
    max-width: 440px;
  }
  .tags-wrap {
    max-width: none;
  }

  /* cat-actions 桌面靠 hover 显现；触屏无 hover → 常显，保证可点（§4.4） */
  .cat-actions {
    opacity: 1;
  }

  /* 触控命中区：icon 按钮放大到 ≥40px */
  .icon-btn {
    width: 40px;
    height: 40px;
  }
}
</style>
