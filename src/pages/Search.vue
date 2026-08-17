<script setup lang="ts">
// ============================================================
// Search.vue —— 搜索页（Search，S10 · Priority 5）
// ============================================================
// 对照 设计稿/search.html 桌面稿还原：
//   大搜索框（输入即时过滤 标题/备注/分类名/标签名 并高亮命中）
//   + 可叠加筛选 chips（账户/分类/标签/金额范围/类型）+ 最近搜索历史
//   → 命中收支汇总三卡 → 双栏（左：按日期分组的命中列表；右：选中交易详情卡）。
//
// 数据流架构（S10 任务书 §四.1，最重要）：
//   TxnService.query 的 keyword 只 LIKE title/note，做不到分类名/标签名匹配。因此：
//   - 结构化筛选（账户/分类/标签/金额/类型）走 TxnService.query（唯一真相源）→ baseTxns。
//   - 关键词过滤放在【前端】：对 baseTxns 跨「标题/备注/分类名/标签名」二次过滤 → hitTxns。
//   - 汇总三卡、日期分组、详情卡 全部基于 hitTxns 纯同步派生（computed）。
//   —— 与 S9 报告页「以 query 为唯一真相源、TS 派生」同一套思路（见 Reports.vue）；
//      区别是本页多一层「关键词前端过滤」，敲关键词不重查库、只有结构化筛选变时才重发 query。
//
// 红线：
//   - 转账不计入收支：命中三卡的收入/支出合计、日小计只统计 income/expense；
//     转账可出现在结果列表（中性色、无正负号），但不进任何金额合计。
//   - 金额整数分求和，仅展示层经 money.format（+千分位薄封装，不改 money.ts）。
//   - 颜色一律引 token（唯一例外：mark 荧光高亮色，token 无对应项）。
//   - 单人应用，界面无「记账人/成员/协作/TA」等社交化词汇。
//   - 高亮 v-html 前先转义 HTML 特殊字符防 XSS（见 escapeHtml/highlight）。
// 本阶段只做桌面宽屏；手机响应式留待后续（仅留 @media 伏笔）。
// ============================================================
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  accountService,
  categoryService,
  tagService,
  txnService,
  format,
  type Account,
  type Category,
  type Id,
  type Tag,
  type TxnType,
  type TxnQuery,
  type TxnWithTags,
} from '../services';

const router = useRouter();

/** 详情卡「编辑」→ 复用 AddTxn 双模式。 */
function openEdit(id: Id): void {
  void router.push(`/txn/${id}/edit`);
}

// ============================================================
// 关键词（前端过滤，纯同步）
// ============================================================
const keyword = ref<string>('');

// ============================================================
// 搜索范围（关键词作用字段，前端纯同步）：限定关键词只对
//   标题 / 备注 / 分类名 / 标签名 中被勾选的字段生效。
//   默认四项全选（等价旧行为）；约束「至少保留 1 项」——全不选会让
//   关键词无处可搜、结果恒空，反直觉，故取消最后一项时忽略。
//   高亮亦跟随范围：未勾选的字段即便文本恰含关键词也不高亮，
//   使命中高亮准确表达「因哪个字段命中」。
// ============================================================
type SearchField = 'title' | 'note' | 'category' | 'tag';
const SEARCH_FIELDS: ReadonlyArray<{ v: SearchField; label: string }> = [
  { v: 'title', label: '标题' },
  { v: 'note', label: '备注' },
  { v: 'category', label: '分类' },
  { v: 'tag', label: '标签' },
];
const DEFAULT_SEARCH_FIELDS: SearchField[] = ['title', 'note', 'category', 'tag'];
const searchFields = ref<SearchField[]>([...DEFAULT_SEARCH_FIELDS]);
function fieldOn(f: SearchField): boolean {
  return searchFields.value.includes(f);
}
function toggleField(f: SearchField): void {
  const i = searchFields.value.indexOf(f);
  if (i >= 0) {
    if (searchFields.value.length === 1) return; // 至少保留 1 项
    searchFields.value.splice(i, 1);
  } else {
    searchFields.value.push(f);
  }
}

// ============================================================
// 结构化筛选状态（chips）—— 走 TxnService.query
// ============================================================
const selectedTypes = ref<TxnType[]>([]); // 搜索页允许筛 transfer（与报告页不同）
const selectedAccountIds = ref<Id[]>([]);
const selectedCategoryNames = ref<string[]>([]); // 展示层按名去重，同名跨账户都算
const selectedTagIds = ref<Id[]>([]);
const amountMinCents = ref<number | null>(null);
const amountMaxCents = ref<number | null>(null);

// ============================================================
// 展示排序（从报告页迁入）：对过滤好的命中结果做展示排序。
//   四选项：金额高→低 / 金额低→高 / 时间新→旧 / 时间旧→新；默认时间新→旧。
//   排序作用于 TxnService.query 的 sortBy/sortDir（唯一真相源顺序），
//   前端关键词过滤与日期分组均保持该顺序。
// ============================================================
type SortSel = 'time-desc' | 'time-asc' | 'amount-desc' | 'amount-asc';
const sortSel = ref<SortSel>('time-desc');
const SORT_OPTS: ReadonlyArray<{ v: SortSel; label: string }> = [
  { v: 'time-desc', label: '时间（新→旧）' },
  { v: 'time-asc', label: '时间（旧→新）' },
  { v: 'amount-desc', label: '金额（高→低）' },
  { v: 'amount-asc', label: '金额（低→高）' },
];

// ============================================================
// 静态可选项（账户 / 分类 / 标签 / categoryId→Category 映射）
// ============================================================
const accounts = ref<Account[]>([]);
const allCategories = ref<Category[]>([]);
const tags = ref<Tag[]>([]);
const categoryById = ref<Map<Id, Category>>(new Map());

/** 分类按名去重，供「添加分类条件」列选项与 chip 展示（参考 Reports.vue）。 */
const uniqueCategoryNames = computed<string[]>(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of allCategories.value) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      out.push(c.name);
    }
  }
  return out;
});

async function loadStatic(): Promise<void> {
  accounts.value = await accountService.list();
  // 建 categoryId -> Category 映射：逐账户 listByAccount 后合并（账户数有限，非 N+1）。
  const cats: Category[] = [];
  const map = new Map<Id, Category>();
  for (const acc of accounts.value) {
    const list = await categoryService.listByAccount(acc.id);
    for (const c of list) {
      cats.push(c);
      map.set(c.id, c);
    }
  }
  allCategories.value = cats;
  categoryById.value = map;
  tags.value = await tagService.list();
}

// ============================================================
// 唯一真相源：仅按【结构化筛选】查询候选列表（不含关键词，全部时间）
// ============================================================
const baseTxns = ref<TxnWithTags[]>([]);
const loading = ref(false);

/** 选中的分类名 → 对应的全部 categoryId（跨账户同名都算）。 */
function categoryIdsForNames(names: string[]): Id[] {
  if (names.length === 0) return [];
  const set = new Set(names);
  return allCategories.value.filter((c) => set.has(c.name)).map((c) => c.id);
}

const activeQuery = computed<TxnQuery>(() => {
  // 默认全部时间（不传 timeFrom/timeTo）；顺序由展示排序选项决定。
  const q: TxnQuery = {
    sortBy: sortSel.value.startsWith('amount') ? 'amount' : 'time',
    sortDir: sortSel.value.endsWith('asc') ? 'asc' : 'desc',
  };
  if (selectedTypes.value.length > 0) q.types = [...selectedTypes.value];
  if (selectedAccountIds.value.length > 0) q.accountIds = [...selectedAccountIds.value];
  const catIds = categoryIdsForNames(selectedCategoryNames.value);
  if (catIds.length > 0) q.categoryIds = catIds;
  if (selectedTagIds.value.length > 0) q.tagIds = [...selectedTagIds.value];
  if (amountMinCents.value !== null) q.amountMin = amountMinCents.value;
  if (amountMaxCents.value !== null) q.amountMax = amountMaxCents.value;
  return q;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    baseTxns.value = await txnService.query(activeQuery.value);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  loadRecent();
  await loadStatic();
  await load();
});

// 结构化筛选变化 → 重发 query（敲关键词不重查库，见 §七坑位6）。
watch(activeQuery, () => void load(), { deep: true });

// ============================================================
// 关键词前端过滤（§四.3）：在【搜索范围】勾选的字段里匹配 kw（不区分大小写）。
//   范围决定参与匹配的字段（标题/备注/分类名/任一标签名），默认四项全含。
// ============================================================
const hitTxns = computed<TxnWithTags[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return baseTxns.value;
  const fields = searchFields.value;
  const useTitle = fields.includes('title');
  const useNote = fields.includes('note');
  const useCat = fields.includes('category');
  const useTag = fields.includes('tag');
  return baseTxns.value.filter((t) => {
    if (useTitle && t.title && t.title.toLowerCase().includes(kw)) return true;
    if (useNote && t.note && t.note.toLowerCase().includes(kw)) return true;
    if (useCat) {
      const catName = t.categoryId ? categoryById.value.get(t.categoryId)?.name : '';
      if (catName && catName.toLowerCase().includes(kw)) return true;
    }
    if (useTag && t.tags.some((tag) => tag.name.toLowerCase().includes(kw))) return true;
    return false;
  });
});

// ============================================================
// 命中汇总（整数分；transfer 恒排除于金额合计外，§红线1）
// ============================================================
/** 命中笔数：含转账（它确实"命中"了）。金额合计只算收支。 */
const hitCount = computed<number>(() => hitTxns.value.length);
const hitExpense = computed<number>(() =>
  hitTxns.value.reduce((s, t) => (t.type === 'expense' ? s + t.amount : s), 0),
);
const hitIncome = computed<number>(() =>
  hitTxns.value.reduce((s, t) => (t.type === 'income' ? s + t.amount : s), 0),
);

/** 三卡副标题：说明当前关键词/时间口径。 */
const summaryHint = computed<string>(() => {
  const kw = keyword.value.trim();
  return kw ? `关键词「${kw}」 · 全部时间` : '全部交易 · 全部时间';
});

/**
 * 折合全年（按筛选结果跨度）：把命中【支出】按其首末日期的日均速率外推到 365 天，
 *   用来估「这类支出扩展到一整年大概多少」。仅支出、排除转账，与"支出合计"同源；整数分。
 *   跨度天数 = round((最晚一笔 − 最早一笔) / 一天毫秒)，折合全年 = round(支出合计 / 跨度 × 365)。
 *   支出 < 2 笔（无从算速率）或跨度 = 0（集中在同一天，外推会得到天文数字）→ amount=null，
 *   UI 显示"—"并在副标题说明原因；绝不给会误导的数字。hint 附上依据便于自行判断可信度。
 */
const annual = computed<{ amount: number | null; hint: string }>(() => {
  const list = hitTxns.value.filter((t) => t.type === 'expense');
  if (list.length < 2) return { amount: null, hint: '支出样本不足（需 ≥2 笔）' };
  let min = Infinity;
  let max = -Infinity;
  for (const t of list) {
    if (t.time < min) min = t.time;
    if (t.time > max) max = t.time;
  }
  const spanDays = Math.round((max - min) / 86400000);
  if (spanDays <= 0) return { amount: null, hint: '支出集中在同一天，无法折算' };
  return {
    amount: Math.round((hitExpense.value / spanDays) * 365),
    hint: `基于 ${spanDays} 天 · ${list.length} 笔支出`,
  };
});

// ============================================================
// 命中列表【不分组】：所有命中交易同处一级，整体按展示排序（sortSel）排列。
//   query 已按 sortBy/sortDir 排好，hitTxns 保持该顺序直接平铺渲染，
//   每行自带日期（rowDateText），无需组头。
// ============================================================
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ============================================================
// 选中交易详情
// ============================================================
const selectedId = ref<Id | null>(null);
function selectTxn(id: Id): void {
  selectedId.value = id;
}
/** 选中项须仍在命中列表内（筛选收窄后自动失效回占位）。 */
const selectedTxn = computed<TxnWithTags | null>(
  () => hitTxns.value.find((t) => t.id === selectedId.value) ?? null,
);

// ============================================================
// 纯函数工具（渲染 / 格式化）
// ============================================================
function isToday(d: Date): boolean {
  const t = new Date();
  return (
    d.getFullYear() === t.getFullYear() &&
    d.getMonth() === t.getMonth() &&
    d.getDate() === t.getDate()
  );
}

/** 组头日期文案：如「8月8日 · 今天」/「8月7日 · 周四」。 */
function dayLabel(d: Date): string {
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const suffix = isToday(d) ? '今天' : WEEKDAYS[d.getDay()];
  return `${md} · ${suffix}`;
}

/** 平铺列表每行日期（不分组后每行自带）：如「8月8日 · 今天」。 */
function rowDateText(t: TxnWithTags): string {
  return dayLabel(new Date(t.time));
}

/** ARGB 整数转 CSS rgba，用于账户/分类色标（与 Overview/AddTxn 一致）。 */
function argbToCss(argb: number): string {
  const u = argb >>> 0;
  const a = ((u >>> 24) & 0xff) / 255;
  const r = (u >>> 16) & 0xff;
  const g = (u >>> 8) & 0xff;
  const b = u & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${a === 0 ? 1 : a})`;
}

function accountName(id: Id | null): string {
  if (!id) return '';
  return accounts.value.find((a) => a.id === id)?.name ?? '';
}
function accountColor(id: Id | null): string {
  if (!id) return 'var(--fg-3)';
  const acc = accounts.value.find((a) => a.id === id);
  return acc ? argbToCss(acc.color) : 'var(--fg-3)';
}
function categoryName(id: Id | null): string {
  if (!id) return '';
  return categoryById.value.get(id)?.name ?? '';
}

/** 交易左侧色块颜色：转账中性靛紫；收支优先分类色，无分类回退账户色。 */
function txnColor(t: TxnWithTags): string {
  if (t.type === 'transfer') return 'var(--transfer)';
  if (t.categoryId) {
    const cat = categoryById.value.get(t.categoryId);
    if (cat) return argbToCss(cat.color);
  }
  return accountColor(t.accountId);
}

/** 交易标题：优先 title；空则回退分类名，再回退占位。 */
function txnTitle(t: TxnWithTags): string {
  if (t.title && t.title.trim()) return t.title;
  const cat = categoryName(t.categoryId);
  if (cat) return cat;
  if (t.type === 'transfer') return '转账';
  return '(无标题)';
}

/** 交易金额展示：支出 −、收入 +、转账中性无符号。金额一律经 money.format(+千分位)。 */
function txnAmountText(t: TxnWithTags): string {
  if (t.type === 'expense') return `−${fmtMoney(t.amount)}`;
  if (t.type === 'income') return `+${fmtMoney(t.amount)}`;
  return fmtMoney(t.amount); // transfer：不带正负
}
function txnAmountClass(t: TxnWithTags): string {
  if (t.type === 'expense') return 'neg';
  if (t.type === 'income') return 'pos';
  return 'tr';
}
function typeLabel(t: TxnType): string {
  return t === 'income' ? '收入' : t === 'expense' ? '支出' : '转账';
}
function typeBadgeClass(t: TxnType): string {
  return t === 'income' ? 'badge-income' : t === 'expense' ? 'badge-expense' : 'badge-transfer';
}

/** 详情：完整日期「2026年8月8日 · 今天」（时间统一到「天」，不显示时分）。 */
function fullDateTimeText(t: TxnWithTags): string {
  const d = new Date(t.time);
  return `${d.getFullYear()}年${dayLabel(d)}`;
}
/** 详情：ISO 短日期「2026-08-08」。 */
function isoDate(t: TxnWithTags): string {
  const d = new Date(t.time);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ============================================================
// 金额展示（一律经 money.format；此处仅在展示层加千分位，不改 money.ts）
// ============================================================
/** 对 money.format 结果的整数部分插千分位逗号（照抄 Reports.vue 的 withThousands）。 */
function withThousands(s: string): string {
  return s.replace(/\d+(?=\.)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}
function fmtMoney(cents: number, opts?: { sign?: boolean; symbol?: string }): string {
  return withThousands(format(cents, opts));
}

// ============================================================
// 高亮（在原文上分段匹配、每段各自转义、只对命中段包 <mark>，防 XSS，§七坑位5）
// ============================================================
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * 返回把 text 里所有（不区分大小写）匹配 kw 的片段用 <mark> 包裹的安全 HTML。
 *   在【原始】文本上做大小写不敏感的分段定位，命中段与非命中段各自 escapeHtml、
 *   只对命中段包 <mark>。避免"先整段转义再正则替换"会误匹配 &lt;/&amp; 实体内部字母、
 *   把 <mark> 塞进实体中间（既打断实体、又假命中原文并不存在的字母）。
 *   在原文而非正则上匹配，也天然免疫正则元字符 kw。
 *   kw 为空 → 直接返回转义后的纯文本（无 mark）。
 */
function highlight(text: string, kw: string): string {
  const src = text ?? '';
  const k = kw.trim();
  if (!k) return escapeHtml(src);
  const lowerSrc = src.toLowerCase();
  const lowerKw = k.toLowerCase();
  let out = '';
  let i = 0;
  while (i < src.length) {
    const idx = lowerSrc.indexOf(lowerKw, i);
    if (idx === -1) {
      out += escapeHtml(src.slice(i));
      break;
    }
    out += escapeHtml(src.slice(i, idx));
    out += `<mark>${escapeHtml(src.slice(idx, idx + k.length))}</mark>`;
    i = idx + k.length;
  }
  return out;
}
/**
 * 字段级高亮：仅当该字段在【搜索范围】内时才高亮，否则只转义不加 <mark>。
 *   使高亮准确表达「因哪个字段命中」——只搜标题时，备注里恰含关键词也不误标黄。
 */
function highlightField(text: string, field: SearchField): string {
  return fieldOn(field) ? highlight(text, keyword.value) : escapeHtml(text ?? '');
}

// ============================================================
// 最近搜索（localStorage 持久化，纯本地 UI 便利，不入库/不进云备份，§四.7）
// ============================================================
const RECENT_KEY = 'search:recent';
const RECENT_MAX = 8;
const recentSearches = ref<string[]>([]);

function loadRecent(): void {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      recentSearches.value = arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX);
    }
  } catch {
    // 损坏的历史忽略即可（纯 UI 便利）。
    recentSearches.value = [];
  }
}
function persistRecent(): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches.value));
  } catch {
    // localStorage 不可用（隐私模式等）→ 静默降级，不影响搜索。
  }
}
function addRecent(kw: string): void {
  const k = kw.trim();
  if (!k) return;
  const next = [k, ...recentSearches.value.filter((x) => x !== k)].slice(0, RECENT_MAX);
  recentSearches.value = next;
  persistRecent();
}
function applyRecent(kw: string): void {
  keyword.value = kw;
  addRecent(kw); // 点击即置顶
}
function clearRecent(): void {
  recentSearches.value = [];
  persistRecent();
}

// 停止输入 500ms 后把非空关键词计入最近搜索（回车即时计入见 onSearchEnter）。
let recentTimer: ReturnType<typeof setTimeout> | undefined;
watch(keyword, (val) => {
  if (recentTimer) clearTimeout(recentTimer);
  const k = val.trim();
  if (!k) return;
  recentTimer = setTimeout(() => addRecent(k), 500);
});
function onSearchEnter(): void {
  if (recentTimer) clearTimeout(recentTimer);
  addRecent(keyword.value);
}
function clearKeyword(): void {
  keyword.value = '';
}
onBeforeUnmount(() => {
  if (recentTimer) clearTimeout(recentTimer);
});

// ============================================================
// 筛选 chip 增删（照抄 Reports.vue；含 transfer 类型可选）
// ============================================================
type AddDim = 'type' | 'account' | 'category' | 'tag' | 'amount';
const addOpen = ref(false);
const addDim = ref<AddDim | null>(null);
const amountMinInput = ref<string>('');
const amountMaxInput = ref<string>('');

const ALL_TYPES: ReadonlyArray<TxnType> = ['expense', 'income', 'transfer'];

function openAdd(): void {
  addOpen.value = true;
  addDim.value = null;
}
function closeAdd(): void {
  addOpen.value = false;
  addDim.value = null;
}

function toggleType(t: TxnType): void {
  const i = selectedTypes.value.indexOf(t);
  if (i >= 0) selectedTypes.value.splice(i, 1);
  else selectedTypes.value.push(t);
}
function toggleAccount(id: Id): void {
  const i = selectedAccountIds.value.indexOf(id);
  if (i >= 0) selectedAccountIds.value.splice(i, 1);
  else selectedAccountIds.value.push(id);
}
function toggleCategoryName(name: string): void {
  const i = selectedCategoryNames.value.indexOf(name);
  if (i >= 0) selectedCategoryNames.value.splice(i, 1);
  else selectedCategoryNames.value.push(name);
}
function toggleTag(id: Id): void {
  const i = selectedTagIds.value.indexOf(id);
  if (i >= 0) selectedTagIds.value.splice(i, 1);
  else selectedTagIds.value.push(id);
}
function applyAmount(): void {
  const min = amountMinInput.value.trim();
  const max = amountMaxInput.value.trim();
  amountMinCents.value = min ? Math.round(Number(min) * 100) : null;
  amountMaxCents.value = max ? Math.round(Number(max) * 100) : null;
  closeAdd();
}
function clearAmount(): void {
  amountMinCents.value = null;
  amountMaxCents.value = null;
  amountMinInput.value = '';
  amountMaxInput.value = '';
}
const amountChipLabel = computed<string>(() => {
  const parts: string[] = [];
  if (amountMinCents.value !== null) parts.push(`≥${fmtMoney(amountMinCents.value)}`);
  if (amountMaxCents.value !== null) parts.push(`≤${fmtMoney(amountMaxCents.value)}`);
  return parts.join(' ');
});
const hasAmountChip = computed(() => amountMinCents.value !== null || amountMaxCents.value !== null);

function tagName(id: Id): string {
  return tags.value.find((t) => t.id === id)?.name ?? '';
}

const hasAnyFilter = computed(
  () =>
    selectedTypes.value.length > 0 ||
    selectedAccountIds.value.length > 0 ||
    selectedCategoryNames.value.length > 0 ||
    selectedTagIds.value.length > 0 ||
    hasAmountChip.value ||
    keyword.value.trim().length > 0,
);
function clearAll(): void {
  selectedTypes.value = [];
  selectedAccountIds.value = [];
  selectedCategoryNames.value = [];
  selectedTagIds.value = [];
  clearAmount();
  keyword.value = '';
  searchFields.value = [...DEFAULT_SEARCH_FIELDS];
}
</script>

<template>
  <div class="content">
    <!-- 命中计数 -->
    <div class="search-head">
      <span class="page-sub">共</span>
      <span class="badge badge-expense">命中 {{ hitCount }} 笔</span>
    </div>

    <!-- 大号搜索框 -->
    <div class="search-box">
      <span class="s-lead">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4-4" />
        </svg>
      </span>
      <input
        class="input"
        v-model="keyword"
        aria-label="搜索交易"
        placeholder="搜索标题 / 备注 / 分类 / 标签…"
        @keydown.enter="onSearchEnter"
      />
      <button v-if="keyword" class="s-clear" aria-label="清除" @click="clearKeyword">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- 搜索范围 + 可叠加筛选：同一行。范围（关键词作用字段，至少留 1 项）在前，
         细分隔符后接已选筛选 chips 与「添加筛选」入口。 -->
    <div class="scope-row mt-3">
      <span class="scope-key">搜索范围</span>
      <button
        v-for="f in SEARCH_FIELDS"
        :key="'sf-' + f.v"
        class="pill scope-pill"
        :class="{ 'pill-active': fieldOn(f.v) }"
        :aria-pressed="fieldOn(f.v)"
        @click="toggleField(f.v)"
      >
        {{ f.label }}
      </button>

      <span class="filter-sep" aria-hidden="true"></span>

      <!-- 可叠加筛选 chips -->
      <span v-for="t in selectedTypes" :key="'ty-' + t" class="chip chip-on">
        类型：{{ typeLabel(t) }} <span class="x" role="button" @click="toggleType(t)">×</span>
      </span>
      <span v-for="id in selectedAccountIds" :key="'ac-' + id" class="chip chip-on">
        账户：{{ accountName(id) }} <span class="x" role="button" @click="toggleAccount(id)">×</span>
      </span>
      <span v-for="name in selectedCategoryNames" :key="'ca-' + name" class="chip chip-on">
        分类：{{ name }} <span class="x" role="button" @click="toggleCategoryName(name)">×</span>
      </span>
      <span v-for="id in selectedTagIds" :key="'tg-' + id" class="chip chip-on">
        标签：{{ tagName(id) }} <span class="x" role="button" @click="toggleTag(id)">×</span>
      </span>
      <span v-if="hasAmountChip" class="chip chip-on">
        金额：{{ amountChipLabel }} <span class="x" role="button" @click="clearAmount()">×</span>
      </span>

      <!-- 添加筛选 -->
      <span class="add-wrap">
        <span class="chip chip-add" role="button" @click="addOpen ? closeAdd() : openAdd()">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          添加筛选
        </span>

        <!-- 弹层：一级选维度 / 二级选项 -->
        <div v-if="addOpen" class="add-backdrop" @click="closeAdd()"></div>
        <div v-if="addOpen" class="add-menu">
          <template v-if="addDim === null">
            <button class="add-item" @click="addDim = 'type'">类型</button>
            <button class="add-item" @click="addDim = 'account'">账户</button>
            <button class="add-item" @click="addDim = 'category'">分类</button>
            <button class="add-item" @click="addDim = 'tag'">标签</button>
            <button class="add-item" @click="addDim = 'amount'">金额范围</button>
          </template>

          <template v-else>
            <button class="add-back" @click="addDim = null">‹ 返回</button>

            <template v-if="addDim === 'type'">
              <button
                v-for="t in ALL_TYPES"
                :key="'opt-ty-' + t"
                class="add-opt"
                :class="{ sel: selectedTypes.includes(t) }"
                @click="toggleType(t)"
              >
                {{ typeLabel(t) }}
              </button>
            </template>

            <template v-else-if="addDim === 'account'">
              <div v-if="accounts.length === 0" class="add-empty">暂无账户</div>
              <button
                v-for="a in accounts"
                :key="a.id"
                class="add-opt"
                :class="{ sel: selectedAccountIds.includes(a.id) }"
                @click="toggleAccount(a.id)"
              >
                {{ a.name }}
              </button>
            </template>

            <template v-else-if="addDim === 'category'">
              <div v-if="uniqueCategoryNames.length === 0" class="add-empty">暂无分类</div>
              <button
                v-for="name in uniqueCategoryNames"
                :key="name"
                class="add-opt"
                :class="{ sel: selectedCategoryNames.includes(name) }"
                @click="toggleCategoryName(name)"
              >
                {{ name }}
              </button>
            </template>

            <template v-else-if="addDim === 'tag'">
              <div v-if="tags.length === 0" class="add-empty">暂无标签</div>
              <button
                v-for="tg in tags"
                :key="tg.id"
                class="add-opt"
                :class="{ sel: selectedTagIds.includes(tg.id) }"
                @click="toggleTag(tg.id)"
              >
                {{ tg.name }}
              </button>
            </template>

            <template v-else-if="addDim === 'amount'">
              <div class="add-amount">
                <input class="input" v-model="amountMinInput" placeholder="最小(元)" inputmode="decimal" />
                <input class="input" v-model="amountMaxInput" placeholder="最大(元)" inputmode="decimal" />
                <button class="btn btn-primary btn-sm btn-block" @click="applyAmount()">应用</button>
              </div>
            </template>
          </template>
        </div>

        <span
          v-if="hasAnyFilter"
          class="chip chip-add"
          role="button"
          style="border-style: solid"
          @click="clearAll()"
        >
          清空
        </span>
      </span>
    </div>

    <!-- 最近搜索 -->
    <div v-if="recentSearches.length" class="recent-row mt-3">
      <span class="r-key">最近搜索</span>
      <span
        v-for="kw in recentSearches"
        :key="'rc-' + kw"
        class="pill"
        role="button"
        @click="applyRecent(kw)"
      >
        {{ kw }}
      </span>
      <span class="pill recent-clear" role="button" @click="clearRecent()">清除历史</span>
    </div>

    <div class="divider"></div>

    <!-- 命中收支汇总四卡 -->
    <div class="grid sum-strip">
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          命中笔数
        </div>
        <div class="s-value num">{{ hitCount }}</div>
        <div class="s-trend">{{ summaryHint }}</div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          支出合计
        </div>
        <div class="s-value neg num">−{{ fmtMoney(hitExpense) }}</div>
        <div class="s-trend">仅统计支出（不含转账）</div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
          收入合计
        </div>
        <div class="s-value pos num" :class="{ faint: hitIncome === 0 }">
          {{ fmtMoney(hitIncome, { sign: true }) }}
        </div>
        <div class="s-trend">仅统计收入（不含转账）</div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3v18h18" />
            <path d="m7 14 4-4 3 3 5-6" />
          </svg>
          折合全年
        </div>
        <div class="s-value num" :class="{ faint: annual.amount === null }">
          <template v-if="annual.amount === null">—</template>
          <template v-else>≈ −{{ fmtMoney(annual.amount) }}</template>
        </div>
        <div class="s-trend">{{ annual.hint }}</div>
      </div>
    </div>

    <!-- 双栏：命中列表 + 选中交易详情 -->
    <div class="two-col search-two-col mt-4">
      <!-- 左：命中交易列表（按日期分组） -->
      <div class="card">
        <div class="card-head">
          <h3>命中交易</h3>
          <div class="row gap-3" style="align-items: center">
            <span class="faint" style="font-size: 13px">{{ hitCount }} 笔</span>
            <label class="pill pill-active">
              <span class="p-key">排序</span>
              <select v-model="sortSel" class="sort-select" aria-label="展示排序">
                <option v-for="o in SORT_OPTS" :key="o.v" :value="o.v">{{ o.label }}</option>
              </select>
            </label>
          </div>
        </div>
        <div class="card-pad" style="padding-top: 4px">
          <!-- 空态 -->
          <div v-if="!loading && hitTxns.length === 0" class="empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4-4" />
            </svg>
            <div style="font-weight: 700; color: var(--fg-2)">没有命中的交易</div>
            <div class="mt-2">换个关键词，或调整/清空筛选条件。</div>
          </div>

          <!-- 命中列表不分组：所有交易同处一级，整体按展示排序排列，每行自带日期。 -->
          <div
            v-for="t in hitTxns"
            :key="t.id"
            class="txn txn-clickable"
            :class="{ 'txn-selected': t.id === selectedId }"
            role="button"
            tabindex="0"
            @click="selectTxn(t.id)"
            @keydown.enter="selectTxn(t.id)"
          >
            <div class="ic-tile" :style="{ background: txnColor(t) }">
              <svg v-if="t.type === 'expense'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12l7 7 7-7" />
              </svg>
              <svg v-else-if="t.type === 'income'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 3l4 4-4 4M7 21l-4-4 4-4M21 7H8M3 17h13" />
              </svg>
            </div>
            <div class="txn-main">
              <div class="txn-title">
                <span v-html="highlightField(txnTitle(t), 'title')"></span>
                <span v-if="t.type === 'transfer'" class="badge badge-transfer" style="margin-left: 6px">转账</span>
                <span v-else-if="t.type === 'income'" class="badge badge-income" style="margin-left: 6px">收入</span>
              </div>
              <div class="txn-sub">
                <template v-if="t.type === 'transfer'">
                  <span>{{ accountName(t.accountId) }} → {{ accountName(t.toAccountId) }}</span>
                </template>
                <template v-else>
                  <span>{{ accountName(t.accountId) }}</span>
                  <template v-if="categoryName(t.categoryId)">
                    <span class="sub-dot">·</span>
                    <span v-html="highlightField(categoryName(t.categoryId), 'category')"></span>
                  </template>
                </template>
                <template v-if="t.tags.length">
                  <span class="sep" />
                  <span
                    v-for="tag in t.tags"
                    :key="tag.id"
                    class="tag-inline"
                    v-html="highlightField(tag.name, 'tag')"
                  ></span>
                </template>
              </div>
              <div v-if="t.note && t.note.trim()" class="txn-note" :title="t.note">
                <span v-html="highlightField(t.note, 'note')"></span>
              </div>
            </div>
            <div class="txn-right">
              <div class="txn-amt num" :class="txnAmountClass(t)">{{ txnAmountText(t) }}</div>
              <div class="txn-date">{{ rowDateText(t) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右：选中交易详情卡 -->
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head">
            <h3>交易详情</h3>
            <span v-if="selectedTxn" class="badge" :class="typeBadgeClass(selectedTxn.type)">
              {{ typeLabel(selectedTxn.type) }}
            </span>
          </div>
          <div class="card-pad" style="padding-top: 14px">
            <!-- 未选中占位 -->
            <div v-if="!selectedTxn" class="empty" style="padding: 32px 16px">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M9 11l3 3 8-8" />
                <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
              </svg>
              <div style="font-weight: 700; color: var(--fg-2)">点击左侧交易查看详情</div>
            </div>

            <template v-else>
              <div class="row gap-3" style="align-items: flex-start">
                <div class="ic-tile lg" :style="{ background: txnColor(selectedTxn) }">
                  <svg v-if="selectedTxn.type === 'expense'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 5v14M5 12l7 7 7-7" />
                  </svg>
                  <svg v-else-if="selectedTxn.type === 'income'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17 3l4 4-4 4M7 21l-4-4 4-4M21 7H8M3 17h13" />
                  </svg>
                </div>
                <div style="flex: 1; min-width: 0">
                  <div style="font-weight: 700; font-size: 16px" v-html="highlightField(txnTitle(selectedTxn), 'title')"></div>
                  <div class="muted" style="font-size: 12px; margin-top: 2px">{{ fullDateTimeText(selectedTxn) }}</div>
                </div>
              </div>

              <div class="s-value num" :class="txnAmountClass(selectedTxn)" style="font-size: 32px; font-weight: 800; margin: 14px 0 6px">
                {{ txnAmountText(selectedTxn) }}
              </div>

              <div class="divider" style="margin: 8px 0 4px"></div>

              <div class="detail-kv">
                <span class="k">账户</span>
                <span class="v">
                  <span class="acc-dot" :style="{ background: accountColor(selectedTxn.accountId) }"></span>
                  {{ accountName(selectedTxn.accountId) }}
                </span>
              </div>
              <div v-if="selectedTxn.type === 'transfer'" class="detail-kv">
                <span class="k">转入账户</span>
                <span class="v">
                  <span class="acc-dot" :style="{ background: accountColor(selectedTxn.toAccountId) }"></span>
                  {{ accountName(selectedTxn.toAccountId) }}
                </span>
              </div>
              <div v-else class="detail-kv">
                <span class="k">分类</span>
                <span class="v" v-html="highlightField(categoryName(selectedTxn.categoryId) || '未分类', 'category')"></span>
              </div>
              <div class="detail-kv">
                <span class="k">日期</span>
                <span class="v num">{{ isoDate(selectedTxn) }}</span>
              </div>
              <div class="detail-kv">
                <span class="k">标签</span>
                <span class="v">
                  <template v-if="selectedTxn.tags.length">
                    <span
                      v-for="tag in selectedTxn.tags"
                      :key="tag.id"
                      class="tag-inline"
                      v-html="highlightField(tag.name, 'tag')"
                    ></span>
                  </template>
                  <span v-else class="faint">无</span>
                </span>
              </div>

              <div v-if="selectedTxn.note && selectedTxn.note.trim()" style="margin-top: 12px">
                <span class="field-label">备注</span>
                <div class="detail-note" v-html="highlightField(selectedTxn.note, 'note')"></div>
              </div>

              <div class="row gap-2 mt-4">
                <button class="btn btn-ghost btn-sm btn-block" @click="openEdit(selectedTxn.id)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4v16h16v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" />
                  </svg>
                  编辑
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 命中计数行 */
.search-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.search-head .page-sub {
  font-size: var(--fs-sm);
  color: var(--fg-3);
  font-weight: 600;
}

/* 展示排序下拉（嵌在 pill 里的原生 select，去边框透明化；从报告页迁入） */
.sort-select {
  background: none;
  border: none;
  outline: none;
  font-weight: 600;
  color: var(--primary);
  cursor: pointer;
}

/* 大号搜索框（照抄 search.html 局部样式） */
.search-box {
  position: relative;
  display: flex;
  align-items: center;
}
.search-box .s-lead {
  position: absolute;
  left: 14px;
  color: var(--fg-3);
  display: grid;
  place-items: center;
}
.search-box .s-clear {
  position: absolute;
  right: 10px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--fg-2);
  background: var(--surface-2);
}
.search-box .s-clear:hover {
  background: var(--surface-3);
}
.search-box input.input {
  padding-left: 42px;
  padding-right: 44px;
  height: 46px;
  font-size: 16px;
  font-weight: 600;
}

/* 命中高亮（token 无对应荧光色，故此处为可接受的具体色值，照抄设计稿）。
   mark 由 v-html 注入、非组件作用域，故用 :deep；深色变体的 .dark 挂在祖先 <html>
   上，需用 :global 命中（scoped 前缀会错加到 .dark 上）。 */
:deep(mark) {
  background: #fff3c4;
  color: inherit;
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 700;
}
:global(.dark mark) {
  background: #6b5a12;
  color: #fdf3c9;
}

/* 筛选 chip 的删除叉（× / 清空按钮同 z-index 见下） */
.chip .x {
  cursor: pointer;
}

/* z-index 坑（S9 踩过）：让筛选 chip、添加/清空按钮位于 add-backdrop 之上，
   否则弹层打开时全屏遮罩会盖住这些 chip，导致 × / 清空点不到。
   S11：整套下拉层级抬到手机底栏(.m-tabbar z:30 / .m-fab z:31)之上，
   否则窄屏/矮屏下菜单底部会被固定底栏盖住、点击落到底栏误切页。band=40/41/42。 */
.add-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.chip-on,
.chip-add {
  position: relative;
  z-index: 42;
}
.add-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.add-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 41;
  min-width: 170px;
  max-height: 280px;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--sh-3);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.add-item,
.add-opt,
.add-back {
  text-align: left;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--fg);
}
.add-item:hover,
.add-opt:hover {
  background: var(--surface-2);
}
.add-back {
  color: var(--fg-3);
}
.add-opt.sel {
  background: var(--primary-soft);
  color: var(--primary);
}
.add-opt.sel::after {
  content: '✓';
  margin-left: 8px;
}
.add-empty {
  padding: 8px 10px;
  font-size: var(--fs-sm);
  color: var(--fg-3);
}
.add-amount {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px;
}

/* 搜索范围：字段多选 pill 行（复用 .pill / .pill-active）。 */
.scope-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.scope-row .scope-key {
  font-size: var(--fs-xs);
  color: var(--fg-3);
  font-weight: 700;
  letter-spacing: 0.04em;
}
.scope-pill {
  cursor: pointer;
}

/* 搜索范围与筛选合并同一行时的细竖分隔符：区隔「作用字段」与「叠加筛选」两类。
   无筛选时它就是范围 pills 末尾的一个小竖线，语义上标示后面可继续添加筛选。 */
.filter-sep {
  width: 1px;
  align-self: stretch;
  min-height: 20px;
  background: var(--border);
  margin: 0 2px;
}

/* 最近搜索 */
.recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.recent-row .r-key {
  font-size: var(--fs-xs);
  color: var(--fg-3);
  font-weight: 700;
  letter-spacing: 0.04em;
}
.recent-row .pill {
  cursor: pointer;
}
.recent-row .recent-clear {
  color: var(--fg-3);
  border-style: dashed;
}

/* 命中汇总条：桌面四卡等宽（.grid 已给 display:grid+gap，此处只定列数，
   不复用全局 .g-3 以免其 repeat(3) 特异性盖过下方响应式覆盖）。 */
.sum-strip {
  grid-template-columns: repeat(4, 1fr);
}
.sum-strip .stat {
  padding: 14px 16px;
}
.sum-strip .s-value {
  font-size: 24px;
}

/* 双栏：左结果自适应、右详情固定 320px（对照设计稿桌面稿）。 */
.search-two-col {
  height: auto;
  grid-template-columns: 1fr 320px;
  align-items: start;
}

/* 右详情列随页面滚动吸顶跟随：桌面双栏下左命中列表常远长于右详情卡，
   让详情列 sticky 停靠、滚动时始终可见（滚动容器是 .content，58px 顶栏是其上方
   不滚动的兄弟节点，故吸顶点不被顶栏遮挡）。top 对齐 .content 的 22px 内边距，
   静止态与吸顶态位置一致、无跳动。sticky 生效前提是该列不被拉伸到整行高——
   已由上面的 align-items:start 保证。窄屏单列时在 900px 段还原为 static。 */
.search-two-col > .stack {
  position: sticky;
  top: 22px;
}

/* 结果行可点击 + 选中高亮（负 margin 让底色铺满行内边距，照抄 Overview）。 */
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
.txn-selected,
.txn-selected:hover {
  background: var(--primary-soft);
}
.txn-sub .sub-dot {
  color: var(--fg-3);
}
/* 平铺列表右列：金额在上、日期在下（不分组后每行自带日期，右对齐不抢主信息）。 */
.txn-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.txn-date {
  font-size: var(--fs-xs);
  color: var(--fg-3);
  white-space: nowrap;
}
.txn-note {
  font-size: var(--fs-xs);
  color: var(--fg-3);
  opacity: 0.75;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 详情键值行（照抄设计稿） */
.detail-kv {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-sm);
}
.detail-kv:last-child {
  border-bottom: none;
}
.detail-kv .k {
  color: var(--fg-3);
  font-weight: 600;
  flex-shrink: 0;
}
.detail-kv .v {
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
  text-align: right;
}
.acc-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.detail-note {
  color: var(--fg-2);
  font-size: 13px;
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: 10px 12px;
  margin-top: 6px;
  word-break: break-word;
}

/* 窄视口退化为单列（手机端细做留待后续，仅伏笔）。 */
@media (max-width: 900px) {
  .search-two-col {
    grid-template-columns: 1fr;
  }
  /* 单列后 grid 列默认 minmax(auto,1fr)，auto 最小值=子项 max-content 宽，
     会被命中列表里的长标题/备注撑破视口 → 窄屏横向滚动（真实数据 375px 复现）。
     给两列子项补 min-width:0，让列可收缩到容器宽度。（桌面双栏用固定 320px 列，不受影响。） */
  .search-two-col > * {
    min-width: 0;
  }
  /* 单列下详情卡落到列表下方，吸顶跟随无意义且会遮挡列表，还原为普通流。 */
  .search-two-col > .stack {
    position: static;
  }
  /* 汇总条：900px 内先收成两列（≤720 再塌单列，见下段）。 */
  .sum-strip {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* ============================================================
   手机端（≤720px）：双栏已塌单列（列表在上、详情卡在下，单列可用）；
   此处补齐搜索框、汇总三卡、弹层不溢出。不改搜索/过滤/高亮逻辑。
   ============================================================ */
@media (max-width: 720px) {
  /* 汇总四卡塌成单列，避免 SE 375 等窄屏横向溢出。 */
  .sum-strip {
    grid-template-columns: 1fr;
  }

  /* 搜索框铺满、字段可点区域足够 */
  .search-box input.input {
    height: 44px;
  }

  /* 添加筛选弹层不超出视口 */
  .add-menu {
    max-width: calc(100vw - 32px);
  }

  /* 详情卡内容不被长文本撑破 */
  .detail-kv .v {
    min-width: 0;
    word-break: break-word;
  }
}
</style>
