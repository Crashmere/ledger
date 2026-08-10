<script setup lang="ts">
// ============================================================
// Reports.vue —— 报告页（Analysis，S9 · Priority 4）
// ============================================================
// 对照 设计稿/reports.html 桌面稿还原：
//   时间范围选择器 + 逐步筛选(chips) → 汇总三卡 → 饼图(分类占比)+趋势图并排 → 分类明细排行。
//
// 数据源架构（重要设计决策，见 S9 任务书 §二/§四/§六.4/§六.7）：
//   报告页要求「类型/账户/分类/标签/金额范围」任意 chip 都能实时收窄「全页统计」，
//   且饼图/排行/汇总三处数字必须自洽（§六.4）。而 StatsService 的
//   summary/breakdownByCategory/trend 签名只接受 accountIds/timeFrom/timeTo(+types)，
//   无法表达 分类/标签/金额/关键词 维度。若对不同块用不同数据源，必然在加了这些 chip 时
//   出现口径打架。因此本页以 TxnService.query(全部筛选) 为「唯一真相源」，
//   在 TS 里按整数分派生 汇总/饼图/趋势/排行，保证四块永远自洽。
//   —— StatsService 的两个方法已按契约实现并有单测（tests/stats.test.ts）；
//      本页复刻其语义：按 category.name 跨账户合并、白名单排除 transfer、
//      本地时区分桶（复用 stats.ts 导出的 bucketOf）。
//
// 红线：
//   - 转账绝不进收支：汇总/饼图/趋势/排行只统计 income/expense（白名单）。
//   - 金额全程整数分求和，仅展示层经 money.format（+千分位薄封装，不改 money.ts）。
//   - 颜色一律引 token（--chart-*/--income/--expense），无硬编码色值。
//   - 单人应用，界面无「记账人/成员/协作/TA」等社交化词汇。
// 本阶段只做桌面宽屏；手机响应式留待后续。
// ============================================================
import { computed, onMounted, ref, watch } from 'vue';
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
import { bucketOf } from '../services/stats';

const UNCATEGORIZED = '未分类';

// ============================================================
// 时间范围（§4.3：本月 / 近30天 / 本年 / 自定义；闭区间 timeTo=次月1号−1ms）
// ============================================================
type RangeMode = 'month' | '30d' | 'year' | 'custom';
const rangeMode = ref<RangeMode>('month');
const customFrom = ref<string>(''); // yyyy-mm-dd
const customTo = ref<string>('');

const now = new Date();

/** 某天 00:00:00.000 的 epoch（本地时区）。 */
function startOfDay(y: number, m: number, d: number): number {
  return new Date(y, m, d, 0, 0, 0, 0).getTime();
}

const timeFrom = computed<number>(() => {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (rangeMode.value) {
    case 'month':
      return startOfDay(y, m, 1);
    case '30d':
      // 近 30 天：含今天在内共 30 天。
      return startOfDay(y, m, d) - 29 * 86400000;
    case 'year':
      return startOfDay(y, 0, 1);
    case 'custom': {
      if (!customFrom.value) return startOfDay(y, m, 1);
      const [cy, cm, cd] = customFrom.value.split('-').map(Number);
      return startOfDay(cy, cm - 1, cd);
    }
  }
});

const timeTo = computed<number>(() => {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (rangeMode.value) {
    case 'month':
      // 次月 1 号 00:00 减 1ms（闭区间末刻，避免 23:59:59 的毫秒/闰秒边界丢数据）。
      return startOfDay(y, m + 1, 1) - 1;
    case '30d':
      return startOfDay(y, m, d + 1) - 1; // 今天末刻
    case 'year':
      return startOfDay(y + 1, 0, 1) - 1;
    case 'custom': {
      if (!customTo.value) return startOfDay(y, m + 1, 1) - 1;
      const [cy, cm, cd] = customTo.value.split('-').map(Number);
      return startOfDay(cy, cm - 1, cd + 1) - 1; // 自定义终点当天末刻
    }
  }
});

/** 趋势粒度随范围跨度：≤ ~45 天用日，更长用月（§4.3）。 */
const granularity = computed<'day' | 'month'>(() => {
  const days = (timeTo.value - timeFrom.value) / 86400000;
  return days <= 45 ? 'day' : 'month';
});

const rangeLabel = computed<string>(() => {
  const f = new Date(timeFrom.value);
  const t = new Date(timeTo.value);
  const fmt = (d: Date) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${fmt(f)} – ${fmt(t)}`;
});

const RANGE_TABS: ReadonlyArray<{ v: RangeMode; label: string }> = [
  { v: 'month', label: '本月' },
  { v: '30d', label: '近 30 天' },
  { v: 'year', label: '本年' },
  { v: 'custom', label: '自定义' },
];

// ============================================================
// 逐步筛选状态（chips）
// ============================================================
const selectedTypes = ref<TxnType[]>([]); // 仅 income/expense 可选
const selectedAccountIds = ref<Id[]>([]);
const selectedCategoryNames = ref<string[]>([]); // 展示层按名去重
const selectedTagIds = ref<Id[]>([]);
const amountMinCents = ref<number | null>(null);
const amountMaxCents = ref<number | null>(null);
const keyword = ref<string>('');

// 排序（作用于分类明细排行；§六.8）
type SortSel = 'amount-desc' | 'amount-asc' | 'time-desc' | 'time-asc';
const sortSel = ref<SortSel>('amount-desc');
const SORT_OPTS: ReadonlyArray<{ v: SortSel; label: string }> = [
  { v: 'amount-desc', label: '金额（高→低）' },
  { v: 'amount-asc', label: '金额（低→高）' },
  { v: 'time-desc', label: '时间（新→旧）' },
  { v: 'time-asc', label: '时间（旧→新）' },
];

// 饼图方向（默认看支出分布；小切换看收入）
const pieDir = ref<Extract<TxnType, 'income' | 'expense'>>('expense');

// ============================================================
// 静态可选项（账户 / 分类名 / 标签）
// ============================================================
const accounts = ref<Account[]>([]);
const allCategories = ref<Category[]>([]);
const tags = ref<Tag[]>([]);
const categoryById = ref<Map<Id, Category>>(new Map());

/** 分类按名去重，供「添加分类条件」列选项与 chip 展示。 */
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
// 唯一真相源：按全部筛选查询交易列表
// ============================================================
const txns = ref<TxnWithTags[]>([]);
const loading = ref(false);

/** 选中的分类名 → 对应的全部 categoryId（跨账户同名都算）。 */
function categoryIdsForNames(names: string[]): Id[] {
  if (names.length === 0) return [];
  const set = new Set(names);
  return allCategories.value.filter((c) => set.has(c.name)).map((c) => c.id);
}

const activeQuery = computed<TxnQuery>(() => {
  const q: TxnQuery = {
    timeFrom: timeFrom.value,
    timeTo: timeTo.value,
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
  if (keyword.value.trim()) q.keyword = keyword.value.trim();
  return q;
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    txns.value = await txnService.query(activeQuery.value);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadStatic();
  await load();
});

// 任一筛选/范围/排序变化 → 重查（唯一真相源刷新，下游 computed 自动重算）。
watch(activeQuery, () => void load(), { deep: true });

// ============================================================
// 派生统计（全部基于 txns.value，整数分；transfer 恒排除）
// ============================================================
/** 汇总：收入合计 / 支出合计（整数分）。 */
const summaryIncome = computed<number>(() =>
  txns.value.reduce((s, t) => (t.type === 'income' ? s + t.amount : s), 0),
);
const summaryExpense = computed<number>(() =>
  txns.value.reduce((s, t) => (t.type === 'expense' ? s + t.amount : s), 0),
);
const summaryNet = computed<number>(() => summaryIncome.value - summaryExpense.value);

/** 笔数口径：当前范围内的收支笔数（不含转账），与汇总金额口径一致（§七坑位3）。 */
const summaryCount = computed<number>(
  () => txns.value.filter((t) => t.type === 'income' || t.type === 'expense').length,
);

/** 分组行（按 category.name 跨账户合并；含笔数与该组最近交易时间用于排序）。 */
interface BreakdownRow {
  name: string;
  amount: number;
  count: number;
  latest: number;
}

function buildGroups(type: 'income' | 'expense'): BreakdownRow[] {
  const map = new Map<string, BreakdownRow>();
  for (const t of txns.value) {
    if (t.type !== type) continue;
    const name = t.categoryId ? (categoryById.value.get(t.categoryId)?.name ?? UNCATEGORIZED) : UNCATEGORIZED;
    let row = map.get(name);
    if (!row) {
      row = { name, amount: 0, count: 0, latest: 0 };
      map.set(name, row);
    }
    row.amount += t.amount;
    row.count += 1;
    if (t.time > row.latest) row.latest = t.time;
  }
  // 饼图/色板基准：按金额降序（§4.1 breakdownByCategory 语义）。
  return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
}

/** 饼图/排行的分组（跟随 pieDir，默认支出）。金额降序。 */
const pieGroups = computed<BreakdownRow[]>(() => buildGroups(pieDir.value));
const pieTotal = computed<number>(() => pieGroups.value.reduce((s, r) => s + r.amount, 0));

/** 分类名 → 图表色：按金额降序位次分配 --chart-1..7，保证饼图/图例/排行同色。 */
const colorByName = computed<Map<string, string>>(() => {
  const m = new Map<string, string>();
  pieGroups.value.forEach((g, i) => m.set(g.name, `var(--chart-${(i % 7) + 1})`));
  return m;
});

/** 饼图 conic-gradient 背景（空数据兜底为中性表面色，不产生 NaN）。 */
const donutStyle = computed<Record<string, string>>(() => {
  const rows = pieGroups.value;
  const total = pieTotal.value;
  if (total <= 0 || rows.length === 0) return { background: 'var(--surface-3)' };
  const stops: string[] = [];
  let acc = 0;
  rows.forEach((r, i) => {
    const start = (acc / total) * 100;
    acc += r.amount;
    const end = (acc / total) * 100;
    stops.push(`var(--chart-${(i % 7) + 1}) ${start}% ${end}%`);
  });
  return { background: `conic-gradient(${stops.join(', ')})` };
});

/** 分类明细排行：与饼图同组，但按当前排序选项重排。 */
const rankRows = computed<BreakdownRow[]>(() => {
  const rows = [...pieGroups.value];
  const asc = sortSel.value.endsWith('asc');
  const byTime = sortSel.value.startsWith('time');
  rows.sort((a, b) => {
    const av = byTime ? a.latest : a.amount;
    const bv = byTime ? b.latest : b.amount;
    return asc ? av - bv : bv - av;
  });
  return rows;
});
const rankMax = computed<number>(() => rankRows.value.reduce((m, r) => Math.max(m, r.amount), 0));

/** 趋势点：按本地时区分桶（复用 stats.ts 的 bucketOf），bucket 升序。 */
interface TrendBar {
  bucket: string;
  income: number;
  expense: number;
}
const trendPoints = computed<TrendBar[]>(() => {
  const map = new Map<string, TrendBar>();
  for (const t of txns.value) {
    if (t.type !== 'income' && t.type !== 'expense') continue;
    const bucket = bucketOf(t.time, granularity.value);
    let bar = map.get(bucket);
    if (!bar) {
      bar = { bucket, income: 0, expense: 0 };
      map.set(bucket, bar);
    }
    if (t.type === 'income') bar.income += t.amount;
    else bar.expense += t.amount;
  }
  return Array.from(map.keys())
    .sort()
    .map((b) => map.get(b)!);
});
const trendMax = computed<number>(() => {
  let m = 0;
  for (const p of trendPoints.value) m = Math.max(m, p.income, p.expense);
  return m;
});

// ============================================================
// 展示工具（金额一律经 money.format；此处仅在展示层加千分位）
// ============================================================
/** 对 money.format 的结果整数部分插千分位逗号，符号/货币符/小数不动（不改 money.ts）。 */
function withThousands(s: string): string {
  return s.replace(/\d+(?=\.)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}
function fmtMoney(cents: number, opts?: { sign?: boolean; symbol?: string }): string {
  return withThousands(format(cents, opts));
}
/** 饼图中心整数元（四舍五入到元 + 千分位）。 */
function fmtYuanInt(cents: number): string {
  const yuan = Math.round(Math.abs(cents) / 100);
  return String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** 占比百分比字符串（total=0 兜底 0.0，不产生 NaN）。 */
function pct(amount: number): string {
  const t = pieTotal.value;
  return t > 0 ? ((amount / t) * 100).toFixed(1) : '0.0';
}
function barHeight(v: number): string {
  const m = trendMax.value;
  return m > 0 ? `${(v / m) * 100}%` : '0%';
}
function barWidth(amount: number): string {
  const m = rankMax.value;
  return m > 0 ? `${(amount / m) * 100}%` : '0%';
}
/** 趋势桶标签：月粒度「8月」；日粒度「8/8」。 */
function bucketLabel(bucket: string): string {
  const parts = bucket.split('-');
  if (parts.length === 2) return `${Number(parts[1])}月`;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function typeLabel(t: TxnType): string {
  return t === 'income' ? '收入' : t === 'expense' ? '支出' : '转账';
}
function accountName(id: Id): string {
  return accounts.value.find((a) => a.id === id)?.name ?? '';
}
function tagName(id: Id): string {
  return tags.value.find((t) => t.id === id)?.name ?? '';
}

// ============================================================
// chip 增删
// ============================================================
type AddDim = 'type' | 'account' | 'category' | 'tag' | 'amount';
const addOpen = ref(false);
const addDim = ref<AddDim | null>(null);
const amountMinInput = ref<string>('');
const amountMaxInput = ref<string>('');

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
}
</script>

<template>
  <div class="content reports">
    <!-- 顶部：时间范围选择器 + 关键词 -->
    <div class="rep-head">
      <div class="range-tabs">
        <button
          v-for="tab in RANGE_TABS"
          :key="tab.v"
          class="range-tab"
          :class="{ on: rangeMode === tab.v }"
          @click="rangeMode = tab.v"
        >
          {{ tab.label }}
        </button>
      </div>
      <div v-if="rangeMode === 'custom'" class="row gap-2 custom-range">
        <input type="date" class="input date-input" v-model="customFrom" aria-label="起始日期" />
        <span class="faint">至</span>
        <input type="date" class="input date-input" v-model="customTo" aria-label="结束日期" />
      </div>
      <span class="faint range-label num">{{ rangeLabel }}</span>
      <div class="topbar-search rep-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4-4" />
        </svg>
        <input v-model="keyword" placeholder="搜索标题 / 备注…" />
      </div>
    </div>

    <!-- 逐步筛选区（chips）+ 排序 -->
    <div class="card card-pad" style="padding: 14px 16px">
      <div class="row wrap gap-2" style="justify-content: space-between">
        <div class="row wrap gap-2">
          <span class="faint" style="font-size: 12px; font-weight: 600; margin-right: 2px">逐步筛选</span>

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

          <!-- 添加条件 -->
          <span class="add-wrap">
            <span class="chip chip-add" role="button" @click="addOpen ? closeAdd() : openAdd()">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4">
                <path d="M12 5v14M5 12h14" />
              </svg>
              添加条件
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
                    class="add-opt"
                    :class="{ sel: selectedTypes.includes('expense') }"
                    @click="toggleType('expense')"
                  >
                    支出
                  </button>
                  <button
                    class="add-opt"
                    :class="{ sel: selectedTypes.includes('income') }"
                    @click="toggleType('income')"
                  >
                    收入
                  </button>
                </template>

                <template v-else-if="addDim === 'account'">
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
          </span>

          <span
            v-if="hasAnyFilter"
            class="chip chip-add"
            role="button"
            style="border-style: solid"
            @click="clearAll()"
          >
            清空
          </span>
        </div>

        <div class="row gap-2">
          <label class="pill pill-active">
            <span class="p-key">排序</span>
            <select v-model="sortSel" class="sort-select">
              <option v-for="o in SORT_OPTS" :key="o.v" :value="o.v">{{ o.label }}</option>
            </select>
          </label>
        </div>
      </div>
    </div>

    <!-- 汇总三卡 -->
    <div class="grid g-3 mt-4">
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          支出合计
        </div>
        <div class="s-value neg num">−{{ fmtMoney(summaryExpense) }}</div>
        <div class="s-trend">{{ pieDir === 'expense' ? pieGroups.length : buildGroups('expense').length }} 个分类</div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
          收入合计
        </div>
        <div class="s-value pos num">{{ fmtMoney(summaryIncome, { sign: true }) }}</div>
        <div class="s-trend">净额 <b class="num" :class="summaryNet >= 0 ? 'pos' : 'neg'">{{ fmtMoney(summaryNet, { sign: true }) }}</b></div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
            <rect x="9" y="3" width="6" height="4" rx="1" />
            <path d="M9 12h6M9 16h4" />
          </svg>
          笔数
        </div>
        <div class="s-value num">{{ summaryCount }}</div>
        <div class="s-trend">已按当前筛选统计（不含转账）</div>
      </div>
    </div>

    <!-- 饼图 + 趋势 并排 -->
    <div class="two-col rep-two-col mt-4">
      <!-- 饼图卡 -->
      <div class="card">
        <div class="card-head">
          <h3>{{ pieDir === 'expense' ? '支出' : '收入' }}分类占比</h3>
          <div class="row gap-2">
            <button class="mini-toggle" :class="{ on: pieDir === 'expense' }" @click="pieDir = 'expense'">支出</button>
            <button class="mini-toggle" :class="{ on: pieDir === 'income' }" @click="pieDir = 'income'">收入</button>
          </div>
        </div>
        <div class="card-pad">
          <div v-if="pieGroups.length === 0" class="empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 3v9l6 3" />
            </svg>
            <div style="font-weight: 700; color: var(--fg-2)">当前范围暂无{{ pieDir === 'expense' ? '支出' : '收入' }}</div>
          </div>
          <div v-else class="row gap-4" style="align-items: center">
            <div class="donut" :style="donutStyle">
              <div class="donut-center">
                <div>
                  <div class="faint" style="font-size: 11px; font-weight: 600">{{ pieDir === 'expense' ? '支出' : '收入' }}</div>
                  <div class="mono-lg" style="font-size: 18px">¥{{ fmtYuanInt(pieTotal) }}</div>
                </div>
              </div>
            </div>
            <div class="legend" style="flex: 1">
              <div v-for="row in pieGroups" :key="'lg-' + row.name" class="legend-item">
                <span class="lg-dot" :style="{ background: colorByName.get(row.name) }"></span>
                {{ row.name }}
                <span class="lg-val num">{{ fmtMoney(row.amount) }} · {{ pct(row.amount) }}%</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 趋势卡 -->
      <div class="card">
        <div class="card-head">
          <h3>收支趋势（按{{ granularity === 'month' ? '月' : '日' }}）</h3>
          <span class="row gap-3" style="font-size: 11px; font-weight: 600">
            <span class="row gap-2"><span class="lg-dot" style="width: 9px; height: 9px; border-radius: 3px; background: var(--income)"></span>收入</span>
            <span class="row gap-2"><span class="lg-dot" style="width: 9px; height: 9px; border-radius: 3px; background: var(--expense)"></span>支出</span>
          </span>
        </div>
        <div class="card-pad">
          <div v-if="trendPoints.length === 0" class="empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M3 3v18h18" />
              <path d="M18 8l-5 5-3-3-4 4" />
            </svg>
            <div style="font-weight: 700; color: var(--fg-2)">当前范围暂无收支</div>
          </div>
          <template v-else>
            <div class="bars">
              <div v-for="p in trendPoints" :key="p.bucket" class="bcol">
                <div class="bseg" :style="{ height: barHeight(p.income), background: 'var(--income)' }"></div>
                <div class="bseg" :style="{ height: barHeight(p.expense), background: 'var(--expense)' }"></div>
                <div class="blabel">{{ bucketLabel(p.bucket) }}</div>
              </div>
            </div>
            <div class="divider"></div>
            <div class="row" style="justify-content: space-between; font-size: 12px">
              <span class="muted">收入 <b class="num pos">{{ fmtMoney(summaryIncome, { sign: true }) }}</b></span>
              <span class="muted">支出 <b class="num neg">−{{ fmtMoney(summaryExpense) }}</b></span>
              <span class="muted">净额 <b class="num" :class="summaryNet >= 0 ? 'pos' : 'neg'">{{ fmtMoney(summaryNet, { sign: true }) }}</b></span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 分类明细排行 -->
    <div class="card mt-4">
      <div class="card-head">
        <h3>分类明细（跨账户按分类名合并）</h3>
        <span class="faint" style="font-size: 13px">{{ SORT_OPTS.find((o) => o.v === sortSel)?.label }}</span>
      </div>
      <div class="card-pad">
        <div v-if="rankRows.length === 0" class="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
          </svg>
          <div style="font-weight: 700; color: var(--fg-2)">当前范围暂无{{ pieDir === 'expense' ? '支出' : '收入' }}分类</div>
        </div>
        <div v-else class="stack gap-4">
          <div v-for="row in rankRows" :key="'rk-' + row.name">
            <div class="row" style="justify-content: space-between; margin-bottom: 6px">
              <span class="row gap-2" style="font-weight: 600">
                <span class="lg-dot" style="width: 10px; height: 10px; border-radius: 3px" :style="{ background: colorByName.get(row.name) }"></span>
                {{ row.name }}
              </span>
              <span class="num muted">{{ fmtMoney(row.amount) }} · <b class="tag-inline">{{ pct(row.amount) }}%</b></span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: barWidth(row.amount), background: colorByName.get(row.name) }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 报告页顶部范围选择行 */
.rep-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.range-tabs {
  display: flex;
  gap: 4px;
  background: var(--surface-2);
  border-radius: var(--r-pill);
  padding: 4px;
}
.range-tab {
  padding: 7px 14px;
  border-radius: var(--r-pill);
  font-weight: 600;
  font-size: var(--fs-sm);
  color: var(--fg-2);
}
.range-tab:hover {
  background: var(--surface-3);
}
.range-tab.on {
  background: var(--primary-soft);
  color: var(--primary);
}
.date-input {
  width: auto;
  padding: 7px 10px;
}
.range-label {
  font-size: var(--fs-sm);
}
.rep-search {
  margin-left: auto;
}

/* 排序下拉（嵌在 pill 里的原生 select，去边框透明化） */
.sort-select {
  background: none;
  border: none;
  outline: none;
  font-weight: 600;
  color: var(--primary);
  cursor: pointer;
}

/* 饼图方向小切换 */
.mini-toggle {
  font-size: var(--fs-xs);
  font-weight: 700;
  padding: 4px 10px;
  border-radius: var(--r-pill);
  color: var(--fg-3);
}
.mini-toggle.on {
  background: var(--primary-soft);
  color: var(--primary);
}

/* 添加条件弹层 */
.add-wrap {
  position: relative;
  display: inline-flex;
}
.chip .x {
  cursor: pointer;
}
/* 让筛选 chip、添加/清空按钮位于 add-backdrop 之上，
   否则弹层打开时全屏遮罩会盖住这些 chip，导致 × 移除/清空点不到。
   S11：整套下拉层级抬到手机底栏(.m-tabbar z:30 / .m-fab z:31)之上，
   否则窄屏/矮屏下菜单底部会被固定底栏盖住、点击落到底栏误切页。band=40/41/42。 */
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
  font-weight: 600;
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

/* ---- 图表类（设计稿 app.css 移植；tokens.css 未含，故在此就地定义） ---- */
.donut {
  width: 160px;
  height: 160px;
  border-radius: 50%;
  position: relative;
  flex-shrink: 0;
}
.donut::after {
  content: '';
  position: absolute;
  inset: 26px;
  background: var(--surface);
  border-radius: 50%;
}
.donut-center {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  z-index: 2;
  text-align: center;
}
.legend {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-sm);
}
.legend-item .lg-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}
.legend-item .lg-val {
  margin-left: auto;
  font-weight: 700;
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 140px;
}
.bars .bcol {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 3px;
  height: 100%;
}
.bars .bseg {
  border-radius: 4px 4px 0 0;
}
.bars .blabel {
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--fg-3);
  margin-top: 6px;
}

.bar-track {
  height: 8px;
  background: var(--surface-3);
  border-radius: var(--r-pill);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: var(--r-pill);
}

/* 饼图+趋势并排：桌面等分两列（等价于原内联 grid-template-columns:1fr 1fr）。 */
.rep-two-col {
  height: auto;
  grid-template-columns: 1fr 1fr;
}

/* ============================================================
   手机端（≤720px）：单列堆叠、chips 横向可滚、统计块自适应。不改任何取数/统计逻辑。
   ============================================================ */
@media (max-width: 720px) {
  /* 饼图 + 趋势 单列堆叠 */
  .rep-two-col {
    grid-template-columns: 1fr;
  }

  /* 汇总三卡：窄屏挤不下三列 → 单列铺满 */
  .grid.g-3 {
    grid-template-columns: 1fr;
  }

  /* 顶部范围选择行：允许换行、搜索框铺满不再靠右挤压 */
  .rep-head {
    gap: 10px;
  }
  .rep-search {
    margin-left: 0;
    width: 100%;
  }

  /* 饼图行：环 + 图例竖排，图例不溢出 */
  .donut {
    width: 128px;
    height: 128px;
  }

  /* 添加条件弹层：不超出视口宽度 */
  .add-menu {
    max-width: calc(100vw - 32px);
  }
}
</style>
