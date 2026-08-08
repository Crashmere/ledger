// ============================================================
// money.ts —— 全局唯一的分/元转换与格式化入口
// ============================================================
// 权威来源：06-接口契约.ts §5 MoneyUtil、03-开发交接说明.md §2/§6、07-导入器参考实现.ts。
// 硬约定：
//   - 金额一律整数存"分"（Cents = 整数）。
//   - 元→分必须用四舍五入（Math.round），禁止 int/trunc(x*100)，否则 9.28 会错成 927。
// 本文件不依赖 Vue、不依赖任何平台驱动，可脱离 UI 单测。
// ============================================================

import type { Cents } from '../db/adapter';

/**
 * 元(字符串/数字) -> 分。
 * 用先转字符串定点、再 Math.round 的方式规避二进制浮点误差：
 *   yuanToCents(9.28) === 928，yuanToCents(7.8) === 780。
 */
export function yuanToCents(yuan: string | number): Cents {
  const n = typeof yuan === 'string' ? Number(yuan) : yuan;
  if (!Number.isFinite(n)) {
    throw new Error(`yuanToCents: 非法金额 ${String(yuan)}`);
  }
  // 先用定点字符串消除 9.28*100=927.9999... 这类误差，再四舍五入取整。
  return Math.round(Number(n.toFixed(2)) * 100);
}

/**
 * 分 -> 元字符串（用于展示）：780 -> "7.80"。
 * 负数保留符号：-780 -> "-7.80"。
 */
export function centsToYuan(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const fen = abs % 100;
  return `${sign}${yuan}.${fen.toString().padStart(2, '0')}`;
}

/**
 * 格式化带符号金额，供 UI 用。
 *   format(780)                       -> "7.80"
 *   format(780, { sign: true })       -> "+7.80"
 *   format(-780, { sign: true })      -> "-7.80"
 *   format(780, { symbol: '¥' })      -> "¥7.80"
 */
export function format(cents: Cents, opts?: { sign?: boolean; symbol?: string }): string {
  const symbol = opts?.symbol ?? '';
  const body = centsToYuan(Math.abs(cents));
  let signStr = '';
  if (opts?.sign) {
    signStr = cents < 0 ? '-' : '+';
  } else if (cents < 0) {
    signStr = '-';
  }
  return `${signStr}${symbol}${body}`;
}
