// 数字输入框的编辑草稿：允许暂时清空或输入到一半；合法且在范围内的数字即时提交，越界时立即夹紧并显示夹紧后的值，失焦时恢复显示实际值。
import { useState } from 'react';
import { clampInt } from './format';

export interface NumberDraft {
  text: string;
  change(raw: string): void;
  blur(): void;
}

export function useNumberDraft(value: number, min: number, max: number, onChange: (v: number) => void): NumberDraft {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    // 草稿与实际值不一致（外部改了值，例如点了「最大」）时显示实际值
    text: draft !== null && (draft === '' || Number(draft) === value) ? draft : String(value),
    change(raw) {
      if (raw.trim() === '') {
        setDraft('');
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const v = clampInt(n, min, max);
      onChange(v);
      setDraft(v === n ? raw : null);
    },
    blur() {
      setDraft(null);
    },
  };
}
