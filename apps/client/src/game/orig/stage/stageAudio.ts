// 原版舞台的声音（original-skin.md §5 A8 × A9）：
// - FLIC 同步音效（flic-map 的 sfx，原版在首帧由 0x452a83 播放）由原版舞台经 ctx.audio 放出；原版棋盘在场时把音频导演层的
//   flicSfx 置为 true（audio/director：soundMap 里 flicCovered 的提示不再另放），避免同一演出响两次；
// - 反过来，flicCovered 的事件如果这次没有 FLIC（得卡不在卡片格、3×3 炸弹、素材包缺条目或载入失败），舞台补放同一提示的
//   回退音（有 FLIC 条目时用它的同步音效，否则用提示的 ZzFX 预设），保证每个事件恰好响一次；
// - flicSfx 开关经 app/audioWiring 的 wiredAudio() 设置（音频模块懒加载；?audio=off 或没有 Web Audio 时不加载）。
import type { GameEvent } from '@rich4/shared/engine';
import { webAudioAvailable } from '../../../app/audio';
import { appFlags } from '../../../app/flags';
import type { SfxCue, SoundQuery } from '../../../audio/cues';
import { SOUND_MAP } from '../../../presentation/soundMap';

/** flicCovered 的规则只看事件本身；取到查询时说明规则变了，按「不是 flicCovered」处理 */
const NO_QUERY = new Proxy({} as SoundQuery, {
  get() {
    throw new Error('flicCovered 规则不应读取 SoundQuery');
  },
});

type SfxRule = SfxCue | null | ((e: GameEvent, q: SoundQuery) => SfxCue | null);

/** 事件的音效提示若在原版皮肤里由 FLIC 出声（soundMap 的 flicCovered），返回该提示；否则 null */
export function flicCoveredCue(e: GameEvent): SfxCue | null {
  const spec = SOUND_MAP[e.type] as { sfx?: SfxRule };
  const r = spec.sfx;
  if (r === undefined || r === null) return null;
  let c: SfxCue | null;
  try {
    c = typeof r === 'function' ? r(e, NO_QUERY) : r;
  } catch {
    return null;
  }
  return c?.flicCovered === true ? c : null;
}

/** flicSfx 开关（音频导演层的 AudioDirectorOptions.flicSfx） */
export interface FlicSfxSwitch {
  /** 原版舞台在场：置 true；返回的函数撤销（全部撤销后恢复 false） */
  claim(): () => void;
  /** 音频模块可能晚于棋盘接好：事件开始时再对一次 */
  refresh(): void;
}

interface DirectorLike {
  readonly options: { readonly flicSfx: boolean };
  setOptions(o: { flicSfx: boolean }): void;
}

interface WiringModule {
  wiredAudio(): { director: DirectorLike } | null;
}

/** 按 app/audioWiring 的导演层实现开关（loader 可注入，测试用） */
export function createFlicSfxSwitch(
  loader: () => Promise<WiringModule> = () => import('../../../app/audioWiring'),
  enabled: () => boolean = audioEnabled,
): FlicSfxSwitch {
  let mod: WiringModule | null = null;
  let loading = false;
  let claims = 0;
  const apply = (): void => {
    if (mod) {
      const d = mod.wiredAudio()?.director;
      const want = claims > 0;
      if (d && d.options.flicSfx !== want) d.setOptions({ flicSfx: want });
      return;
    }
    if (loading || claims === 0 || !enabled()) return;
    loading = true;
    loader()
      .then((m) => {
        mod = m;
        apply();
      })
      .catch(() => {
        // 音频模块加载失败：本页静音，不影响演出
      });
  };
  return {
    claim() {
      claims++;
      apply();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        claims--;
        apply();
      };
    },
    refresh: apply,
  };
}

/** 与 app/audio.installAudio 同一判定：没有 ?audio=off 且浏览器有 Web Audio */
function audioEnabled(): boolean {
  return !appFlags().audioOff && webAudioAvailable();
}

let appSwitch: FlicSfxSwitch | null = null;

/** 全局开关（原版棋盘共用一个） */
export function appFlicSfx(): FlicSfxSwitch {
  appSwitch ??= createFlicSfxSwitch();
  return appSwitch;
}
