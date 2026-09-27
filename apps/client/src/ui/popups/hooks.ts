// 弹窗的小动画钩子（真实时间驱动；减少动态时直接显示终态）：打字机、老虎机数字滚动、限时「滚动中」状态。
import { useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

/** 打字机：在 totalMs 内逐字显示 text（每字 20..90ms） */
export function useTypewriter(text: string, totalMs: number): string {
  const reduce = useReducedMotion();
  const [n, setN] = useState(() => (reduce ? Number.POSITIVE_INFINITY : 0));
  useEffect(() => {
    const len = [...text].length;
    if (reduce || len === 0) {
      setN(len);
      return;
    }
    setN(0);
    const step = Math.min(90, Math.max(20, totalMs / len));
    let i = 0;
    const id = setInterval(() => {
      i++;
      setN(i);
      if (i >= len) clearInterval(id);
    }, step);
    return () => clearInterval(id);
  }, [text, totalMs, reduce]);
  return [...text].slice(0, n).join('');
}

/** rollMs 内为 true（滚动中），之后为 false；减少动态时直接 false（弹窗每次打开都会重新挂载） */
export function useRolling(rollMs: number): boolean {
  const reduce = useReducedMotion();
  const [rolling, setRolling] = useState(!reduce && rollMs > 0);
  useEffect(() => {
    if (reduce || rollMs <= 0) {
      setRolling(false);
      return;
    }
    setRolling(true);
    const id = setTimeout(() => setRolling(false), rollMs);
    return () => clearTimeout(id);
  }, [rollMs, reduce]);
  return rolling;
}

/** 滚动中每 tickMs 换一个 0..max-1 的伪随机数（纯展示） */
export function useSpinner(active: boolean, max: number, tickMs = 70): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!active) return;
    let s = 7;
    const id = setInterval(() => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      setV(s % max);
    }, tickMs);
    return () => clearInterval(id);
  }, [active, max, tickMs]);
  return v;
}
