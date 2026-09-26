/**
 * 规范化 JSON：对象键按 UTF-16 码元升序，无空白；其余语义与 JSON.stringify 一致
 * （对象里 undefined/函数属性省略，数组里的 undefined 写成 null），
 * 因此 canonicalJson(x) === canonicalJson(JSON.parse(JSON.stringify(x)))。
 * 只接受 JSON 值：非有限数、bigint、循环引用、非普通对象（Map、Set、日期对象、类实例、TypedArray）一律抛 TypeError。
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('canonicalJson: top-level value is not JSON-serializable');
  }
  const out: string[] = [];
  write(value, out, []);
  return out.join('');
}

function isOmitted(v: unknown): boolean {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

function write(v: unknown, out: string[], stack: object[]): void {
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
      out.push(JSON.stringify(v));
      return;
    case 'string':
      out.push(JSON.stringify(v));
      return;
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not JSON');
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
  }
  const obj = v as object;
  if (stack.includes(obj)) throw new TypeError('canonicalJson: circular reference');
  stack.push(obj);
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out.push(',');
      const item: unknown = obj[i];
      if (isOmitted(item)) out.push('null');
      else write(item, out, stack);
    }
    out.push(']');
  } else {
    const proto: unknown = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonicalJson: only plain objects and arrays are allowed');
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    out.push('{');
    let first = true;
    for (const k of keys) {
      const item = rec[k];
      if (isOmitted(item)) continue;
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(k), ':');
      write(item, out, stack);
    }
    out.push('}');
  }
  stack.pop();
}
