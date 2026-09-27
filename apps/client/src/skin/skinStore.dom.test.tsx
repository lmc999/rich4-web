// skinStore（client-dom）：素材包发现（先问 /api/access，mode off 的生产构建不请求 manifest）、门禁、地图匹配与预取、
// 设置切换、界面语言与主题（原版 → zh-TW + data-skin），以及设置页显示的回退原因。
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syntheticManifest,
  syntheticMap,
  syntheticMapSkin,
} from '../../../../packages/shared/src/assets/testing/synthetic';
import { setUiLanguage } from '../i18n';
import { useSettingsStore } from '../store/settingsStore';
import { setAccessFetch } from '../ui/access/accessApi';
import { useAccessStore } from '../ui/access/accessStore';
import { SettingsDialog } from '../ui/system/SettingsDialog';
import type { BoardFactory } from './BoardSurface';
import { registerBoardFactory } from './boardRegistry';
import type { FetchLike } from './pack/http';
import { PackClient } from './pack/PackClient';
import {
  currentPackClient,
  notePackAccessDenied,
  packClient,
  resetSkinStoreForTest,
  shouldProbePack,
  useSkinStore,
} from './skinStore';
import { appliedSkin, applySkinTheme, resetSkinThemeForTest } from './theme';
import { useGameSkin } from './useGameSkin';

const manifest = syntheticManifest();
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Access = { mode: 'off' | 'passcode'; granted: boolean };

function setup(o: {
  access: Access | null;
  manifestStatus?: number;
  /** 地图皮肤文件的状态码（缺省 200） */
  fileStatus?: () => number;
  env?: { dev: boolean; forced: boolean };
}) {
  const urls: string[] = [];
  const accessFetch: FetchLike = async (url) => {
    urls.push(url);
    if (!o.access) return json({ ok: false }, 404);
    return json({
      ok: true,
      data: { ...o.access, kind: o.access.granted ? 'p' : null, expiresAt: null, grants: false, canGrant: false },
    });
  };
  const packFetch: FetchLike = async (url) => {
    urls.push(url);
    if (url === '/pack/manifest.json') {
      return o.manifestStatus && o.manifestStatus !== 200 ? json({ ok: false }, o.manifestStatus) : json(manifest);
    }
    if (url === `/pack/${manifest.files['maps/test.skin.json']!.path}`) {
      const st = o.fileStatus?.() ?? 200;
      return st === 200 ? json(syntheticMapSkin()) : json({ ok: false, error: { code: 'ACCESS_REQUIRED' } }, st);
    }
    return json({ ok: false }, 404);
  };
  setAccessFetch(accessFetch);
  // 与 skinStore.packClient() 创建的实例一样：401 → notePackAccessDenied
  const client = new PackClient({ fetch: packFetch, onAccessRequired: () => notePackAccessDenied() });
  resetSkinStoreForTest({ client, env: o.env ?? { dev: false, forced: false } });
  useAccessStore.setState({ status: null, statusError: false, required: null });
  return { urls, client };
}

beforeEach(() => {
  useSettingsStore.getState().setSkin('auto');
  resetSkinThemeForTest();
});

afterEach(async () => {
  setAccessFetch(null);
  registerBoardFactory('original', null);
  delete document.documentElement.dataset.skin;
  await act(async () => {
    await setUiLanguage('zh-CN');
  });
});

describe('素材包发现', () => {
  it('shouldProbePack：pack 字段优先；门禁开启就请求；mode off 只在开发构建或强制时请求', () => {
    const st = (mode: 'off' | 'passcode', extra = {}) =>
      ({ mode, granted: true, kind: null, expiresAt: null, grants: false, canGrant: false, ...extra }) as never;
    const prod = { dev: false, forced: false };
    expect(shouldProbePack(st('passcode'), prod)).toBe(true);
    expect(shouldProbePack(st('off'), prod)).toBe(false);
    expect(shouldProbePack(st('off'), { dev: true, forced: false })).toBe(true);
    expect(shouldProbePack(st('off'), { dev: false, forced: true })).toBe(true);
    expect(shouldProbePack(null, prod)).toBe(false);
    expect(shouldProbePack(st('off', { pack: 'abc' }), prod)).toBe(true);
    expect(shouldProbePack(st('passcode', { pack: null }), prod)).toBe(false);
  });

  it('门禁关闭的生产构建：不请求 manifest，判定为程序化（pack-absent）', async () => {
    const { urls } = setup({ access: { mode: 'off', granted: true } });
    await useSkinStore.getState().ensurePack();
    expect(urls).toEqual(['/api/access']);
    expect(useSkinStore.getState().pack).toMatchObject({ status: 'absent', detail: 'accessOff' });
    expect(useSkinStore.getState().resolution).toMatchObject({ skin: 'procedural', reason: 'pack-absent' });
  });

  it('/api/access 不可用（旧服务器）：不请求 manifest', async () => {
    const { urls } = setup({ access: null });
    await useSkinStore.getState().ensurePack();
    expect(urls).toEqual(['/api/access']);
    expect(useSkinStore.getState().pack).toMatchObject({ status: 'absent', detail: 'accessUnknown' });
  });

  it('门禁开启且已通过：请求 manifest；地图匹配 → 原版界面，原版渲染器未注册时棋盘回退；预取地图组', async () => {
    const { urls, client } = setup({ access: { mode: 'passcode', granted: true } });
    const loadGroup = vi.spyOn(client, 'loadGroup').mockResolvedValue({} as never);
    await useSkinStore.getState().ensurePack();
    expect(urls).toEqual(['/api/access', '/pack/manifest.json']);
    expect(useSkinStore.getState().resolution).toMatchObject({ skin: 'original', packId: manifest.packId });
    useSkinStore.getState().setActiveMap(syntheticMap());
    const s = useSkinStore.getState();
    expect(s.mapCheck).toMatchObject({ status: 'ok', group: 'map.test' });
    expect(s.resolution).toMatchObject({ skin: 'original', board: 'procedural', boardReason: 'renderer-unavailable' });
    expect(loadGroup).toHaveBeenCalledWith('map.test');
    // 注册原版渲染器后重新判定为原版棋盘
    registerBoardFactory('original', (async () => {
      throw new Error('unused');
    }) as BoardFactory);
    expect(useSkinStore.getState().resolution.board).toBe('original');
    // 设置改为程序化
    useSettingsStore.getState().setSkin('procedural');
    expect(useSkinStore.getState().resolution).toMatchObject({ skin: 'procedural', reason: 'setting' });
  });

  it('地图组预取失败 → 分组缺失，auto 整体回退程序化', async () => {
    const { client } = setup({ access: { mode: 'passcode', granted: true } });
    vi.spyOn(client, 'loadGroup').mockRejectedValue(new Error('404'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useSkinStore.getState().ensurePack();
    useSkinStore.getState().setActiveMap(syntheticMap());
    await waitFor(() => expect(useSkinStore.getState().resolution.reason).toBe('group-missing'));
    expect(useSkinStore.getState().failedGroups).toEqual(['map.test']);
    warn.mockRestore();
  });

  it('地图几何与皮肤绑定不符 → map-mismatch（带明细）', async () => {
    setup({ access: { mode: 'passcode', granted: true } });
    await useSkinStore.getState().ensurePack();
    const moved = structuredClone(syntheticMap());
    moved.tiles[0]!.world = { x: 1, y: 1 };
    useSkinStore.getState().setActiveMap(moved);
    const r = useSkinStore.getState().resolution;
    expect(r).toMatchObject({ skin: 'procedural', reason: 'map-mismatch' });
    expect(r.mismatches.map((m) => m.code)).toEqual(['geometry']);
  });

  it('门禁开启但未通过：access-required 并要求门禁页；通过后自动重新发现', async () => {
    const { urls } = setup({ access: { mode: 'passcode', granted: false } });
    await useSkinStore.getState().ensurePack();
    expect(useSkinStore.getState().pack.status).toBe('access-required');
    expect(useAccessStore.getState().required).toBe('pack');
    expect(urls).toEqual(['/api/access']);
    setAccessFetch(async () =>
      json({
        ok: true,
        data: { mode: 'passcode', granted: true, kind: 'p', expiresAt: 1, grants: true, canGrant: true },
      }),
    );
    useAccessStore.getState().granted({
      mode: 'passcode',
      granted: true,
      kind: 'p',
      expiresAt: 1,
      grants: true,
      canGrant: true,
    });
    await waitFor(() => expect(useSkinStore.getState().pack.status).toBe('ready'));
  });

  it('manifest 401 → access-required；门禁页在已通过的状态下收起后重新请求', async () => {
    const { urls } = setup({ access: { mode: 'passcode', granted: true }, manifestStatus: 401 });
    await useSkinStore.getState().ensurePack();
    expect(useSkinStore.getState().resolution.reason).toBe('access-required');
    useAccessStore.getState().require('pack');
    const before = urls.filter((u) => u === '/pack/manifest.json').length;
    useAccessStore.getState().granted({
      mode: 'passcode',
      granted: true,
      kind: 'p',
      expiresAt: 1,
      grants: true,
      canGrant: true,
    });
    await waitFor(() => expect(urls.filter((u) => u === '/pack/manifest.json').length).toBe(before + 1));
  });
});

describe('素材包发现：失败与恢复', () => {
  const granted = {
    mode: 'passcode' as const,
    granted: true,
    kind: 'p' as const,
    expiresAt: 1,
    grants: true,
    canGrant: true,
  };

  it('PackClient chunk 加载失败：落到 absent(network)（不停在 loading、不抛未处理的 rejection）；下次 ensurePack 重新 import', async () => {
    const { urls } = setup({ access: { mode: 'passcode', granted: true } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let fail = true;
    const imports = vi.fn(async () => {
      if (fail) throw new TypeError('Failed to fetch dynamically imported module: /assets/PackClient-abc.js');
      return await import('./pack/PackClient');
    });
    resetSkinStoreForTest({ importClient: imports, env: { dev: false, forced: false } });
    const s1 = await useSkinStore.getState().ensurePack();
    expect(s1).toMatchObject({ status: 'absent', reason: 'network' });
    expect(useSkinStore.getState().pack.status).toBe('absent');
    expect(useSkinStore.getState().resolution.skin).toBe('procedural');
    fail = false;
    const s2 = await useSkinStore.getState().ensurePack();
    expect(imports).toHaveBeenCalledTimes(2);
    // 新实例用真实 fetch（jsdom 下没有服务器）：只要重新 import 并尝试了即可
    expect(s2.status).not.toBe('loading');
    expect(urls.filter((u) => u === '/api/access').length).toBeGreaterThanOrEqual(1);
    warn.mockRestore();
  });

  it('回归：重置单例之后才完成的旧 PackClient import 作废，不覆盖测试注入的客户端', async () => {
    let finish!: () => void;
    const slow = vi.fn(
      () =>
        new Promise<typeof import('./pack/PackClient')>((resolve) => {
          finish = () => void import('./pack/PackClient').then(resolve);
        }),
    );
    resetSkinStoreForTest({ importClient: slow });
    const stale = packClient();
    const injected = { injected: true } as unknown as PackClient;
    resetSkinStoreForTest({ client: injected });
    finish();
    await expect(stale).resolves.toBe(injected);
    expect(currentPackClient()).toBe(injected);
    // 重置成「没有客户端」之后才完成：同样不登记（不漏到之后的测试）
    resetSkinStoreForTest({ importClient: slow });
    const stale2 = packClient();
    resetSkinStoreForTest();
    finish();
    await expect(stale2).resolves.toBeInstanceOf(PackClient);
    expect(currentPackClient()).toBeNull();
  });

  it('门禁状态未知（/api/access 暂时失败）不缓存：恢复后下次 ensurePack 重新发现', async () => {
    const { urls } = setup({ access: null });
    expect(await useSkinStore.getState().ensurePack()).toMatchObject({ status: 'absent', detail: 'accessUnknown' });
    setAccessFetch(async (url) => {
      urls.push(url);
      return json({ ok: true, data: granted });
    });
    await useSkinStore.getState().ensurePack();
    expect(useSkinStore.getState().pack.status).toBe('ready');
    expect(urls.filter((u) => u === '/api/access')).toHaveLength(2);
    // 确定的结果（ready）缓存：再调用不再请求
    await useSkinStore.getState().ensurePack();
    expect(urls.filter((u) => u === '/api/access')).toHaveLength(2);
  });

  it('manifest 就绪后素材文件 401（cookie 过期 / 被吊销）：门禁页通过后整体重载，失败组清空、恢复原版', async () => {
    let fileStatus = 401;
    const { urls, client } = setup({ access: { mode: 'passcode', granted: true }, fileStatus: () => fileStatus });
    // 组里只取地图皮肤（经真实的 fetchFile：401 → onAccessRequired）；合成图集的内容与本测试无关
    const loadMapSkin = client.loadMapSkin.bind(client);
    vi.spyOn(client, 'loadGroup').mockImplementation(async () => {
      await loadMapSkin('test');
      return {} as never;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useSkinStore.getState().ensurePack();
    useSkinStore.getState().setActiveMap(syntheticMap());
    await waitFor(() => expect(useSkinStore.getState().resolution.reason).toBe('group-missing'));
    expect(useSkinStore.getState().pack.status).toBe('ready');
    expect(useAccessStore.getState().required).toBe('pack');
    const manifests = urls.filter((u) => u === '/pack/manifest.json').length;
    // 门禁页（reason 'pack'）通过：只收起、不刷新页面
    fileStatus = 200;
    useAccessStore.getState().granted(granted);
    await waitFor(() => expect(urls.filter((u) => u === '/pack/manifest.json').length).toBe(manifests + 1));
    await waitFor(() => expect(useSkinStore.getState().resolution).toMatchObject({ skin: 'original', reason: null }));
    expect(useSkinStore.getState().failedGroups).toEqual([]);
    useSkinStore.getState().setActiveMap(null);
    warn.mockRestore();
  });

  it('音频或映射表被 401（notePackAccessDenied）同样在门禁页通过后重载素材包', async () => {
    const { urls } = setup({ access: { mode: 'passcode', granted: true } });
    await useSkinStore.getState().ensurePack();
    const before = urls.filter((u) => u === '/pack/manifest.json').length;
    notePackAccessDenied();
    expect(useAccessStore.getState().required).toBe('pack');
    useAccessStore.getState().granted(granted);
    await waitFor(() => expect(urls.filter((u) => u === '/pack/manifest.json').length).toBe(before + 1));
    // 之后门禁状态的普通变化不再触发重载
    useAccessStore.getState().granted({ ...granted, expiresAt: 2 });
    await Promise.resolve();
    expect(urls.filter((u) => u === '/pack/manifest.json').length).toBe(before + 1);
  });

  it('设置从「程序化」切到「自动」：判定变成原版时预取并校验地图组（失败照样回退）', async () => {
    useSettingsStore.getState().setSkin('procedural');
    const { client } = setup({ access: { mode: 'passcode', granted: true } });
    const loadGroup = vi.spyOn(client, 'loadGroup').mockRejectedValue(new Error('404'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useSkinStore.getState().ensurePack();
    useSkinStore.getState().setActiveMap(syntheticMap());
    expect(loadGroup).not.toHaveBeenCalled();
    useSettingsStore.getState().setSkin('auto');
    expect(loadGroup).toHaveBeenCalledWith('map.test');
    await waitFor(() => expect(useSkinStore.getState().resolution.reason).toBe('group-missing'));
    useSkinStore.getState().setActiveMap(null);
    warn.mockRestore();
  });
});

/** MapDef 在对局页里是稳定引用（mapStore）；这里同样用模块级常量 */
const PROBE_MAP = syntheticMap();

function GameSkinProbe({ on }: { on: boolean }) {
  const def = on ? (PROBE_MAP as never) : null;
  const s = useGameSkin(def);
  return <output data-testid="probe">{`${s.resolution.skin}/${s.resolution.board}/${s.waitForPack}`}</output>;
}

describe('对局页皮肤钩子与界面语言', () => {
  it('原版皮肤：zh-TW + data-skin=original + 原版字体栈；离开对局页恢复简体', async () => {
    setup({ access: { mode: 'passcode', granted: true } });
    const client = (await import('./skinStore')).currentPackClient()!;
    vi.spyOn(client, 'loadGroup').mockResolvedValue({} as never);
    const view = render(<GameSkinProbe on />);
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('original/procedural/false'));
    await waitFor(() => expect(i18next.language).toBe('zh-TW'));
    expect(document.documentElement.dataset.skin).toBe('original');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(document.getElementById('rich4-skin-original')?.textContent).toContain('local("MingLiU")');
    expect(window.__rich4?.skin).toMatchObject({ pack: 'ready', applied: 'original', lang: 'zh-TW' });
    view.unmount();
    await waitFor(() => expect(i18next.language).toBe('zh-CN'));
    expect(document.documentElement.dataset.skin).toBeUndefined();
    expect(useSkinStore.getState().activeMap).toBeNull();
  });

  it('回归：地图载入前沿用当前主题（从原版大厅开局不闪 zh-TW → zh-CN → zh-TW）', async () => {
    setup({ access: { mode: 'passcode', granted: true } });
    const client = (await import('./skinStore')).currentPackClient()!;
    vi.spyOn(client, 'loadGroup').mockResolvedValue({} as never);
    // 大厅已应用原版主题
    await act(async () => {
      await applySkinTheme('original');
    });
    expect(i18next.language).toBe('zh-TW');
    const seen: string[] = [];
    const onLang = (l: string): void => {
      seen.push(l);
    };
    i18next.on('languageChanged', onLang);
    try {
      const view = render(<GameSkinProbe on={false} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.documentElement.dataset.skin).toBe('original');
      expect(appliedSkin()).toBe('original');
      view.rerender(<GameSkinProbe on />);
      await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('original/procedural/false'));
      expect(i18next.language).toBe('zh-TW');
      expect(seen).toEqual([]);
      view.unmount();
      await waitFor(() => expect(i18next.language).toBe('zh-CN'));
    } finally {
      i18next.off('languageChanged', onLang);
    }
  });

  it('没有素材包：保持简体与程序化', async () => {
    setup({ access: { mode: 'off', granted: true } });
    render(<GameSkinProbe on />);
    await waitFor(() => expect(useSkinStore.getState().pack.status).toBe('absent'));
    expect(screen.getByTestId('probe')).toHaveTextContent('procedural/procedural/false');
    expect(i18next.language).toBe('zh-CN');
    expect(document.documentElement.dataset.skin).toBeUndefined();
  });
});

describe('设置页：皮肤选项与回退原因', () => {
  it('显示当前判定与原因；切换选项写入设置', async () => {
    setup({ access: { mode: 'off', granted: true } });
    render(<SettingsDialog open onOpenChange={() => {}} inGame />);
    await waitFor(() =>
      expect(screen.getByTestId('settings-skin-reason')).toHaveAttribute('data-reason', 'pack-absent'),
    );
    expect(screen.getByTestId('settings-skin-reason')).toHaveTextContent('本站没有原版素材包');
    expect(screen.getByTestId('settings-skin-auto')).toBeChecked();
    await userEvent.click(screen.getByTestId('settings-skin-procedural'));
    expect(useSettingsStore.getState().skin).toBe('procedural');
    expect(screen.getByTestId('settings-skin-reason')).toHaveAttribute('data-reason', 'setting');
  });

  it('地图不匹配：列出明细；需要口令时给出入口', async () => {
    setup({ access: { mode: 'passcode', granted: true } });
    await useSkinStore.getState().ensurePack();
    const moved = structuredClone(syntheticMap());
    moved.lots[0]!.facing = 5;
    useSkinStore.getState().setActiveMap(moved);
    const { unmount } = render(<SettingsDialog open onOpenChange={() => {}} inGame />);
    expect(screen.getByTestId('settings-skin-reason')).toHaveAttribute('data-reason', 'map-mismatch');
    expect(screen.getByTestId('settings-skin-mismatch')).toHaveTextContent('坐标 / 朝向有变化');
    unmount();
    useSkinStore.getState().setActiveMap(null);
    setup({ access: { mode: 'passcode', granted: false } });
    render(<SettingsDialog open onOpenChange={() => {}} inGame={false} />);
    await waitFor(() => expect(screen.getByTestId('settings-skin-unlock')).toBeInTheDocument());
  });
});
