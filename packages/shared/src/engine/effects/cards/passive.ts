/**
 * 被动卡 18 复仇、19 嫁祸、20 免费、21 免罪（design/engine.md §10.3）：exe 的出牌函数是空桩，不能主动打出；
 * 只在触发点自动生效或询问后生效（flow/passive.ts、flow/confine.ts、flow/toll.ts、flow/fee.ts、effects/cards/harm.ts）。
 */
import { EngineRuleError } from '../../errors';
import type { CardEffect } from '../types';
import { unusable } from '../types';

export const passiveCard: CardEffect = {
  menu: () => unusable('passive'),
  apply() {
    throw new EngineRuleError('NOT_USABLE', 'passive cards cannot be played');
  },
};
