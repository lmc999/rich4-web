// 小游戏原版视图的声音（原版皮肤 A13；design-draft §3.7）：
// - 音效：按原版音效号播放（素材包里的 sfx.NNN；没有音频条目时换 ZzFX 回退），打开时预载本游戏的音效集；
// - 场景曲：本人的小游戏由导演层按决策（场所 MINIGAME）切换；观战与回放没有这个决策，由宿主在遮罩打开期间压入本游戏的
//   场景曲（喜从天降 track20 / 七彩气球 track21 / 企鹅挖宝 track22），关闭时收起，棋盘曲从断点续播。
// 音频系统由 app/audio 懒加载；?audio=off、jsdom 或尚未接好时静默。
import type { PackManifestV1 } from '@rich4/shared/assets';
import type { MinigameId } from '@rich4/shared/minigames';
import { appFlags } from '../../app/flags';
import { MG_SFX_SETS, resolveSfx } from './keys';

/** 视图用到的声音接口 */
export interface MgSound {
  play(sfx: number): void;
}

export const SILENT: MgSound = { play: () => {} };

interface EngineLike {
  playSfx(key: string): void;
  pushScene(key: string, o?: { noResume?: boolean }): number;
  popScene(token: number): void;
  preload(keys: readonly string[]): Promise<void>;
}

export class MgAudio implements MgSound {
  private engine: EngineLike | null = null;
  private bgm: number | null = null;
  private closed = false;
  /** 已播放的音效键（测试与调试） */
  readonly played: string[] = [];

  constructor(
    private readonly manifest: PackManifestV1 | null,
    private readonly id: MinigameId,
    o: { bgm: boolean },
  ) {
    void this.init(o.bgm);
  }

  private async init(bgm: boolean): Promise<void> {
    if (appFlags().audioOff || typeof window === 'undefined') return;
    try {
      const [wiring, sel] = await Promise.all([import('../../app/audioWiring'), import('../../audio/selectors')]);
      const sys = wiring.wiredAudio();
      if (!sys || this.closed) return;
      this.engine = sys.engine;
      const keys = MG_SFX_SETS[this.id].map((n) => resolveSfx(this.manifest, n)).filter((k): k is string => k !== null);
      void sys.engine.preload(keys).catch(() => {});
      if (bgm) {
        const key = sel.musicKeyFor(this.id, sys.director.currentMaps.musicMap);
        if (key) this.bgm = sys.engine.pushScene(key);
      }
    } catch (e) {
      console.warn('[minigame] 音频不可用', e);
    }
  }

  play(sfx: number): void {
    const key = resolveSfx(this.manifest, sfx);
    if (!key) return;
    this.played.push(key);
    if (this.played.length > 64) this.played.shift();
    this.engine?.playSfx(key);
  }

  close(): void {
    this.closed = true;
    if (this.bgm !== null) this.engine?.popScene(this.bgm);
    this.bgm = null;
  }
}
