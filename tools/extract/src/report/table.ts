/** 终端显示宽度：CJK、全角与 ✅/❌ 记 2 列。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      cp === 0x2705 ||
      cp === 0x274c;
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, width: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(s)));
  return right ? fill + s : s + fill;
}

/** 渲染对齐文本表；align 中 'r' 表示右对齐。 */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[], align = ''): string[] {
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => pad(c, widths[i]!, align[i] === 'r'))
      .join('  ')
      .trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
}

export const ICON = { pass: '✅', fail: '❌', warn: '⚠️' } as const;
