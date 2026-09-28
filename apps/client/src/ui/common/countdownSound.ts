// 决策倒计时的提示音：最后 10 秒每跨过一个整秒一声「嘀」，最后 3 秒高音双响（原版没有决策计时，素材包里没有语义对应的
// 音效，一律用 ZzFX 预设 countdown / countdownFinal）。经音频导演层的 uiCue 播放，走音效总线：受静音、主音量与音效音量控制。
// 音频模块懒加载（app/audioWiring）；?audio=off 或浏览器没有 Web Audio 时不出声。引擎还没被手势解锁（iOS）或切到后台被挂起时，
// 引擎自己丢弃这一声，不排队、不补播。
// 测试钩子：window.__rich4.countdown.beeps 记下每一次请求（E2E 断言「最后 10 秒每秒一次、提交后停止」，不必真的听声音）。
import { webAudioAvailable } from '../../app/audio';
import { appFlags, testHooksEnabled } from '../../app/flags';
import { type CountdownBeepRecord, testHooks } from '../../dev/testHooks';
import type { BeepLevel } from './countdownLogic';

/** 双响的第二声与第一声相隔（ms） */
export const FINAL_ECHO_MS = 130;
/** 测试钩子最多保留的记录数 */
const RECORD_LIMIT = 200;

type CountdownCue = 'countdown' | 'countdownFinal';

interface WiringModule {
  wiredAudio(): {
    director: { uiCue(name: CountdownCue): unknown; preloadUiCues(names: readonly CountdownCue[]): Promise<void> };
  } | null;
}

let mod: WiringModule | null = null;
let loading: Promise<WiringModule | null> | null = null;

function enabled(): boolean {
  return !appFlags().audioOff && webAudioAvailable();
}

function defaultLoader(): Promise<WiringModule> {
  return import('../../app/audioWiring') as Promise<unknown> as Promise<WiringModule>;
}

/** 载入音频接线模块（已在载入中则复用；失败后下次再试） */
function ensureLoaded(loader: () => Promise<WiringModule> = defaultLoader): Promise<WiringModule | null> {
  if (mod) return Promise.resolve(mod);
  loading ??= loader().then(
    (m) => {
      mod = m;
      return m;
    },
    () => {
      loading = null;
      return null;
    },
  );
  return loading;
}

function record(r: CountdownBeepRecord): void {
  if (!testHooksEnabled()) return;
  const h = testHooks();
  if (!h) return;
  h.countdown ??= { beeps: [] };
  h.countdown.beeps.push(r);
  if (h.countdown.beeps.length > RECORD_LIMIT) h.countdown.beeps.splice(0, h.countdown.beeps.length - RECORD_LIMIT);
}

function cueOf(level: BeepLevel): CountdownCue {
  return level === 'final' ? 'countdownFinal' : 'countdown';
}

function play(cue: CountdownCue): boolean {
  try {
    const sys = mod?.wiredAudio() ?? null;
    if (!sys) return false;
    sys.director.uiCue(cue);
    return true;
  } catch {
    // 提示音失败不影响对局
    return false;
  }
}

/**
 * 放一声倒计时提示音（final 档 FINAL_ECHO_MS 后再放一次成双响）；返回取消函数（决策提交、倒计时卸载时取消还没响的第二声）。
 * 音频模块还没载入时先载入，这一声跳过。
 */
export function playCountdownBeep(level: BeepLevel, info: { decisionId: string; secs: number }): () => void {
  const on = enabled();
  if (on && !mod) void ensureLoaded();
  const cue = cueOf(level);
  const audio = on && play(cue);
  record({ decisionId: info.decisionId, secs: info.secs, level, at: Date.now(), audio });
  if (!audio || level !== 'final') return () => {};
  const id = setTimeout(() => play(cue), FINAL_ECHO_MS);
  return () => clearTimeout(id);
}

/** 倒计时出现时预载两档提示音（ZzFX 首次合成较慢，超过引擎的时延上限会整声作废） */
export function prepareCountdownSound(): void {
  if (!enabled()) return;
  void ensureLoaded().then((m) => {
    void m
      ?.wiredAudio()
      ?.director.preloadUiCues(['countdown', 'countdownFinal'])
      .catch(() => {});
  });
}

/** 测试：换音频模块（null 为还原成未载入） */
export function setCountdownSoundModuleForTest(m: WiringModule | null): void {
  mod = m;
  loading = null;
}
