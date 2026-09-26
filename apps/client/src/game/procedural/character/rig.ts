// SVG 纸娃娃骨架（design/client.md §6.2）：12 个角色、NPC、神明共用一套关节与姿势表。
// 画布 viewBox 0 0 128 160，脚底落在 FOOT_Y；Q 版比例约 1:1.1（头比身）。
// 角度单位为度，0 表示肢体竖直向下；「外展」为正：左臂（观者左侧）正角向左甩，右臂取负值后向右甩。

export const VIEW_W = 128;
export const VIEW_H = 160;
export const FOOT_Y = 152;
/** 统一描边 */
export const INK = '#3A2A1A';
export const STROKE_W = 3;

export const POSES = [
  'idle0',
  'idle1',
  'walk0',
  'walk1',
  'walk2',
  'walk3',
  'cheer',
  'sad',
  'hurt',
  'sleep',
  'cast',
] as const;
export type Pose = (typeof POSES)[number];

export const FACINGS = ['front', 'back'] as const;
export type Facing = (typeof FACINGS)[number];

export type Expression = 'normal' | 'happy' | 'sad' | 'angry' | 'shock' | 'sleep';

export type BodyBuild = 'adult' | 'kid' | 'baby';

export interface Skeleton {
  headCx: number;
  headCy: number;
  headR: number;
  neckY: number;
  shoulderY: number;
  shoulderDx: number;
  torsoTop: number;
  torsoBottom: number;
  hipY: number;
  hipDx: number;
  armLen: number;
  legLen: number;
  torsoW: number;
}

/** 体型骨架：成人略高、儿童腿短、婴儿更矮更圆 */
export const SKELETONS: Readonly<Record<BodyBuild, Skeleton>> = {
  adult: {
    headCx: 64,
    headCy: 54,
    headR: 31,
    neckY: 84,
    shoulderY: 92,
    shoulderDx: 15,
    torsoTop: 86,
    torsoBottom: 126,
    hipY: 124,
    hipDx: 8,
    armLen: 27,
    legLen: 26,
    torsoW: 34,
  },
  kid: {
    headCx: 64,
    headCy: 60,
    headR: 32,
    neckY: 91,
    shoulderY: 98,
    shoulderDx: 14,
    torsoTop: 93,
    torsoBottom: 129,
    hipY: 128,
    hipDx: 7,
    armLen: 24,
    legLen: 22,
    torsoW: 31,
  },
  baby: {
    headCx: 64,
    headCy: 74,
    headR: 33,
    neckY: 106,
    shoulderY: 112,
    shoulderDx: 15,
    torsoTop: 106,
    torsoBottom: 140,
    hipY: 138,
    hipDx: 8,
    armLen: 18,
    legLen: 13,
    torsoW: 36,
  },
};

export type PoseFx = 'none' | 'zzz' | 'stars' | 'sparkle' | 'tear' | 'sweat';

export interface PoseSpec {
  /** 整体上下偏移（负值向上，例如跳起） */
  bob: number;
  /** 头部倾斜（度，正为顺时针） */
  headTilt: number;
  armL: number;
  armR: number;
  /** 腿外展角 */
  legL: number;
  legR: number;
  /** 抬腿（像素，脚向上收） */
  liftL: number;
  liftR: number;
  expression: Expression;
  fx: PoseFx;
}

const base: PoseSpec = {
  bob: 0,
  headTilt: 0,
  armL: 10,
  armR: -10,
  legL: 3,
  legR: -3,
  liftL: 0,
  liftR: 0,
  expression: 'normal',
  fx: 'none',
};

export const POSE_SPECS: Readonly<Record<Pose, PoseSpec>> = {
  idle0: base,
  idle1: { ...base, bob: 1.5, armL: 13, armR: -13 },
  walk0: { ...base, bob: -2, armL: 34, armR: -4, legL: 12, legR: -4, liftL: 5 },
  walk1: { ...base, bob: 0, armL: 14, armR: -14 },
  walk2: { ...base, bob: -2, armL: 4, armR: -34, legL: 4, legR: -12, liftR: 5 },
  walk3: { ...base, bob: 0.5, armL: 12, armR: -12 },
  cheer: { ...base, bob: -7, armL: 150, armR: -150, legL: 14, legR: -14, expression: 'happy', fx: 'sparkle' },
  sad: { ...base, bob: 2, headTilt: 9, armL: 3, armR: -3, expression: 'sad', fx: 'tear' },
  hurt: { ...base, bob: 1, headTilt: -10, armL: 62, armR: -62, legL: 14, legR: -14, expression: 'shock', fx: 'stars' },
  sleep: { ...base, bob: 2, headTilt: 12, armL: 5, armR: -5, expression: 'sleep', fx: 'zzz' },
  cast: { ...base, bob: -2, armL: 22, armR: -128, expression: 'angry', fx: 'sparkle' },
};

/** 肢体末端点（从关节 (x,y) 沿角度 a 延伸 len） */
export function limbEnd(x: number, y: number, deg: number, len: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180;
  return { x: x - Math.sin(r) * len, y: y + Math.cos(r) * len };
}

/** 数值格式化：保留 1 位小数，避免 SVG 里出现长浮点 */
export function n(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}
