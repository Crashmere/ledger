// ============================================================
// expr.test.ts —— 安全算式求值器单测（S2 红线④：禁用 eval）
// ============================================================
import { describe, expect, it } from 'vitest';
import { evalExpr, isExpression } from '../src/services/expr';

describe('evalExpr 安全求值器', () => {
  it('基础四则运算', () => {
    expect(evalExpr('12+8')).toBe(20);
    expect(evalExpr('88+40.5')).toBe(128.5);
    expect(evalExpr('100-1')).toBe(99);
    expect(evalExpr('6*7')).toBe(42);
    expect(evalExpr('10/4')).toBe(2.5);
  });

  it('运算符优先级与括号', () => {
    expect(evalExpr('2+3*4')).toBe(14);
    expect(evalExpr('(2+3)*4')).toBe(20);
  });

  it('一元正负号', () => {
    expect(evalExpr('-5+8')).toBe(3);
    expect(evalExpr('12*-2')).toBe(-24);
  });

  it('纯数字与小数', () => {
    expect(evalExpr('128.50')).toBe(128.5);
    expect(evalExpr('0.99')).toBeCloseTo(0.99);
  });

  it('非法/不完整输入返回 null，不抛异常', () => {
    expect(evalExpr('')).toBeNull();
    expect(evalExpr('12+')).toBeNull();
    expect(evalExpr('1/0')).toBeNull();
    expect(evalExpr('()')).toBeNull();
    expect(evalExpr('(2+3')).toBeNull();
    expect(evalExpr('1.2.3')).toBeNull();
  });

  it('拒绝任何非白名单字符（不接触动态执行）', () => {
    expect(evalExpr('alert(1)')).toBeNull();
    expect(evalExpr('1;2')).toBeNull();
    expect(evalExpr('a+b')).toBeNull();
    expect(evalExpr('2**3')).toBeNull(); // 连续运算符非法
  });

  it('isExpression 判断是否含运算符', () => {
    expect(isExpression('128')).toBe(false);
    expect(isExpression('-5')).toBe(false); // 首字符负号是符号不是运算
    expect(isExpression('12+8')).toBe(true);
    expect(isExpression('(1)')).toBe(true);
  });
});
