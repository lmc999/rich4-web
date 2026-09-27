// FLIC 时长适配（design-draft §3.5「playFit 的规则」；original-skin.md §3 修正 1）：
// - 原长不超过预算：原速播放；
// - 否则加速，速度上限 maxSpeed（缺省 2×）；
// - 仍超出时按目录里的 trim 截取（截取段同样先原速、再加速）；
// - 最后仍超出就在（截取后的）区间里均匀跳帧：保留首尾帧，按 maxSpeed 的帧距挑出能放进预算的帧数，停留时长摊满预算。
// 纯函数：输入帧数、帧间隔、可选 trim 与预算，输出要呈现的帧号与每帧停留时长。

export interface FlicTiming {
  /** 文件头帧数（不含循环帧） */
  frames: number;
  /** 原版帧间隔（ms） */
  frameMs: number;
  /** 可截取的区间（帧号，含 startFrame、不含 endFrame）；没有则 null */
  trim?: { startFrame: number; endFrame: number } | null;
}

export interface FitOptions {
  /** 加速上限（缺省 2） */
  maxSpeed?: number;
}

export interface FitPlan {
  /** 依次呈现的帧号（升序） */
  frames: number[];
  /** 每个呈现帧的停留时长（ms，可为小数） */
  frameMs: number;
  /** 相对原版的播放速度（跳帧时为「原长 / 实际时长」） */
  speed: number;
  trimmed: boolean;
  skipped: boolean;
  /** frames.length × frameMs */
  durationMs: number;
}

export const DEFAULT_MAX_SPEED = 2;

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** 在 [start, end) 里均匀挑 k 帧（含首尾） */
export function evenFrames(start: number, end: number, k: number): number[] {
  const n = end - start;
  if (n <= 0) return [];
  if (k >= n) return range(start, end);
  if (k <= 1) return [end - 1];
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(start + Math.round((i * (n - 1)) / (k - 1)));
  return out;
}

/** 在 [start, end) 区间内按预算适配（原速 → 加速 → 跳帧）；返回 null 表示加速仍放不下 */
function fitRange(start: number, end: number, frameMs: number, budget: number, maxSpeed: number): FitPlan | null {
  const n = end - start;
  const full = n * frameMs;
  if (full <= budget) {
    return { frames: range(start, end), frameMs, speed: 1, trimmed: false, skipped: false, durationMs: full };
  }
  if (full / maxSpeed <= budget) {
    const speed = full / budget;
    const ms = frameMs / speed;
    return { frames: range(start, end), frameMs: ms, speed, trimmed: false, skipped: false, durationMs: ms * n };
  }
  return null;
}

/**
 * 按预算规划播放。budgetMs ≤ 0 时只呈现终帧、停留 0ms（直接落到终态）。
 * 返回的 durationMs 不超过预算（跳帧时恰好摊满预算）。
 */
export function planFit(t: FlicTiming, budgetMs: number, opts: FitOptions = {}): FitPlan {
  const maxSpeed = opts.maxSpeed !== undefined && opts.maxSpeed >= 1 ? opts.maxSpeed : DEFAULT_MAX_SPEED;
  const frames = Math.max(0, Math.trunc(t.frames));
  const frameMs = t.frameMs > 0 ? t.frameMs : 1;
  if (frames === 0) return { frames: [], frameMs: 0, speed: 1, trimmed: false, skipped: false, durationMs: 0 };
  if (!(budgetMs > 0)) {
    return { frames: [frames - 1], frameMs: 0, speed: Infinity, trimmed: false, skipped: true, durationMs: 0 };
  }
  const whole = fitRange(0, frames, frameMs, budgetMs, maxSpeed);
  if (whole) return whole;

  let start = 0;
  let end = frames;
  let trimmed = false;
  const tr = t.trim;
  if (tr && tr.startFrame >= 0 && tr.endFrame <= frames && tr.startFrame < tr.endFrame) {
    start = tr.startFrame;
    end = tr.endFrame;
    trimmed = true;
    const part = fitRange(start, end, frameMs, budgetMs, maxSpeed);
    if (part) return { ...part, trimmed: true };
  }

  // 均匀跳帧：按 maxSpeed 的帧距最多放得下 k 帧（至少 1 帧），停留时长摊满预算
  const k = Math.max(1, Math.floor(budgetMs / (frameMs / maxSpeed)));
  const picked = evenFrames(start, end, k);
  const ms = budgetMs / picked.length;
  return {
    frames: picked,
    frameMs: ms,
    speed: (frames * frameMs) / budgetMs,
    trimmed,
    skipped: true,
    durationMs: ms * picked.length,
  };
}
