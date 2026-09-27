// 对局页的皮肤钩子：进入对局页时发现素材包，把当前 MapDef 交给 skinStore 判定，并应用界面语言与主题
// （原版 → zh-TW，程序化 → zh-CN；离开对局页恢复程序化）。同时把判定挂到测试钩子 window.__rich4.skin。
import type { MapDef } from '@rich4/shared/data';
import { useEffect } from 'react';
import { exposeSkin } from '../dev/testHooks';
import { uiLanguage } from '../i18n';
import { hasBoardFactory } from './boardRegistry';
import { useSkinStore } from './skinStore';
import { appliedSkin, applySkinTheme } from './theme';
import type { SkinResolution } from './types';

export interface GameSkin {
  resolution: SkinResolution;
  /** 棋盘要不要等素材包判定完再创建（只有注册了原版棋盘时才需要，避免先建程序化再重建） */
  waitForPack: boolean;
}

export function useGameSkin(def: MapDef | null): GameSkin {
  const resolution = useSkinStore((s) => s.resolution);
  const packStatus = useSkinStore((s) => s.pack.status);

  useEffect(() => {
    void useSkinStore.getState().ensurePack();
  }, []);

  useEffect(() => {
    useSkinStore.getState().setActiveMap(def);
    return () => useSkinStore.getState().setActiveMap(null);
  }, [def]);

  const kind = def ? resolution.skin : 'procedural';
  useEffect(() => {
    void applySkinTheme(kind);
  }, [kind]);

  // 离开对局页：恢复程序化皮肤与简体
  useEffect(
    () => () => {
      void applySkinTheme('procedural');
    },
    [],
  );

  useEffect(
    () =>
      exposeSkin(() => {
        const s = useSkinStore.getState();
        return {
          resolution: s.resolution,
          pack: s.pack.status,
          packId: s.pack.status === 'ready' ? s.pack.manifest.packId : null,
          failedGroups: [...s.failedGroups],
          boardInUse: s.boardInUse,
          applied: appliedSkin(),
          lang: uiLanguage(),
        };
      }),
    [],
  );

  const waitForPack = hasBoardFactory('original') && (packStatus === 'idle' || packStatus === 'loading');
  return { resolution, waitForPack };
}
