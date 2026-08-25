<script setup lang="ts">
// ============================================================
// AddTxn.vue —— 记一笔 / 编辑交易（S2 新建 + S5 编辑，双模式）
// ============================================================
// 布局（修订）：桌面为主战场，采用宽屏两栏卡片（上限约 860px 居中）：
//   左栏 = 类型分段 + 大号金额显示（含算式行）+ 常驻数字键盘（操作核心）；
//   右栏 = 表单字段区（标题 → 账户 → 分类/转入账户 → 日期 → 标签 → 备注 → 保存）。
//   原"单屏无滚动"红线在桌面已放宽：空间充裕，不再压缩牺牲字段；窄视口退化为单列（S9 手机端再细做）。
// 真正落库：接 S1 的 txnService.create / txnService.update / txnService.remove。
// 仍守红线：②选账户后分类只列该账户 ③转账用"转入账户"
//          ④算式禁用 eval（用自写安全求值器 expr.ts）⑤界面不出现"记账人/成员/TA"。
//
// S5 双模式（方案 A：点流水行直接进编辑，复用本表单）：
//   · 无 route.params.id → 新建模式（S2 原行为完全不变：智能默认 / 连续记账清空 / 记住上次账户）。
//   · 有 route.params.id → 编辑模式：onMounted 调 txnService.get(id) 回填全字段；
//       回填顺序坑位：先按 accountId loadCategories() 再赋 categoryId（否则被"重置为首个"冲掉）；
//       金额分→元 centsToYuan 写进 raw；日期用本地时区反推 YYYY-MM-DD；标签灌 selectedTagIds。
//   · 保存分叉：编辑走 txnService.update(id, patch)，patch 显式传全字段——update 是合并式、
//       tagIds 不传则保留旧关联，故 tagIds 一律传数组（含 []）；toAccountId/categoryId 显式传 null 才能清空。
//       编辑保存/删除成功后返回来源页（router.back，兜底 push /overview），不做连续记账清空。
//   · 删除：编辑界面内二次确认 → txnService.remove(id)（硬删，CASCADE 清 txn_tag）。
//   · 组件复用：watch route.params.id 重跑初始化，避免编辑A→编辑B/编辑→新建残留上一笔。
// 复制模式（/add?copy=<id>，仍属新建）：以某笔为模板照搬全字段，唯独日期取今天，保存走 create。
//   入口：搜索页详情卡「复制」、编辑页底部「复制这一笔」。源交易被删则静默退化为普通新建。
// 智能默认（仅新建）：类型=支出、账户=上次使用（SettingService last_account_id）、日期=今天。
// ============================================================
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  accountService,
  categoryService,
  tagService,
  settingService,
  txnService,
  yuanToCents,
  centsToYuan,
  AppError,
  type Account,
  type Category,
  type Tag,
  type TxnType,
  type Id,
} from '../services';
import { evalExpr, isExpression } from '../services/expr';

const LAST_ACCOUNT_KEY = 'last_account_id';

const route = useRoute();
const router = useRouter();

// ---------- 模式判定 ----------
// route.params.id 存在 → 编辑模式；否则新建模式。用 computed 以便 watch 重新初始化。
const editingId = computed<Id | null>(() => {
  const p = route.params.id;
  return typeof p === 'string' && p ? p : null;
});
const isEdit = computed(() => editingId.value !== null);
// 复制模式：/add?copy=<id>（无 route.params.id，仍属「新建」）——以某笔为模板，
// 除日期取今天外全字段照搬。isEdit 仍为 false，故保存走 create、支持连续记账。
const copyingId = computed<Id | null>(() => {
  const q = route.query.copy;
  return typeof q === 'string' && q ? q : null;
});

// ---------- 数据源 ----------
const accounts = ref<Account[]>([]);
const categories = ref<Category[]>([]);
const tags = ref<Tag[]>([]);

// ---------- 表单状态 ----------
const type = ref<TxnType>('expense'); // 智能默认：支出
const accountId = ref<Id | null>(null);
const toAccountId = ref<Id | null>(null); // 仅转账
const categoryId = ref<Id | null>(null); // 仅收支
const dateStr = ref<string>(todayStr()); // 智能默认：今天
const selectedTagIds = ref<Id[]>([]);
const title = ref(''); // 标题：主要信息（如"晚饭"），选填
const note = ref(''); // 备注：详细信息（如"和同事在楼下吃"），选填
const raw = ref(''); // 用户在数字键盘敲入的原始算式串
// 刚按过 = 求值：此时 raw 已被折叠成结果值。约定（计算器惯例）：
//   · 再按运算符 → 在结果上继续（保留 raw，仅清标记）；
//   · 再按数字 / 小数点 / 左括号 → 视为开始一段新输入，先清空上次结果。
const justEvaluated = ref(false);

// ---------- UI 状态 ----------
const openPicker = ref<'account' | 'category' | 'toAccount' | 'date' | 'tag' | null>(null);
const saving = ref(false);
const deleting = ref(false);
const confirmingDelete = ref(false); // 删除二次确认弹层
const notFound = ref(false); // 编辑模式取不到该笔 → 友好提示后跳回概览
const feedback = ref<{ kind: 'success' | 'error'; msg: string } | null>(null);
let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

// Tab 循环焦点：本页 Tab / Shift+Tab 只在「金额框 → 标题框 → 备注框」三者间轮转，
// 不落到数字键盘按钮、账户/分类/日期/标签选择器、保存/删除按钮等其它可聚焦元素上
// （见 onKeydown 的 Tab 分支）。金额框本身不是 input，靠 tabindex 变可聚焦；聚焦后
// 物理数字键仍由 onKeydown 走 press()，手感不变。
const amountBoxEl = ref<HTMLElement | null>(null);
const titleInputEl = ref<HTMLInputElement | null>(null);
const noteInputEl = ref<HTMLInputElement | null>(null);

// ============================================================
// 计算属性
// ============================================================
const currentAccount = computed(() => accounts.value.find((a) => a.id === accountId.value) ?? null);
const currentCategory = computed(
  () => categories.value.find((c) => c.id === categoryId.value) ?? null,
);
const currentToAccount = computed(
  () => accounts.value.find((a) => a.id === toAccountId.value) ?? null,
);
// 转账的"转入账户"候选：排除转出账户本身（红线③）。
const toAccountOptions = computed(() => accounts.value.filter((a) => a.id !== accountId.value));
const selectedTags = computed(() =>
  tags.value.filter((t) => selectedTagIds.value.includes(t.id)),
);

/** 大号金额显示：算式实时求值；纯数字则原样回显（保留输入手感）。 */
const displayValue = computed(() => {
  const r = raw.value;
  if (!r) return '0';
  if (!isExpression(r)) {
    return r.startsWith('.') ? `0${r}` : r;
  }
  const v = evalExprSafe(r);
  return v === null ? '0' : formatNum(v);
});

/** 算式行：仅当是算式时显示（× ÷ 美化、运算符两侧留空格）。 */
const exprLine = computed(() => {
  const r = raw.value;
  if (!isExpression(r)) return '';
  return r
    .replace(/\*/g, '×')
    .replace(/\//g, '÷')
    .replace(/([+\-×÷])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
});

/** 最终用于落库的金额（元）；非法/不完整时为 null。 */
const amountValue = computed(() => evalExprSafe(raw.value));

const canSave = computed(() => {
  const v = amountValue.value;
  if (v === null || v <= 0) return false;
  if (!accountId.value) return false;
  if (type.value === 'transfer') {
    return !!toAccountId.value && toAccountId.value !== accountId.value;
  }
  return true;
});

const isToday = computed(() => dateStr.value === todayStr());
// 日期主体：只有「月/日」。「今天」作为前缀单独渲染（见模板 .date-today-tag），
// 手机端窄 pill 放不下「今天 · 8/10」会溢出裁切，故手机端用 CSS 隐藏前缀、只留 8/10。
const dateMd = computed(() => {
  const [, m, d] = dateStr.value.split('-');
  return `${Number(m)}/${Number(d)}`;
});

// ============================================================
// 纯函数工具
// ============================================================
function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 把选中的日期字符串换成 epoch ms：一律取该日本地时区当天 0 点（时间统一归一化到「天」）。 */
function dateToEpoch(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime(); // 本地时区当天 0 点
}

/** 日期快捷加减：把 dateStr 加/减 delta 天，本地时区安全（自动跨月/跨年/闰年）。 */
function shiftDate(delta: number): void {
  const [y, m, d] = dateStr.value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  dateStr.value = `${yy}-${mm}-${dd}`;
}

/** epoch ms 反推本地时区 YYYY-MM-DD（口径与 todayStr 一致），用于编辑回填日期。 */
function epochToDateStr(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 编辑保存用的 time：时间已统一归一化到「天」，无论是否改过日期，
 * 一律取「当前所选日期的本地 0 点」（不再保留原始时分秒）。
 */
function resolveEditTime(): number {
  return dateToEpoch(dateStr.value);
}

/** 求值兜底：先去掉尾部的运算符/小数点再交给安全求值器，让"88+"这类半成品也能实时预览。 */
function evalExprSafe(input: string): number | null {
  const cleaned = input.replace(/[+\-*/.]+$/, '');
  if (cleaned === '') return null;
  return evalExpr(cleaned);
}

/** 金额显示格式化：整数不带小数，其余按两位（如 128.5 -> "128.50"）。 */
function formatNum(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

/** ARGB 整数（可能是有符号 32 位）转 CSS rgba，用于账户/分类色标。 */
function argbToCss(argb: number): string {
  const u = argb >>> 0; // 转无符号
  const a = ((u >>> 24) & 0xff) / 255;
  const r = (u >>> 16) & 0xff;
  const g = (u >>> 8) & 0xff;
  const b = u & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a === 0 ? 1 : a})`;
}

// ============================================================
// 数字键盘输入
// ============================================================
function press(ch: string): void {
  // 刚按过 = 得到结果：再输入数字/小数点视为「开始一段新算式」，先清掉上次结果。
  if (justEvaluated.value) {
    raw.value = '';
    justEvaluated.value = false;
  }
  if (ch === '.') {
    // 当前操作数已有小数点则忽略，避免 "1.2.3"（按运算符/括号切分取最后一段操作数）
    const lastNum = raw.value.split(/[+\-*/()]/).pop() ?? '';
    if (lastNum.includes('.')) return;
    if (raw.value === '' || /[+\-*/(]$/.test(raw.value)) {
      raw.value += '0.'; // 空串或运算符/左括号后补前导 0
      return;
    }
  }
  raw.value += ch;
}

function pressOp(op: '+' | '-' | '*' | '/'): void {
  // 关键交互：刚出结果时按运算符 → 保留结果、在其上继续（仅清标记，不清 raw）。
  justEvaluated.value = false;
  if (raw.value === '') return; // 不允许以运算符开头
  if (/[+\-*/]$/.test(raw.value)) {
    // 末尾已是运算符：替换之
    raw.value = raw.value.slice(0, -1) + op;
    return;
  }
  raw.value += op;
}

/** 括号输入：evalExpr 本就支持括号，这里只负责把符号拼进 raw。 */
function pressParen(p: '(' | ')'): void {
  if (justEvaluated.value) {
    if (p === '(') raw.value = ''; // 结果后按左括号 = 开新算式
    justEvaluated.value = false;
  }
  raw.value += p;
}

function backspace(): void {
  justEvaluated.value = false;
  raw.value = raw.value.slice(0, -1);
}

/**
 * 等于号：求出当前算式结果并「折叠」回 raw，作为后续继续运算的基数。
 * 用 formatNum 折叠——与大号显示区实时求值口径完全一致（金额两位精度），
 * 避免出现 "10/3=3.33333333" 这类与显示/落库不符的长尾。空/非法时不动。
 */
function equals(): void {
  const v = amountValue.value;
  if (v === null) return;
  raw.value = formatNum(v);
  justEvaluated.value = true;
}

/** 清空：把算式清干净，回到 0。 */
function clearAll(): void {
  raw.value = '';
  justEvaluated.value = false;
}

// ============================================================
// 选择器
// ============================================================
function toggle(picker: typeof openPicker.value): void {
  openPicker.value = openPicker.value === picker ? null : picker;
}

async function loadCategories(): Promise<void> {
  if (!accountId.value) {
    categories.value = [];
    categoryId.value = null;
    return;
  }
  // 红线②：分类只列当前账户下的。
  categories.value = await categoryService.listByAccount(accountId.value);
  // 换账户后，旧分类必不属新账户 -> 重置为首个（无则空）。
  if (!categories.value.some((c) => c.id === categoryId.value)) {
    categoryId.value = categories.value[0]?.id ?? null;
  }
}

async function selectAccount(id: Id): Promise<void> {
  accountId.value = id;
  openPicker.value = null;
  if (toAccountId.value === id) toAccountId.value = null; // 转出=转入 则清空
  await loadCategories();
}

function selectCategory(id: Id): void {
  categoryId.value = id;
  openPicker.value = null;
}

function selectToAccount(id: Id): void {
  toAccountId.value = id;
  openPicker.value = null;
}

function onDateInput(e: Event): void {
  const v = (e.target as HTMLInputElement).value;
  if (v) dateStr.value = v;
  openPicker.value = null;
}

function toggleTag(id: Id): void {
  const idx = selectedTagIds.value.indexOf(id);
  if (idx >= 0) selectedTagIds.value.splice(idx, 1);
  else selectedTagIds.value.push(id);
}

function setType(t: TxnType): void {
  type.value = t;
  openPicker.value = null;
  if (t === 'transfer') {
    categoryId.value = null; // 转账无分类
  } else {
    toAccountId.value = null; // 收支无转入账户
    if (categoryId.value === null) categoryId.value = categories.value[0]?.id ?? null;
  }
}

// ============================================================
// 保存
// ============================================================
function showFeedback(kind: 'success' | 'error', msg: string): void {
  feedback.value = { kind, msg };
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedback.value = null;
  }, 2200);
}

async function save(): Promise<void> {
  const value = amountValue.value;
  if (value === null || value <= 0) {
    showFeedback('error', '请输入有效金额');
    return;
  }
  if (!accountId.value) {
    showFeedback('error', '请选择账户');
    return;
  }
  if (type.value === 'transfer') {
    if (!toAccountId.value) {
      showFeedback('error', '请选择转入账户');
      return;
    }
    if (toAccountId.value === accountId.value) {
      showFeedback('error', '转入账户需与转出账户不同');
      return;
    }
  }

  saving.value = true;
  try {
    if (isEdit.value && editingId.value) {
      // ---- 编辑模式：合并式 update，显式传全字段（坑位①）----
      // toAccountId / categoryId 显式传 null 才能清空；tagIds 一律传数组（含 []）才能删光标签。
      await txnService.update(editingId.value, {
        type: type.value,
        amount: yuanToCents(value),
        accountId: accountId.value,
        toAccountId: type.value === 'transfer' ? toAccountId.value : null,
        categoryId: type.value === 'transfer' ? null : categoryId.value,
        time: resolveEditTime(),
        title: title.value.trim() || null,
        note: note.value.trim() || null,
        tagIds: selectedTagIds.value.slice(),
      });
      showFeedback('success', '已保存 ✓');
      // 编辑不做连续记账清空；返回来源页看改动生效。
      goBack();
    } else {
      // ---- 新建模式（S2 原行为，零回归）----
      await txnService.create({
        type: type.value,
        amount: yuanToCents(value),
        accountId: accountId.value,
        toAccountId: type.value === 'transfer' ? toAccountId.value : null,
        categoryId: type.value === 'transfer' ? null : categoryId.value,
        time: dateToEpoch(dateStr.value),
        title: title.value.trim() || null,
        note: note.value.trim() || null,
        tagIds: selectedTagIds.value.slice(),
      });
      // 记住上次账户，重置金额/标题/备注/标签，保留类型与账户以便连续记账。
      await settingService.set(LAST_ACCOUNT_KEY, accountId.value);
      raw.value = '';
      justEvaluated.value = false;
      title.value = '';
      note.value = '';
      selectedTagIds.value = [];
      showFeedback('success', '已保存 ✓');
    }
  } catch (e) {
    const msg = e instanceof AppError ? e.message : '保存失败，请重试';
    showFeedback('error', msg);
  } finally {
    saving.value = false;
  }
}

// ============================================================
// 删除（编辑模式，二次确认）
// ============================================================
function askDelete(): void {
  confirmingDelete.value = true;
}

async function confirmDelete(): Promise<void> {
  if (!editingId.value) return;
  deleting.value = true;
  try {
    await txnService.remove(editingId.value);
    confirmingDelete.value = false;
    showFeedback('success', '已删除 ✓');
    goBack();
  } catch (e) {
    confirmingDelete.value = false;
    const msg =
      e instanceof AppError && e.code === 'NOT_FOUND'
        ? '这笔交易已不存在'
        : e instanceof AppError
          ? e.message
          : '删除失败，请重试';
    showFeedback('error', msg);
  } finally {
    deleting.value = false;
  }
}

// ============================================================
// 返回来源页（保存/删除成功后）
// ============================================================
function goBack(): void {
  // 有浏览器历史则原路返回（概览来回概览、账户明细来回账户）；否则兜底去概览。
  if (window.history.length > 1) {
    router.back();
  } else {
    void router.push('/overview');
  }
}

/** 编辑模式「复制这一笔」：以当前正在编辑的交易为模板另开一笔新建（日期取今天）。
 *  用 replace 而非 push，避免返回时又回到编辑页；同实例下 watch(copyingId) 会重跑 initForm。 */
function copyCurrent(): void {
  if (!editingId.value) return;
  void router.replace({ path: '/add', query: { copy: editingId.value } });
}

// ============================================================
// 物理键盘（辅助，非必需）
// ============================================================
function onKeydown(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null;

  // Tab / Shift+Tab：本页焦点只在「金额框 → 标题框 → 备注框」三者间循环，
  //   数字键盘、账户/分类/日期/标签选择器、保存/删除按钮等一律不参与 Tab。
  //   做法：拦截 Tab 阻止浏览器默认移焦，按当前焦点在三元环里手动前/后移一位。
  //   放在输入框早退之前，否则聚焦标题/备注时 Tab 会被下面的 return 漏掉。
  if (e.key === 'Tab') {
    const amount = amountBoxEl.value;
    const titleEl = titleInputEl.value;
    const noteEl = noteInputEl.value;
    if (amount && titleEl && noteEl) {
      e.preventDefault();
      const cycle: HTMLElement[] = [amount, titleEl, noteEl];
      const len = cycle.length;
      const idx = el ? cycle.indexOf(el) : -1;
      // 正向：不在环内(idx=-1)→首位(金额)；反向：不在环内→末位(备注)。
      const next = e.shiftKey ? cycle[(idx <= 0 ? len : idx) - 1] : cycle[(idx + 1) % len];
      next.focus();
    }
    return;
  }

  // 备注/标题等输入框聚焦时不拦截键盘。
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
  // Esc 分层：先关删除确认 → 再关选择器浮层 → 剩余按模式区分：
  //   · 新建模式（与搜索页同思路）：金额非空先清空，再按 Esc 才返回；
  //   · 编辑模式：金额本就是原交易预填值，清空它不直观且未保存无意义，
  //     故直接返回（手误点进某笔交易，一次 Esc 即退出）。'c' 始终等于清空金额。
  if (e.key === 'Escape') {
    if (confirmingDelete.value) confirmingDelete.value = false;
    else if (openPicker.value) openPicker.value = null;
    else if (!isEdit.value && raw.value) clearAll();
    else goBack();
    e.preventDefault();
    return;
  }
  if (e.key >= '0' && e.key <= '9') press(e.key);
  else if (e.key === '.' || e.key === 'Decimal' || e.code === 'NumpadDecimal' || e.code === 'Period')
    press('.'); // 主键区句号、小键盘小数点、部分布局的 'Decimal' 都算小数点
  else if (e.key === '+' || e.key === '-' || e.key === '*' || e.key === '/') pressOp(e.key);
  else if (e.key === '(' || e.key === ')') pressParen(e.key);
  else if (e.key === '=') equals(); // 等于号：求值并折叠结果，供继续运算
  else if (e.key === 'Backspace') backspace();
  else if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) clearAll();
  else if (e.key === 'Enter') void save(); // Enter 仍是「保存整笔」快捷键（金额已实时求值）
  else return;
  e.preventDefault();
}

// ============================================================
// 初始化 / 生命周期
// ============================================================
/** 把表单重置回"新建模式"的干净默认（供编辑→新建切换时清残留）。 */
function resetFormState(): void {
  type.value = 'expense';
  accountId.value = null;
  toAccountId.value = null;
  categoryId.value = null;
  dateStr.value = todayStr();
  selectedTagIds.value = [];
  title.value = '';
  note.value = '';
  raw.value = '';
  justEvaluated.value = false;
  openPicker.value = null;
  confirmingDelete.value = false;
  notFound.value = false;
}

/** 新建模式的智能默认：类型=支出（初值即是）、账户=上次使用、日期=今天。
 *  例外：若 URL query 带 ?account=<id>（Alt+N 从账户页带入），且该账户有效，
 *  则优先用它，方便「在某账户页按 Alt+N 直接记该账户的一笔」。 */
async function initCreate(): Promise<void> {
  const q = route.query.account;
  const qAccount = typeof q === 'string' && q ? q : null;
  if (qAccount && accounts.value.some((a) => a.id === qAccount)) {
    accountId.value = qAccount;
  } else {
    const last = await settingService.get(LAST_ACCOUNT_KEY);
    if (last && accounts.value.some((a) => a.id === last)) {
      accountId.value = last;
    } else {
      accountId.value = accounts.value[0]?.id ?? null;
    }
  }
  await loadCategories();
}

/** 编辑模式：取该笔并回填全字段（顺序坑位：先 loadCategories 再赋 categoryId）。 */
async function initEdit(id: Id): Promise<void> {
  const txn = await txnService.get(id);
  if (!txn) {
    // 不存在 → 友好提示后跳回概览，不崩溃。
    notFound.value = true;
    showFeedback('error', '这笔交易不存在或已被删除');
    setTimeout(() => {
      void router.push('/overview');
    }, 1200);
    return;
  }

  type.value = txn.type;
  accountId.value = txn.accountId;
  toAccountId.value = txn.type === 'transfer' ? txn.toAccountId : null;

  // 金额：分 → 元字符串，直接作为键盘算式串（大号显示会求值展示）。坑位③别把分当元。
  raw.value = centsToYuan(txn.amount);

  // 日期：epoch ms → 本地 YYYY-MM-DD 回填（epochToDateStr 只取年月日，历史数据带不带时分秒都不受影响）。
  dateStr.value = epochToDateStr(txn.time);

  title.value = txn.title ?? '';
  note.value = txn.note ?? '';
  selectedTagIds.value = txn.tags.map((t) => t.id);

  // 关键顺序（坑位②）：先按 accountId 载入分类候选，再赋 categoryId，否则回填值被"重置为首个"冲掉。
  await loadCategories();
  categoryId.value = txn.type === 'transfer' ? null : txn.categoryId;
}

/** 复制模式（新建，/add?copy=<id>）：以某笔为模板照搬全字段，唯独日期取今天。
 *  取不到源交易时静默退化为普通新建（智能默认），不打断记账。
 *  回填顺序坑位同编辑：先 loadCategories 再赋 categoryId。 */
async function initCopy(id: Id): Promise<void> {
  const txn = await txnService.get(id);
  if (!txn) {
    await initCreate(); // 源已删除：退化为普通新建，不报错打断
    return;
  }

  type.value = txn.type;
  accountId.value = txn.accountId;
  toAccountId.value = txn.type === 'transfer' ? txn.toAccountId : null;
  raw.value = centsToYuan(txn.amount); // 金额分→元字符串（同编辑回填）
  dateStr.value = todayStr(); // 复制的唯一差异：日期取今天
  title.value = txn.title ?? '';
  note.value = txn.note ?? '';
  selectedTagIds.value = txn.tags.map((t) => t.id);

  await loadCategories();
  categoryId.value = txn.type === 'transfer' ? null : txn.categoryId;
}

/** 统一初始化：先备好基础数据源，再按模式分叉。watch 复用同一实例时也走这里。 */
async function initForm(): Promise<void> {
  resetFormState();
  accounts.value = await accountService.list();
  tags.value = await tagService.list();

  const id = editingId.value;
  if (id) {
    await initEdit(id);
  } else if (copyingId.value) {
    await initCopy(copyingId.value);
  } else {
    await initCreate();
  }
}

onMounted(async () => {
  await initForm();
  window.addEventListener('keydown', onKeydown);
});

// 组件复用（坑位⑤）：编辑A→编辑B、或编辑→新建/复制（route 变化但同一 AddTxn 实例）时重跑初始化。
// 同时监听 copyingId：/add → /add?copy=x 时 editingId 恒为 null 不会触发，需 copyingId 兜底。
watch([editingId, copyingId], () => {
  void initForm();
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  if (feedbackTimer) clearTimeout(feedbackTimer);
});
</script>

<template>
  <div class="content add-content">
    <div class="add-card add-card-2col">
      <!-- ========== 左栏：类型 + 金额 + 键盘（操作核心） ========== -->
      <div class="add-left">
        <div class="segmented">
          <button class="seg" :class="{ 'on-expense': type === 'expense' }" @click="setType('expense')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 5v14M19 12l-7 7-7-7" />
            </svg>
            支出
          </button>
          <button class="seg" :class="{ 'on-income': type === 'income' }" @click="setType('income')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
            收入
          </button>
          <button class="seg" :class="{ 'on-transfer': type === 'transfer' }" @click="setType('transfer')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M17 3l4 4-4 4M7 21l-4-4 4-4M21 7H8M3 17h13" />
            </svg>
            转账
          </button>
        </div>

        <!-- 金额显示（视觉焦点）：tabindex=0 使之可被 Tab 聚焦，聚焦后物理数字键仍由 onKeydown 处理。 -->
        <div ref="amountBoxEl" class="amount-display amount-lg" :class="type" tabindex="0" role="group" aria-label="金额">
          <span class="cur">¥</span><span class="val num">{{ displayValue }}</span>
          <div class="expr num">{{ exprLine }}</div>
        </div>

        <!-- 数字键盘（常驻）：4 行 × 5 列。
             左列 = 工具（清空/括号/退格），中间三列 = 数字，右列 = 运算符；底排含 = 求值键。
             括号：expr.ts 求值器本就支持括号，键盘补上录入入口。 -->
        <div class="numpad numpad-5">
          <button class="key util" @click="clearAll()" aria-label="清空">C</button>
          <button class="key" @click="press('7')">7</button>
          <button class="key" @click="press('8')">8</button>
          <button class="key" @click="press('9')">9</button>
          <button class="key util" @click="pressOp('/')">÷</button>

          <button class="key util" @click="pressParen('(')">(</button>
          <button class="key" @click="press('4')">4</button>
          <button class="key" @click="press('5')">5</button>
          <button class="key" @click="press('6')">6</button>
          <button class="key util" @click="pressOp('*')">×</button>

          <button class="key util" @click="pressParen(')')">)</button>
          <button class="key" @click="press('1')">1</button>
          <button class="key" @click="press('2')">2</button>
          <button class="key" @click="press('3')">3</button>
          <button class="key util" @click="pressOp('-')">−</button>

          <button class="key util" @click="backspace()" aria-label="删除">⌫</button>
          <button class="key" @click="press('.')">.</button>
          <button class="key" @click="press('0')">0</button>
          <button class="key util accent" @click="equals()" aria-label="等于">=</button>
          <button class="key util accent" @click="pressOp('+')">＋</button>
        </div>
      </div>

      <!-- ========== 右栏：表单字段区（纵向） ========== -->
      <div class="add-right">
        <!-- 标题（主要信息，选填） -->
        <div class="field add-f-title">
          <label class="field-label">标题</label>
          <input ref="titleInputEl" v-model="title" class="input" placeholder="标题（选填，如：晚饭）" />
        </div>

        <!-- 手机端把 账户·分类 压成一行两 pill（桌面 display:contents 不改变纵向堆叠） -->
        <div class="add-pair">
        <!-- 账户 -->
        <div class="field">
          <label class="field-label">账户</label>
          <div class="picker-anchor">
            <button class="pill pill-block" :class="{ 'pill-active': openPicker === 'account' }" @click="toggle('account')">
              <span
                v-if="currentAccount"
                class="ic-tile sm dot"
                :style="{ background: argbToCss(currentAccount.color) }"
              />
              {{ currentAccount?.name ?? '选择账户' }}
              <span class="caret">▾</span>
            </button>
            <div v-if="openPicker === 'account'" class="popover">
              <button
                v-for="a in accounts"
                :key="a.id"
                class="popover-item"
                :class="{ on: a.id === accountId }"
                @click="selectAccount(a.id)"
              >
                <span class="ic-tile sm dot" :style="{ background: argbToCss(a.color) }" />
                {{ a.name }}
                <span v-if="a.kind === 'project'" class="opt-tag">专项</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 分类（收支）/ 转入账户（转账） -->
        <div class="field">
          <label class="field-label">{{ type === 'transfer' ? '转入账户' : '分类' }}</label>
          <div class="picker-anchor">
            <template v-if="type === 'transfer'">
              <button class="pill pill-block" :class="{ 'pill-active': openPicker === 'toAccount' }" @click="toggle('toAccount')">
                <span
                  v-if="currentToAccount"
                  class="ic-tile sm dot"
                  :style="{ background: argbToCss(currentToAccount.color) }"
                />
                {{ currentToAccount?.name ?? '选择转入账户' }}
                <span class="caret">▾</span>
              </button>
              <div v-if="openPicker === 'toAccount'" class="popover">
                <div v-if="toAccountOptions.length === 0" class="popover-empty">无其他账户</div>
                <button
                  v-for="a in toAccountOptions"
                  :key="a.id"
                  class="popover-item"
                  :class="{ on: a.id === toAccountId }"
                  @click="selectToAccount(a.id)"
                >
                  <span class="ic-tile sm dot" :style="{ background: argbToCss(a.color) }" />
                  {{ a.name }}
                </button>
              </div>
            </template>
            <template v-else>
              <button class="pill pill-block" :class="{ 'pill-active': openPicker === 'category' }" @click="toggle('category')">
                <span
                  v-if="currentCategory"
                  class="ic-tile sm dot"
                  :style="{ background: argbToCss(currentCategory.color) }"
                />
                {{ currentCategory?.name ?? '选择分类' }}
                <span class="caret">▾</span>
              </button>
              <div v-if="openPicker === 'category'" class="popover">
                <div v-if="categories.length === 0" class="popover-empty">该账户暂无分类</div>
                <button
                  v-for="c in categories"
                  :key="c.id"
                  class="popover-item"
                  :class="{ on: c.id === categoryId }"
                  @click="selectCategory(c.id)"
                >
                  <span class="ic-tile sm dot" :style="{ background: argbToCss(c.color) }" />
                  {{ c.name }}
                </button>
              </div>
            </template>
          </div>
        </div>
        </div>
        <!-- /add-pair 账户·分类 -->

        <!-- 手机端把 日期·标签 压成一行两 pill -->
        <div class="add-pair">
        <!-- 日期 -->
        <div class="field">
          <label class="field-label">日期</label>
          <div class="date-row">
            <button class="date-step" aria-label="前一天" @click="shiftDate(-1)">‹</button>
            <div class="picker-anchor date-anchor">
              <button class="pill pill-block" :class="{ 'pill-active': openPicker === 'date' }" @click="toggle('date')">
                <span v-if="isToday" class="date-today-tag">今天 · </span>{{ dateMd }}
                <span class="caret">▾</span>
              </button>
              <div v-if="openPicker === 'date'" class="popover popover-pad">
                <input class="input" type="date" :value="dateStr" @change="onDateInput" />
              </div>
            </div>
            <button class="date-step" aria-label="后一天" @click="shiftDate(1)">›</button>
          </div>
        </div>

        <!-- 标签 -->
        <div class="field">
          <label class="field-label">标签</label>
          <div class="picker-anchor">
            <button class="pill pill-block" :class="{ 'pill-active': openPicker === 'tag' }" @click="toggle('tag')">
              <template v-if="selectedTags.length">
                <span v-for="t in selectedTags" :key="t.id" class="chip" style="padding: 2px 8px">{{ t.name }}</span>
              </template>
              <span v-else class="faint">添加标签</span>
              <span style="color: var(--primary); font-weight: 700; margin-left: auto">＋</span>
            </button>
            <div v-if="openPicker === 'tag'" class="popover popover-pad">
              <div v-if="tags.length === 0" class="popover-empty">暂无标签</div>
              <div class="tag-wrap">
                <button
                  v-for="t in tags"
                  :key="t.id"
                  class="chip"
                  :class="{ 'chip-on': selectedTagIds.includes(t.id) }"
                  @click="toggleTag(t.id)"
                >
                  {{ t.name }}
                </button>
              </div>
            </div>
          </div>
        </div>
        </div>
        <!-- /add-pair 日期·标签 -->

        <!-- 备注（详细信息，选填） -->
        <div class="field">
          <label class="field-label">备注</label>
          <div class="note-inline">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4v16h16v-7" />
              <path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
            </svg>
            <input ref="noteInputEl" v-model="note" placeholder="备注（选填，详细信息）" />
          </div>
        </div>

        <!-- 反馈 + 保存（贴底） -->
        <div class="add-right-foot">
          <div v-if="feedback" class="feedback" :class="feedback.kind">{{ feedback.msg }}</div>
          <button class="btn btn-primary btn-lg btn-block mt-2" :disabled="!canSave || saving" @click="save">
            {{ saving ? '保存中…' : isEdit ? '保存修改' : '保存这一笔' }}
          </button>
          <div class="add-kbd-hint kbd-hint" aria-hidden="true">
            <span class="kbd">↵</span>保存
            <span class="kbd">Esc</span>{{ isEdit ? '返回' : '清空/返回' }}
            <span class="kbd">C</span>清空
          </div>
          <!-- 编辑模式：复制入口（照搬本笔另开新建，日期取今天）——放在删除前，低调次级按钮 -->
          <button
            v-if="isEdit"
            class="btn btn-ghost btn-block mt-2"
            :disabled="saving || deleting"
            @click="copyCurrent"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            复制这一笔
          </button>
          <!-- 编辑模式：删除入口（次级危险按钮，二次确认，不与保存混淆） -->
          <button
            v-if="isEdit"
            class="btn btn-ghost btn-block btn-del mt-2"
            :disabled="saving || deleting"
            @click="askDelete"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
            删除交易
          </button>
        </div>
      </div>
    </div>

    <!-- 点击空白关闭选择器 -->
    <div v-if="openPicker" class="picker-backdrop" @click="openPicker = null" />

    <!-- 删除二次确认弹层（编辑模式） -->
    <div v-if="confirmingDelete" class="confirm-backdrop" @click.self="confirmingDelete = false">
      <div class="confirm-card">
        <div class="confirm-title">删除交易</div>
        <div class="confirm-msg">
          删除后这笔交易将不可恢复（其标签关联会一并移除，账户余额随之调整）。确定删除吗？
        </div>
        <div class="confirm-actions">
          <button class="btn btn-ghost" :disabled="deleting" @click="confirmingDelete = false">取消</button>
          <button class="btn btn-danger" :disabled="deleting" @click="confirmDelete">
            {{ deleting ? '删除中…' : '删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 桌面为主战场：主区居中一张宽卡；内容多时允许纵向滚动（不再强制单屏）。 */
.add-content {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: var(--bg);
  overflow: auto;
}

/* 两栏卡片：左金额+键盘，右表单。上限约 860px 居中。 */
.add-card-2col {
  width: 100%;
  max-width: 860px;
  margin: 8px auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.add-left {
  padding: 20px 22px;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.add-right {
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* pill 对：桌面下透明（display:contents），两个 .field 照旧各占一行纵向堆叠——桌面零回归。 */
.add-pair {
  display: contents;
}

/* ============================================================
   手机端（≤720px）——头号红线：记一笔单屏无滚动。
   思路（对照 add.html 手机稿）：把两栏卡片压成"一整列 flex"，
   顺序：类型分段 → 金额 → 账户·分类(一行两 pill) → 日期·标签(一行两 pill)
        → 备注 → 数字键盘(flex:1 常驻吃满剩余) → 保存(贴底)。
   关键：外层容器用 100dvh 派生高度（.app 已置 100dvh），键盘 flex:1、其余 flex-shrink:0，
        不用固定 px 硬凑（坑3）。
   ============================================================ */
@media (max-width: 720px) {
  /* 内容区不滚动、铺满、无内边距（外壳 .app 已收起底栏，把整屏交给记一笔） */
  .add-content {
    padding: 0;
    overflow: hidden;
    align-items: stretch;
    min-height: 0;
  }

  /* 卡片 = 纵向 flex，占满可用高度；去掉桌面卡片的圆角/居中/上限 */
  .add-card-2col {
    display: flex;
    flex-direction: column;
    grid-template-columns: none;
    width: 100%;
    max-width: none;
    height: 100%;
    min-height: 0;
    margin: 0;
    gap: 10px;
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
  }

  /* 左右栏透明化：其子元素成为卡片的直接 flex 项，便于统一排序 */
  .add-left,
  .add-right {
    display: contents;
  }

  /* 统一排序（display:contents 后，两栏的孙元素在同一 flex 流里）。
     两个 add-pair 同为 order:4，按源码先后（账户·分类 在前、日期·标签 在后）自然排列，
     故不用 nth-of-type（首个 div 是标题，会错位）。 */
  .add-left .segmented { order: 1; }
  .add-left .amount-display { order: 2; }
  .add-right .add-f-title { order: 3; }
  .add-right .add-pair { order: 4; }              /* 账户·分类 / 日期·标签 两行 */
  .add-right .field:not(.add-f-title) { order: 6; } /* 备注（直接项）；pair 内字段同序无副作用 */
  .add-left .numpad-5 { order: 7; }
  .add-right .add-right-foot { order: 8; }

  /* 固定高度块：不参与伸缩 */
  .add-left .segmented,
  .add-left .amount-display,
  .add-right .field,
  .add-right .add-pair,
  .add-right .add-right-foot {
    flex-shrink: 0;
  }

  /* 金额：手机稿字号 46px，作视觉焦点；压缩上下留白 */
  .amount-lg {
    padding: 2px 0;
  }
  .amount-lg .val {
    font-size: 46px;
  }

  /* 标题/备注字段：紧凑（label 收小，间距收窄） */
  .add-right .field {
    gap: 4px;
  }

  /* pill 对：一行两 pill，各占一半（红线④：账户·分类 / 日期·标签 各一行两个） */
  .add-pair {
    display: flex;
    gap: 8px;
  }
  .add-pair .field {
    flex: 1;
    min-width: 0;
  }

  /* 日期三件套在手机端每个 .field 仅占半宽：加减按钮收窄、行内间距收紧，
     确保「‹ pill ›」整行不换行、不撑破外层 flex:1（守单屏无滚动红线）。 */
  .date-row {
    gap: 4px;
  }
  .date-step {
    width: 30px;
    font-size: 18px;
  }
  /* 手机端窄 pill 放不下「今天 · 8/10」（会溢出裁切），隐藏「今天」前缀只留月/日。
     桌面 pill 够宽，仍显示完整「今天 · 8/10」。 */
  .date-today-tag {
    display: none;
  }

  /* 数字键盘：吃满所有剩余高度、常驻不滚动；行高由 minmax(0,1fr) 弹性分配。
     必须用 minmax(0,1fr) 而非 1fr——后者等价 minmax(auto,1fr)，行高不肯低于内容，
     在编辑模式（多出"删除交易"按钮）会撑高网格、第 4 行被 overflow 裁掉（坑3）。
     用 .add-card-2col 提高特异性：桌面版 .numpad-5{grid-template-rows:repeat(4,56px)}
     在本文件更靠后，同特异性会反压本规则，故这里加父级选择器确保手机行高生效。
     min-height:0 让键盘可随可用高度收缩，确保任何模式下都单屏无滚动（头号红线）。
     行数仍为 4（新增的 = / 括号 / 清空走横向第 5 列，不加行），故单屏高度口径不变。 */
  .add-card-2col .numpad-5 {
    flex: 1;
    min-height: 0;
    grid-template-rows: repeat(4, minmax(0, 1fr));
  }
  .numpad-5 .key {
    height: auto;
    min-height: 0;
    font-size: 20px;
  }

  /* 保存区贴底：numpad flex:1 已把它顶到底部，这里清掉桌面的 margin-top:auto 以免二次抢占 */
  .add-right-foot {
    margin-top: 0;
  }
}

/* ============================================================
   矮屏压缩（如 iPhone SE：宽≤720 且 高≤740）。
   问题：默认手机布局的固定块（分段 + 46px 金额 + 标题 + 两行 pill + 备注 + 保存 + gap）
   在矮屏上几乎占满可用高度，数字键盘 flex:1 被挤到只剩几十 px、按钮行高约 7px 不可用。
   对策：仅在矮屏收紧金额字号 / 字段间距 / 卡片 gap，把高度让给键盘，
        使 numpad 恢复到 ~160px（按钮行高 ~36px），且整屏仍不滚动（头号红线）。
   正常高度手机（812px+）不触发本段，保持原有舒适字号。 */
@media (max-width: 720px) and (max-height: 740px) {
  .add-card-2col {
    gap: 5px;
    padding-top: 6px;
  }
  /* 金额区：压到 30px、去留白（矮屏省 ~50px）。
     注意：桌面 .amount-lg / .amount-lg .val 定义在本文件更靠后（同特异性会反压 media 规则），
     故这里用 .add-card-2col 前缀提高特异性，确保矮屏压缩真正生效（同坑见 numpad 注释）。 */
  .add-card-2col .amount-lg {
    padding: 0;
  }
  .add-card-2col .amount-lg .val {
    font-size: 30px;
  }
  /* 字段：label 收小、块内间距收紧、输入框上下 padding 收窄 */
  .add-right .field {
    gap: 2px;
  }
  .add-card-2col .field-label {
    font-size: 11px;
  }
  .add-card-2col .input {
    padding: 7px 10px;
  }
}

/* 分段控件里的 seg 是 button，补齐可点击态 */
.segmented .seg {
  width: 100%;
}

/* 左栏金额区：桌面上更醒目 */
.amount-lg {
  padding: 8px 0 4px;
}
.amount-lg .val {
  font-size: 56px;
}

/* 右栏表单字段：标题 + label */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field .field-label {
  margin-bottom: 0;
}

/* 右栏保存区推到底部 */
.add-right-foot {
  margin-top: auto;
}
/* 桌面记一笔快捷键提示：保存按钮下方居中、极淡（手机端由 tokens.css 统一隐藏）。 */
.add-kbd-hint {
  justify-content: center;
  gap: 5px;
  margin-top: 8px;
}
.add-kbd-hint .kbd { margin-left: 3px; }

/* pill 选择器锚点 */
.picker-anchor {
  position: relative;
}
/* 右栏里的 pill 铺满整行、左对齐显示内容 */
.pill-block {
  width: 100%;
  justify-content: flex-start;
}
.pill-block .caret {
  margin-left: auto;
}
.dot {
  width: 20px;
  height: 20px;
}

/* 日期三件套：‹ 前一天 | 日期 pill | 后一天 ›。
   加减按钮定宽方块（flex:none）、中间 pill 容器 flex:1 吃满剩余，
   整行不换行、不增高——守 AddTxn 单屏无滚动红线。 */
.date-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}
.date-anchor {
  flex: 1;
  min-width: 0;
}
.date-step {
  flex: none;
  width: 40px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  border-radius: var(--r-md);
  color: var(--fg-2);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  display: grid;
  place-items: center;
}
.date-step:hover {
  background: var(--surface-3);
  border-color: var(--border-strong);
  color: var(--fg);
}
.date-step:active {
  background: var(--surface-3);
}

/* 弹出选择层 */
.popover {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 30;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-3);
  padding: 6px;
  max-height: 220px;
  overflow: auto;
}
.popover-pad {
  padding: 10px;
}
.popover-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--fg);
  text-align: left;
}
.popover-item:hover {
  background: var(--surface-2);
}
.popover-item.on {
  background: var(--primary-soft);
  color: var(--primary);
}
.opt-tag {
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(147, 52, 230, 0.14);
  color: #9334e6;
}
.popover-empty {
  padding: 10px;
  color: var(--fg-3);
  font-size: var(--fs-sm);
  text-align: center;
}
.tag-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 5 列数字键盘（工具列 + 3 列数字 + 运算符列），保持设计的行高与底片风格 */
.numpad-5 {
  grid-template-columns: repeat(5, 1fr);
  grid-template-rows: repeat(4, 56px);
}

/* 反馈条 */
.feedback {
  text-align: center;
  font-size: var(--fs-sm);
  font-weight: 600;
  padding: 8px;
  border-radius: var(--r-md);
}
.feedback.success {
  background: var(--income-soft);
  color: var(--income);
}
.feedback.error {
  background: var(--expense-soft);
  color: var(--expense);
}

/* 关闭选择器的透明背板 */
.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}

/* 编辑模式：删除交易——次级危险按钮，平时低调、hover 才转红，避免误点 */
.btn-del {
  color: var(--expense);
  border-color: var(--border);
}
.btn-del:hover:not(:disabled) {
  background: var(--expense-soft);
  border-color: var(--expense);
}
.btn-del svg {
  width: 16px;
  height: 16px;
}

/* 删除二次确认弹层 */
.confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.confirm-card {
  width: 100%;
  max-width: 380px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-3);
  padding: 22px;
}
.confirm-title {
  font-size: var(--fs-h3);
  font-weight: 700;
  color: var(--fg);
  margin-bottom: 10px;
}
.confirm-msg {
  font-size: var(--fs-sm);
  color: var(--fg-2);
  line-height: 1.6;
  margin-bottom: 20px;
}
.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
