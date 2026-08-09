<script setup lang="ts">
// ============================================================
// Overview.vue —— 概览页（Home，S3 · Priority 2）
// ============================================================
// 对照 设计稿/overview.html 桌面稿还原：
//   顶部月份切换 + 本月净额/总收入/总支出三卡 +
//   左栏「按日期分组的本月流水」+ 右栏「账户余额卡 + 快速记一笔入口」。
// 数据全部来自 S1 服务：StatsService.summary / TxnService.query /
//   AccountService.list+balance / CategoryService.listByAccount（建 id→分类 映射）。
// 红线：
//   ③ 三卡收入/支出/净额用 summary，转账天然不计入（summary 只统计 income/expense）；
//      流水里转账用中性色 .tr、不带正负号、副标题显示「转出 → 转入」。
//   ⑤ 界面不出现「记账人/成员/TA」。
//   本地优先：不发任何网络请求。金额一律 Cents，仅展示经 money.format。
// 只读速览升级（S5）：流水条目可点击进入编辑（/txn/:id/edit），复用记一笔表单；
//   账户/分类管理（S4）与深度分析（S10）不在本阶段。
// ============================================================
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  accountService,
  categoryService,
  statsService,
  txnService,
  format,
  type Account,
  type Category,
  type Id,
  type Summary,
  type TxnWithTags,
} from '../services';

const router = useRouter();

/** 点流水行 → 进入编辑该笔（方案 A：复用 AddTxn 表单）。转账行同样可编辑。 */
function openEdit(id: Id): void {
  void router.push(`/txn/${id}/edit`);
}

// ---------- 月份状态（默认本月） ----------
const now = new Date();
const year = ref(now.getFullYear());
const month = ref(now.getMonth()); // 0-based

const monthLabel = computed(() => `${year.value}年${month.value + 1}月`);

// 当月区间：[timeFrom, timeTo]。query/summary 的 timeTo 用 `time <= ?`（闭区间），
// 故 timeTo 取「次月 1 号 00:00 减 1ms」，避免把次月第一天算进来或漏掉当月最后一刻。
const timeFrom = computed(() => new Date(year.value, month.value, 1, 0, 0, 0, 0).getTime());
const timeTo = computed(() => new Date(year.value, month.value + 1, 1, 0, 0, 0, 0).getTime() - 1);

// 是否已到达（真实）本月：到本月则禁用「下一月」，未来没有数据。
const atCurrentMonth = computed(
  () => year.value === now.getFullYear() && month.value === now.getMonth(),
);

function prevMonth(): void {
  if (month.value === 0) {
    month.value = 11;
    year.value -= 1;
  } else {
    month.value -= 1;
  }
}
function nextMonth(): void {
  if (atCurrentMonth.value) return;
  if (month.value === 11) {
    month.value = 0;
    year.value += 1;
  } else {
    month.value += 1;
  }
}

// ---------- 数据源 ----------
const summary = ref<Summary>({ income: 0, expense: 0, net: 0 });
const txns = ref<TxnWithTags[]>([]);
const accounts = ref<Account[]>([]);
const balanceById = ref<Map<Id, number>>(new Map());
const categoryById = ref<Map<Id, Category>>(new Map());
const loading = ref(false);

// ============================================================
// 加载
// ============================================================
/** 账户/分类/余额与月份无关（余额是全期口径），仅在挂载时加载一次。 */
async function loadStatic(): Promise<void> {
  accounts.value = await accountService.list();

  // 建 categoryId -> Category 映射：逐账户 listByAccount 后合并（账户数有限，非 N+1）。
  const catMap = new Map<Id, Category>();
  for (const acc of accounts.value) {
    const cats = await categoryService.listByAccount(acc.id);
    for (const c of cats) catMap.set(c.id, c);
  }
  categoryById.value = catMap;

  // 各账户总余额。
  const balMap = new Map<Id, number>();
  for (const acc of accounts.value) {
    balMap.set(acc.id, await accountService.balance(acc.id));
  }
  balanceById.value = balMap;
}

/** 随月份变化：三卡汇总 + 本月流水。 */
async function loadMonth(): Promise<void> {
  loading.value = true;
  try {
    const q = { timeFrom: timeFrom.value, timeTo: timeTo.value };
    summary.value = await statsService.summary(q);
    txns.value = await txnService.query({
      ...q,
      sortBy: 'time',
      sortDir: 'desc',
    });
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadStatic();
  await loadMonth();
});

// 月份切换后刷新三卡与流水（余额全期口径，无需随月刷新）。
watch([timeFrom, timeTo], () => {
  void loadMonth();
});

// ============================================================
// 计算属性
// ============================================================
/** 三卡副标题用「共 N 笔」——由本月 query 结果长度得出（不调用未实现的 trend）。 */
const txnCount = computed(() => txns.value.length);

const netPositive = computed(() => summary.value.net >= 0);

/** 按日期（本地 y-m-d）分组的本月流水；query 已按 time 倒序，组序天然从新到旧。 */
interface DayGroup {
  key: string;
  label: string;
  expense: number; // Cents，仅 expense
  income: number; // Cents，仅 income
  items: TxnWithTags[];
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const groups = computed<DayGroup[]>(() => {
  const map = new Map<string, DayGroup>();
  const order: string[] = [];
  for (const t of txns.value) {
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

// ============================================================
// 纯函数工具
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

/** 日小计文案：支出 X · 收入 Y（两者皆走 money 格式化；转账不计入）。 */
function daySummaryText(g: DayGroup): string {
  return `支出 ${format(g.expense)} · 收入 ${format(g.income)}`;
}

/** ARGB 整数（可能有符号 32 位）转 CSS rgba，用于账户/分类色标（与 AddTxn 一致）。 */
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

function categoryName(id: Id | null): string {
  if (!id) return '';
  return categoryById.value.get(id)?.name ?? '';
}

/** 交易左侧色块颜色：转账用中性靛紫；收支优先分类色，无分类则回退账户色。 */
function txnColor(t: TxnWithTags): string {
  if (t.type === 'transfer') return 'var(--transfer)';
  if (t.categoryId) {
    const cat = categoryById.value.get(t.categoryId);
    if (cat) return argbToCss(cat.color);
  }
  const acc = accounts.value.find((a) => a.id === t.accountId);
  return acc ? argbToCss(acc.color) : 'var(--fg-3)';
}

/** 交易标题：优先 title；空则回退分类名，再回退占位。 */
function txnTitle(t: TxnWithTags): string {
  if (t.title && t.title.trim()) return t.title;
  const cat = categoryName(t.categoryId);
  if (cat) return cat;
  if (t.type === 'transfer') return '转账';
  return '(无标题)';
}

/** 交易副标题：转账显示「转出 → 转入」；收支显示「账户 · 分类」（分类可缺省）。 */
function txnSub(t: TxnWithTags): string {
  if (t.type === 'transfer') {
    return `${accountName(t.accountId)} → ${accountName(t.toAccountId)}`;
  }
  const cat = categoryName(t.categoryId);
  return cat ? `${accountName(t.accountId)} · ${cat}` : accountName(t.accountId);
}

/** 交易金额展示：支出 −、收入 +、转账中性无符号。金额一律经 money.format。 */
function txnAmountText(t: TxnWithTags): string {
  if (t.type === 'expense') return `−${format(t.amount)}`;
  if (t.type === 'income') return `+${format(t.amount)}`;
  return format(t.amount); // transfer：不带正负
}

function txnAmountClass(t: TxnWithTags): string {
  if (t.type === 'expense') return 'neg';
  if (t.type === 'income') return 'pos';
  return 'tr';
}
</script>

<template>
  <div class="content">
    <!-- 顶部：月份切换 -->
    <div class="ov-head">
      <div class="month-switch">
        <button aria-label="上一月" @click="prevMonth">‹</button>
        <span class="m-label">{{ monthLabel }}</span>
        <button aria-label="下一月" :disabled="atCurrentMonth" @click="nextMonth">›</button>
      </div>
    </div>

    <!-- 汇总三卡 -->
    <div class="grid g-3">
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2v20M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H6" />
          </svg>
          本月净额
        </div>
        <div class="s-value num" :class="netPositive ? 'pos' : 'neg'">
          {{ format(summary.net, { sign: true }) }}
        </div>
        <div class="s-trend">共 {{ txnCount }} 笔</div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
          总收入
        </div>
        <div class="s-value num pos">{{ format(summary.income, { sign: true }) }}</div>
        <div class="s-trend">本月流入（不含转账）</div>
      </div>
      <div class="stat">
        <div class="s-label">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          总支出
        </div>
        <div class="s-value num neg">−{{ format(summary.expense) }}</div>
        <div class="s-trend">本月流出（不含转账）</div>
      </div>
    </div>

    <div class="two-col ov-two-col mt-4">
      <!-- 左：本月流水 -->
      <div class="card">
        <div class="card-head">
          <h3>本月流水</h3>
          <span class="faint" style="font-size: 13px">按日期分组</span>
        </div>
        <div class="card-pad" style="padding-top: 4px">
          <!-- 空状态 -->
          <div v-if="!loading && groups.length === 0" class="empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 9h18M8 14h8" />
            </svg>
            <div style="font-weight: 700; color: var(--fg-2)">本月还没有记账</div>
            <RouterLink to="/add" class="btn btn-secondary btn-sm mt-3">去记一笔</RouterLink>
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
              <div class="ic-tile" :style="{ background: txnColor(t) }">
                <!-- 收/支/转 类型图标 -->
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
                  {{ txnTitle(t) }}
                  <span v-if="t.type === 'transfer'" class="badge badge-transfer" style="margin-left: 6px">转账</span>
                  <span v-else-if="t.type === 'income'" class="badge badge-income" style="margin-left: 6px">收入</span>
                </div>
                <div class="txn-sub">
                  {{ txnSub(t) }}
                  <template v-if="t.tags.length">
                    <span class="sep" />
                    <span v-for="tag in t.tags" :key="tag.id" class="tag-inline">{{ tag.name }}</span>
                  </template>
                </div>
              </div>
              <div class="txn-amt num" :class="txnAmountClass(t)">{{ txnAmountText(t) }}</div>
            </div>
          </template>
        </div>
      </div>

      <!-- 右：账户余额 + 快速记一笔 -->
      <div class="stack gap-4">
        <div class="card">
          <div class="card-head"><h3>账户余额</h3></div>
          <div class="card-pad" style="padding-top: 8px">
            <div
              v-for="acc in accounts"
              :key="acc.id"
              class="txn"
              style="border: none; padding: 9px 0"
            >
              <div class="ic-tile sm" :style="{ background: argbToCss(acc.color) }">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M3 6h18l-2 13H5z" />
                </svg>
              </div>
              <div class="txn-main">
                <div class="txn-title" style="font-size: 13px">{{ acc.name }}</div>
              </div>
              <div class="mono-lg num">{{ format(balanceById.get(acc.id) ?? 0) }}</div>
            </div>
          </div>
        </div>

        <RouterLink
          to="/add"
          class="card card-pad"
          style="background: var(--primary-soft); border-color: transparent"
        >
          <div class="row gap-3">
            <div class="ic-tile" style="background: var(--primary)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </div>
            <div>
              <div style="font-weight: 700">快速记一笔</div>
              <div class="muted" style="font-size: 12px">默认支出 · 今天</div>
            </div>
            <button class="btn btn-primary btn-sm" style="margin-left: auto">开始</button>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 顶部月份切换行 */
.ov-head {
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}

/* 概览双栏：左流水自适应、右侧固定 360px（对照设计稿桌面双栏）。 */
.ov-two-col {
  grid-template-columns: 1fr 360px;
  align-items: start;
}

/* 窄视口退化为单列（S9 手机端再细做，本次仅留伏笔）。 */
@media (max-width: 900px) {
  .ov-two-col {
    grid-template-columns: 1fr;
  }
  .grid.g-3 {
    grid-template-columns: 1fr;
  }
}

/* S5：流水行可点击进入编辑，hover 有底色/指针反馈（负 margin + padding 让底色铺满行内边距）。 */
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
</style>
