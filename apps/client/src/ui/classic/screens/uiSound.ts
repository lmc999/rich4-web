// 标题 / 开局画面的界面音（悬停、点击、返回、打开）与对局里 GO 钮的点击声（go）：经音频导演层的 uiCue 播放
// （原版素材包的界面音效集，缺失时 ZzFX）。音频模块懒加载（app/audioWiring）；?audio=off 或浏览器没有 Web Audio 时
// 什么也不做。音频未解锁（没有用户手势）时引擎自己丢弃，不报错。
import { webAudioAvailable } from '../../../app/audio';
import { appFlags } from '../../../app/flags';

export type ScreenCue = 'click' | 'back' | 'open' | 'move' | 'go';

interface WiringModule {
  wiredAudio(): { director: { uiCue(name: ScreenCue): unknown } } | null;
}

let mod: WiringModule | null = null;
let loading = false;

function enabled(): boolean {
  return !appFlags().audioOff && webAudioAvailable();
}

/** 播放一个界面音（音频模块还没载入时先载入，这一声跳过） */
export function playScreenCue(cue: ScreenCue, loader: () => Promise<WiringModule> = defaultLoader): void {
  if (!enabled()) return;
  if (mod) {
    try {
      mod.wiredAudio()?.director.uiCue(cue);
    } catch {
      // 界面音失败不影响操作
    }
    return;
  }
  load(loader);
}

/** 预先载入音频模块（对局里 GO 钮挂上时调用：第一次按 GO 的那一声不因模块还没载入而跳过） */
export function warmScreenCues(loader: () => Promise<WiringModule> = defaultLoader): void {
  if (!enabled() || mod) return;
  load(loader);
}

function load(loader: () => Promise<WiringModule>): void {
  if (loading) return;
  loading = true;
  loader()
    .then((m) => {
      mod = m;
    })
    .catch(() => {
      loading = false;
    });
}

function defaultLoader(): Promise<WiringModule> {
  return import('../../../app/audioWiring') as Promise<unknown> as Promise<WiringModule>;
}

/** 测试：重置 */
export function resetScreenCueForTest(): void {
  mod = null;
  loading = false;
}
