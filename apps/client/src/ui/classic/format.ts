// 经典画面的数字格式：金额短写按界面语言取单位字（简体「万 / 亿」、繁体「萬 / 億」）。
import type { LooseT } from '../../i18n/tx';
import { formatMoney } from '../../presentation/names';

/** 12345 → 「1.2万」/「1.2萬」；一万以下照常千分位 */
export function formatShort(t: LooseT, n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const one = (x: number): string => {
    const v = Math.trunc(x * 10) / 10;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  if (a >= 1e8) return `${sign}${t('classic:unit.yi', { n: one(a / 1e8) })}`;
  if (a >= 1e4) return `${sign}${t('classic:unit.wan', { n: one(a / 1e4) })}`;
  return formatMoney(n);
}
