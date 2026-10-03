// 棋盘特效的时长（1x，ms）：Fx / BoardStage 与演出预算测试共用（不依赖 Pixi）。
// handler 的节奏按这些常数编排，保证在 shared/view/pacing 的 EVENT_BUDGET_MS 之内（见 handlers/budget.test.ts）。
export const FLOAT_MS = 1000;
export const COIN_MS = 560;
export const COIN_COUNT = 8;
export const COIN_STAGGER_MS = 30;
/** 金币飞行总时长：最后一枚出发时间 + 飞行时长 */
export const COIN_FLIGHT_MS = (COIN_COUNT - 1) * COIN_STAGGER_MS + COIN_MS;
export const FLAG_MS = 380;
export const POP_MS = 420;
export const HOP_MS = 260;

// ───────── M6 / M7 演出（BoardStage 的阻塞时长） ─────────

/** 路面物件从天而降并弹一下 */
export const FX_DROP_MS = 420;
/** 路面物件被移除（弹飞 / 淡出） */
export const FX_REMOVE_MS = 360;
/** 普通爆炸（地雷、身上的定时炸弹） */
export const FX_EXPLODE_MS = 720;
/** 飞弹：从天而降 + 3×3 冲击 */
export const FX_MISSILE_FALL_MS = 520;
export const FX_MISSILE_BLAST_MS = 820;
export const FX_MISSILE_MS = FX_MISSILE_FALL_MS + FX_MISSILE_BLAST_MS;
/** 核弹：蘑菇云 + 全屏白闪 + 震屏 */
export const FX_NUKE_FALL_MS = 520;
export const FX_NUKE_BLAST_MS = 1250;
export const FX_NUKE_MS = FX_NUKE_FALL_MS + FX_NUKE_BLAST_MS;
/** 光柱（神明降临、传送、显灵） */
export const FX_PILLAR_MS = 600;
/** 光束（出卡连到目标） */
export const FX_BEAM_MS = 420;
/** 时光机倒带滤镜 */
export const FX_REWIND_MS = 900;
/** 神明降临：光柱 + 缩小附身 */
export const FX_GOD_ARRIVE_MS = 900;
/** 神明离身：旋转上升 */
export const FX_GOD_LEAVE_MS = 620;
/** 路上出现神明 */
export const FX_GOD_SPAWN_MS = 420;
/** 神明发威：光环爆发 */
export const FX_GOD_POWER_MS = 600;
/** 神明显灵（地块升降级、夺地） */
export const FX_MANIFEST_MS = 900;
/** 恶犬咬人 / 被撞开 */
export const FX_BITE_MS = 700;
/** 救护车 / 警车开来接走 */
export const FX_ESCORT_MS = 1050;
/** 开门闪光（保释、出国回来） */
export const FX_RELEASE_MS = 480;
/**
 * 程序化棋盘：获释时从医院 / 监狱 / 旅馆里跳着走出来（住旅馆时走进去）最多跳几下，每下 STEP_MS（建筑中心到门前的格约
 * 1–2 格）。原版皮肤按原版 tick 匀速走（shared/view/pacing 的 WALK_OUT）
 */
export const WALK_OUT_HOPS_MAX = 3;
/** 车毁 */
export const FX_WRECK_MS = 620;
/** 传送：两端光柱 */
export const FX_TELEPORT_MS = 900;
/** 魔法屋：女巫挥杖 + 魔法阵 */
export const FX_MAGIC_MS = 1000;
/** 定时炸弹转移：炸弹划弧飞到另一人身上 */
export const FX_BOMB_PASS_MS = 520;
/** 定时炸弹贴到身上 */
export const FX_BOMB_ATTACH_MS = 480;
/** 终局烟花（不阻塞，只给参考时长） */
export const FX_FIREWORKS_MS = 2400;
/** 施放姿势（出卡、用道具）的停顿 */
export const FX_CAST_MS = 360;
/** 乞丐挪窝 */
export const FX_BEGGAR_MOVE_MS = 420;

/** 画质档的粒子上限（design/client.md §8） */
export const PARTICLE_LIMITS = { high: 400, mid: 150, low: 0 } as const;

// ───────── 原版皮肤 A8：OrigStage 的原版 FLIC 可用时长（original-skin.md §3 修正 1） ─────────

/** FLIC 首帧对齐与收尾的余量（与 shared/view/pacing 的 FLIC_SLACK_MS 一致：original 预算 = FLIC 原长 + 其他等待 + 余量） */
export const ORIG_FLIC_SLACK_MS = 100;

/**
 * 播原版 FLIC 的 handler 里 FLIC 之外的等待（1x，ms；逐 handler 按 presentation/handlers 的编排推算）：
 * before 为 FLIC 开始前串行的等待，after 为 FLIC 结束后的等待；与 FLIC 并行的弹窗 / 横幅 / 等待不计（取两者较长）。
 * FLIC 的可用时长 = 当前节奏的事件预算 − before − after − ORIG_FLIC_SLACK_MS（game/orig/stage/flicPlan.ts）：
 * original 节奏下 ≥ FLIC 原长（原速完整播放），compact 节奏下 playFit 加速或截取。
 */
export const ORIG_FLIC_WAITS = {
  /** placeActor → focus 400 → hop（棋盘伞 FLIC）→ wait 200 */
  PARACHUTE: { before: 400, after: 200 },
  /** GodArrivePopup ∥ godArrive（神明降临 FLIC）→ wait 100 */
  GOD_ATTACHED: { before: 0, after: 100 },
  /** godLeave（烟雾 FLIC）→ wait 100 */
  GOD_LEFT: { before: 0, after: 100 },
  /** focus 250 → escort（警车 / 救护车 FLIC）→ wait 100 */
  CONFINED: { before: 250, after: 100 },
  /** focus 300 → explode big（碎屑爆炸 FLIC）→ wait 400 */
  BOMB_EXPLODED: { before: 300, after: 400 },
  /** focus 400 → strike（飞弹 / 核弹 / 外星人 / 台风 FLIC）→ wait 150 */
  STRIKE: { before: 400, after: 150 },
  /** removeObject boom（小爆炸 FLIC） */
  OBJECT_REMOVED: { before: 0, after: 0 },
  /**
   * 得卡 FLIC ∥ wait 400；原版皮肤亮卡时 FLIC 之后亮卡 1.5 秒 + 收尾 0.1 秒（两种节奏都按 original 的亮卡预留，
   * 见 shared/view/pacing 的 CARD_GAIN_AFTER_FLIC_MS：载入慢时压缩的是 FLIC，不截断亮卡）
   */
  CARD_GAINED: { before: 0, after: 1600 },
  /** 得点券 FLIC ∥ 飘字 + wait 500 */
  POINTS_GAINED: { before: 0, after: 0 },
  /** 烟火 / 圣诞 FLIC ∥ 节日横幅 1500 */
  HOLIDAY: { before: 0, after: 0 },
  /** 房屋倒塌 FLIC ∥ 破产横幅 1800 */
  BANKRUPT: { before: 0, after: 0 },
} as const satisfies Readonly<Record<string, { readonly before: number; readonly after: number }>>;
