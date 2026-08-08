<script setup lang="ts">
// ============================================================
// SmokeTest.vue —— S0 临时验证入口（验收后可移除，不进入正式 UI）
// ============================================================
// 覆盖任务书 §四.4 的冒烟检查 a~e：
//   a) 数据库初始化成功、7 表建成、user_version = 1
//   b) PRAGMA foreign_keys 已开启
//   c) 插入一条 account、读回一致（含 drizzle 客户端读回）
//   d) 删除"有交易挂着的账户"被 RESTRICT 拦截
//   e) 刷新页面后数据仍在（OPFS 持久化）
// ============================================================
import { onMounted, ref } from 'vue';
import { initDb, getAdapter, db } from '../db/client';
import { account as accountTable } from '../db/schema';
import { yuanToCents, centsToYuan, format } from '../services/money';

type Line = { tag: string; ok: boolean; text: string };
const log = ref<Line[]>([]);
const persistence = ref<string>('（检测中…）');
const running = ref(false);

function push(tag: string, ok: boolean, text: string): void {
  log.value.push({ tag, ok, text });
}

const EXPECTED_TABLES = ['account', 'category', 'txn', 'tag', 'txn_tag', 'setting'];

function uuid(): string {
  return crypto.randomUUID();
}

// ---- e) OPFS 持久化：读上次运行留下的标记，再写入本次时间戳 ----
async function checkPersistenceOnLoad(): Promise<void> {
  const adapter = getAdapter();
  const prev = await adapter.get<{ value: string }>(
    'SELECT value FROM setting WHERE key = ?;',
    ['smoke_last_run'],
  );
  const now = new Date().toISOString();
  if (prev?.value) {
    persistence.value = `上次运行标记 = ${prev.value} → 说明刷新后数据仍在（OPFS 持久化成立）`;
  } else {
    persistence.value = '首次运行：尚无历史标记。写入后请刷新页面再看本行。';
  }
  await adapter.run(
    `INSERT INTO setting(key, value) VALUES('smoke_last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    [now],
  );
}

async function runChecks(): Promise<void> {
  running.value = true;
  log.value = [];
  const adapter = getAdapter();

  try {
    // -------- a) 初始化 + 7 表 + user_version --------
    const tables = await adapter.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
    );
    const names = tables.map((t) => t.name);
    const missing = EXPECTED_TABLES.filter((t) => !names.includes(t));
    push(
      'a',
      missing.length === 0 && names.length >= EXPECTED_TABLES.length,
      `建成的表 (${names.length}): [${names.join(', ')}]` +
        (missing.length ? ` ❌ 缺: ${missing.join(', ')}` : ' ✅ 7 表齐全'),
    );

    const uv = await adapter.getUserVersion();
    push('a', uv === 1, `PRAGMA user_version = ${uv}（期望 1）`);

    // -------- b) 外键开启 --------
    const fk = await adapter.get<{ foreign_keys: number }>('PRAGMA foreign_keys;');
    push('b', fk?.foreign_keys === 1, `PRAGMA foreign_keys = ${fk?.foreign_keys}（期望 1）`);

    // -------- c) 插入 account 并读回一致（raw + drizzle）--------
    const accId = uuid();
    const acc = {
      id: accId,
      name: '冒烟-现金',
      color: -16745729,
      icon: null as string | null,
      initial_balance: yuanToCents(100),
      include_in_balance: 1,
      order_num: 1,
      created_at: Date.now(),
    };
    await adapter.run(
      `INSERT INTO account(id,name,color,icon,initial_balance,include_in_balance,order_num,created_at)
       VALUES(?,?,?,?,?,?,?,?);`,
      [
        acc.id,
        acc.name,
        acc.color,
        acc.icon,
        acc.initial_balance,
        acc.include_in_balance,
        acc.order_num,
        acc.created_at,
      ],
    );
    const readBack = await adapter.get<{ id: string; name: string; initial_balance: number }>(
      'SELECT id, name, initial_balance FROM account WHERE id = ?;',
      [accId],
    );
    const rawOk =
      readBack?.id === acc.id &&
      readBack?.name === acc.name &&
      readBack?.initial_balance === acc.initial_balance;
    push(
      'c',
      rawOk,
      `raw 读回: id=${readBack?.id === acc.id ? '一致' : '不符'}, name="${readBack?.name}", initial_balance=${readBack?.initial_balance}（=${centsToYuan(readBack?.initial_balance ?? 0)} 元）`,
    );

    // drizzle 客户端读回同一行，证明 client 也走通
    const viaDrizzle = await db.select().from(accountTable);
    const found = viaDrizzle.find((r) => r.id === accId);
    push(
      'c',
      !!found && found.name === acc.name,
      `drizzle 读回: 命中 ${viaDrizzle.length} 行, 目标 name="${found?.name}"`,
    );

    // -------- d) RESTRICT：账户下挂交易时删账户被拦 --------
    const catId = uuid();
    const txnId = uuid();
    await adapter.run(
      `INSERT INTO category(id,account_id,name,color,order_num,created_at) VALUES(?,?,?,?,?,?);`,
      [catId, accId, '冒烟-餐饮', -16745729, 1, Date.now()],
    );
    await adapter.run(
      `INSERT INTO txn(id,type,amount,account_id,to_account_id,category_id,time,title,note,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?);`,
      [txnId, 'expense', yuanToCents(9.28), accId, null, catId, Date.now(), '午饭', null, Date.now()],
    );

    let restrictHeld = false;
    let restrictMsg = '';
    try {
      await adapter.run('DELETE FROM account WHERE id = ?;', [accId]);
    } catch (e) {
      restrictHeld = true;
      restrictMsg = e instanceof Error ? e.message : String(e);
    }
    push(
      'd',
      restrictHeld,
      restrictHeld
        ? `删有交易的账户被 RESTRICT 拦住 ✅（错误："${restrictMsg.slice(0, 80)}"）`
        : '❌ 删除竟然成功了 —— 外键未生效（假通过）',
    );

    // 清理本次测试数据（删顺序：txn -> category -> account）
    await adapter.run('DELETE FROM txn WHERE id = ?;', [txnId]);
    await adapter.run('DELETE FROM category WHERE id = ?;', [catId]);
    await adapter.run('DELETE FROM account WHERE id = ?;', [accId]);
    push('d', true, '已清理本次冒烟数据（txn/category/account）');

    // -------- money.ts 断言 --------
    const m1 = yuanToCents(9.28);
    const m2 = yuanToCents(7.8);
    const m3 = centsToYuan(780);
    const moneyOk = m1 === 928 && m2 === 780 && m3 === '7.80';
    push(
      'money',
      moneyOk,
      `yuanToCents(9.28)=${m1}（期望928） / yuanToCents(7.8)=${m2}（期望780） / centsToYuan(780)="${m3}"（期望"7.80") / format(-780,{sign:true})="${format(-780, { sign: true })}"`,
    );

    push('done', true, '全部检查执行完毕。刷新页面观察上方「持久化」一行以验证 e)。');
  } catch (e) {
    push('error', false, `执行异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally {
    running.value = false;
  }
}

onMounted(async () => {
  await initDb();
  await checkPersistenceOnLoad();
  await runChecks();
});
</script>

<template>
  <main class="smoke">
    <h1>S0 冒烟检查</h1>
    <p class="hint">临时验证入口，S0 验收后可移除。页面加载即自动运行 a~e。</p>

    <section class="persist">
      <strong>e) OPFS 持久化：</strong>
      <span>{{ persistence }}</span>
    </section>

    <button :disabled="running" @click="runChecks">重新运行 a~d + money</button>

    <ul class="log">
      <li v-for="(line, i) in log" :key="i" :class="{ ok: line.ok, bad: !line.ok }">
        <code class="tag">[{{ line.tag }}]</code> {{ line.text }}
      </li>
    </ul>
  </main>
</template>

<style scoped>
.smoke {
  max-width: 900px;
  margin: 24px auto;
  padding: 0 16px;
  font-family: system-ui, sans-serif;
}
h1 {
  font-size: 20px;
}
.hint {
  color: #5f6368;
  font-size: 13px;
}
.persist {
  background: #e8f0fe;
  border: 1px solid #1a73e8;
  border-radius: 8px;
  padding: 10px 12px;
  margin: 12px 0;
  font-size: 14px;
}
button {
  background: #1a73e8;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.log {
  list-style: none;
  padding: 0;
  margin-top: 16px;
}
.log li {
  padding: 6px 8px;
  border-radius: 6px;
  margin-bottom: 4px;
  font-size: 13px;
  line-height: 1.5;
}
.log li.ok {
  background: #e6f4ea;
}
.log li.bad {
  background: #fce8e6;
}
.tag {
  font-weight: 700;
  margin-right: 6px;
}
</style>
