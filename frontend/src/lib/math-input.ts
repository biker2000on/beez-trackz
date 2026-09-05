/**
 * Arithmetic in numeric fields: "12+12+12" or "3*12" evaluates to a number
 * on blur, so counting full boxes and multiplying by jars per box is one
 * keystroke away. Only digits, decimals, + - * / x ×, parentheses and spaces
 * are accepted — nothing is ever passed to eval.
 *
 * A trailing unit ("3*12 lb", "2*454 g") is kept: the number part is
 * evaluated and the unit re-attached.
 */

const EXPRESSION = /^[\s0-9.,+\-*/x×()]+$/i;
const OPERATOR = /[+\-*/x×()]/;

type Token = number | "+" | "-" | "*" | "/" | "(" | ")";

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === ",") {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      const value = Number(text.slice(i, j));
      if (!Number.isFinite(value)) return null;
      tokens.push(value);
      i = j;
      continue;
    }
    if (ch === "x" || ch === "X" || ch === "×") {
      tokens.push("*");
    } else if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "(" || ch === ")") {
      tokens.push(ch);
    } else {
      return null;
    }
    i++;
  }
  return tokens;
}

/** Recursive-descent: expr = term (('+'|'-') term)*; term = unary (('*'|'/') unary)*. */
function parse(tokens: Token[]): number | null {
  let pos = 0;
  function peek(): Token | undefined {
    return tokens[pos];
  }
  function primary(): number | null {
    const t = peek();
    if (t === "(") {
      pos++;
      const v = expr();
      if (v === null || peek() !== ")") return null;
      pos++;
      return v;
    }
    if (t === "-") {
      pos++;
      const v = primary();
      return v === null ? null : -v;
    }
    if (t === "+") {
      pos++;
      return primary();
    }
    if (typeof t === "number") {
      pos++;
      return t;
    }
    return null;
  }
  function term(): number | null {
    let v = primary();
    if (v === null) return null;
    while (peek() === "*" || peek() === "/") {
      const op = peek();
      pos++;
      const r = primary();
      if (r === null) return null;
      if (op === "/") {
        if (r === 0) return null;
        v /= r;
      } else {
        v *= r;
      }
    }
    return v;
  }
  function expr(): number | null {
    let v = term();
    if (v === null) return null;
    while (peek() === "+" || peek() === "-") {
      const op = peek();
      pos++;
      const r = term();
      if (r === null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  const result = expr();
  if (result === null || pos !== tokens.length) return null;
  return result;
}

/**
 * Returns the evaluated text for a field value, or null when the value is
 * not an expression worth touching (a plain number, empty, or malformed).
 */
export function evaluateNumericInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const unitMatch = /^(.*?)([a-zA-Z%°][a-zA-Z%°\s]*)$/.exec(text);
  const numberPart = unitMatch ? unitMatch[1].trim() : text;
  const unit = unitMatch ? unitMatch[2].trim() : "";
  if (!numberPart || !EXPRESSION.test(numberPart)) return null;
  // A plain number (optionally signed) is left exactly as typed.
  if (!OPERATOR.test(numberPart.replace(/^[+-]/, ""))) return null;
  const tokens = tokenize(numberPart);
  if (!tokens) return null;
  const value = parse(tokens);
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  const rendered = String(rounded);
  return unit ? `${rendered} ${unit}` : rendered;
}
