// ============================================================
// expr.ts —— 记一笔金额算式的安全求值器（严禁 eval / new Function）
// ============================================================
// 权威来源：S2 任务书 §三红线④「算式禁用 eval」、§四.4 算式输入。
// 目标：把用户在数字键盘里敲的算式（如 "12+8"、"88+40.5"）安全求成结果，
//   非法输入不抛异常、不崩溃（返回 null 让 UI 优雅降级）。
// 实现：自写词法分析（tokenizer）+ 递归下降解析（recursive descent），
//   只认「数字 / + - * / / . / 括号」，不接触任何动态执行 API。
// 支持：四则运算、小数、一元正负号、括号、运算符优先级（*// 高于 +/-）。
// ============================================================

/** 词法单元种类。 */
type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

/** 允许出现在算式里的字符白名单（含空格）。其余一律视为非法。 */
const ALLOWED = /^[0-9+\-*/.()\s]*$/;

/**
 * 词法分析：把字符串切成 token 序列。遇到非法字符抛出，由上层 evalExpr 兜住。
 */
function tokenize(input: string): Token[] {
  if (!ALLOWED.test(input)) {
    throw new Error('算式含非法字符');
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    // 数字：连续的数字与至多一个小数点
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let dotSeen = false;
      while (j < input.length) {
        const c = input[j];
        if (c >= '0' && c <= '9') {
          j += 1;
        } else if (c === '.' && !dotSeen) {
          dotSeen = true;
          j += 1;
        } else {
          break;
        }
      }
      const slice = input.slice(i, j);
      const value = Number(slice);
      if (!Number.isFinite(value)) {
        throw new Error(`非法数字：${slice}`);
      }
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }
    throw new Error(`未知字符：${ch}`);
  }
  return tokens;
}

/**
 * 递归下降解析器。语法（优先级从低到高）：
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := ('+' | '-') factor | '(' expr ')' | num
 */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  parse(): number {
    const value = this.parseExpr();
    if (this.pos !== this.tokens.length) {
      throw new Error('算式有多余的符号');
    }
    return value;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseTerm();
        left = t.value === '+' ? left + right : left - right;
      } else {
        break;
      }
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.value === '*' || t.value === '/')) {
        this.next();
        const right = this.parseFactor();
        if (t.value === '/') {
          if (right === 0) {
            throw new Error('除以零');
          }
          left = left / right;
        } else {
          left = left * right;
        }
      } else {
        break;
      }
    }
    return left;
  }

  private parseFactor(): number {
    const t = this.peek();
    if (!t) {
      throw new Error('算式不完整');
    }
    // 一元正负号
    if (t.kind === 'op' && (t.value === '+' || t.value === '-')) {
      this.next();
      const v = this.parseFactor();
      return t.value === '-' ? -v : v;
    }
    if (t.kind === 'lparen') {
      this.next();
      const v = this.parseExpr();
      const close = this.next();
      if (!close || close.kind !== 'rparen') {
        throw new Error('括号不匹配');
      }
      return v;
    }
    if (t.kind === 'num') {
      this.next();
      return t.value;
    }
    throw new Error('期望数字或括号');
  }
}

/**
 * 安全求值：成功返回数值，任何非法/不完整输入返回 null（不抛、不崩溃）。
 *   evalExpr('12+8')     -> 20
 *   evalExpr('88+40.5')  -> 128.5
 *   evalExpr('')         -> null
 *   evalExpr('12+')      -> null
 *   evalExpr('1/0')      -> null
 */
export function evalExpr(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) {
      return null;
    }
    const result = new Parser(tokens).parse();
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/** 该字符串是否是一条「含运算符」的算式（用于判断是否要显示算式行 + 求值）。 */
export function isExpression(input: string): boolean {
  // 首字符的正负号不算运算符（那是符号，不是加减运算）。
  return /[+\-*/]/.test(input.slice(1)) || input.includes('(') || input.includes(')');
}
