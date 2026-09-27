// /dev/audio：音频试听页（开发用）。列出音乐（棋盘轮播、场景曲，可进出场景核对续播）、音效集（含 cue.* 的语义置信度、
// guess 项默认走 ZzFX）、ZzFX 预设、语音（12 角色 × 27 事件槽、道具 / 卡片台词、NPC 与新闻）、事件 → 声音映射，
// 便于人工试听核对 guess 项。素材包经 skinStore / PackClient 发现（需要已通过访问门禁，未通过时弹门禁页）；没有时只有 ZzFX 回退。
// 开发页只给开发者看，文案不走 i18n。
import {
  CHARACTER_COUNT,
  type Confidence,
  MUSIC_SCENES,
  type MusicScene,
  type PackManifestV1,
  safeParsePackManifest,
  VOICE_CARD_MODES,
  VOICE_ITEM_REACTIONS,
  VOICE_SLOTS,
  type VoiceLine,
} from '@rich4/shared/assets';
import { CHARACTER_KEYS, type CharacterId } from '@rich4/shared/data';
import { GAME_EVENT_TYPES } from '@rich4/shared/engine';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'wouter';
import { SOUND_MAP } from '../../presentation/soundMap';
import { useSkinStore } from '../../skin/skinStore';
import { type AudioSystem, createAudioSystem } from '../index';
import { ZZFX_PRESET_IDS, zzfxKey } from '../procedural';
import { NO_RESUME_SCENES } from '../selectors';
import type { AudioMix } from '../types';

export interface AudioLabProps {
  /** 测试注入；缺省新建一套（浏览器环境） */
  system?: AudioSystem;
  /** 缺省读 /pack/manifest.json；返回 null 表示没有素材包 */
  loadManifest?: () => Promise<PackManifestV1 | null>;
}

async function fetchManifest(): Promise<PackManifestV1 | null> {
  try {
    const r = await fetch('/pack/manifest.json', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const p = safeParsePackManifest(await r.json());
    return p.ok ? p.value : null;
  } catch {
    return null;
  }
}

const CONF_COLOR: Readonly<Record<Confidence, string>> = { exe: '#1a7f37', visual: '#9a6700', guess: '#cf222e' };

function Conf({ c }: { c: Confidence | null | undefined }): ReactNode {
  if (!c) return <span style={{ opacity: 0.5 }}>—</span>;
  return (
    <span style={{ color: CONF_COLOR[c], fontWeight: 600 }} data-confidence={c}>
      {c}
    </span>
  );
}

function PlayKey({ k, onPlay, label }: { k: string; onPlay(k: string): void; label?: string }): ReactNode {
  return (
    <button type="button" className="btn btn--sm" onClick={() => onPlay(k)} data-key={k} style={{ margin: 2 }}>
      ▶ {label ?? k}
    </button>
  );
}

function Lines({ lines, onPlay }: { lines: readonly VoiceLine[] | undefined; onPlay(k: string): void }): ReactNode {
  if (!lines || lines.length === 0) return <span style={{ opacity: 0.5 }}>（无）</span>;
  return (
    <>
      {lines.map((l) => (
        <span key={l.key} style={{ whiteSpace: 'nowrap' }}>
          <PlayKey k={l.key} onPlay={onPlay} /> <Conf c={l.confidence} />
        </span>
      ))}
    </>
  );
}

const table: CSSProperties = { borderCollapse: 'collapse', fontSize: 13 };
const cell: CSSProperties = { border: '1px solid rgba(128,128,128,.35)', padding: '2px 6px', verticalAlign: 'top' };

type Tab = 'music' | 'sfx' | 'voice' | 'events';

/**
 * 试听页。没有注入 system 时自己建一套，并在卸载时释放：在 effect 里创建（开发构建的 StrictMode 会先卸载再挂载一次，
 * 用 useMemo 建的会在第一次卸载时被 dispose，之后引擎一直是 disposed）。
 */
export function AudioLab({ system: injected, loadManifest = fetchManifest }: AudioLabProps = {}): ReactNode {
  const [owned, setOwned] = useState<AudioSystem | null>(null);
  useEffect(() => {
    if (injected) return;
    const s = createAudioSystem();
    setOwned(s);
    return () => {
      s.dispose();
      setOwned((cur) => (cur === s ? null : cur));
    };
  }, [injected]);
  const sys = injected ?? owned;
  if (!sys) {
    return (
      <div style={{ padding: 12 }} role="status" data-testid="audio-lab-loading">
        正在准备音频引擎…
      </div>
    );
  }
  return <AudioLabView sys={sys} loadManifest={loadManifest} />;
}

function AudioLabView({
  sys,
  loadManifest,
}: {
  sys: AudioSystem;
  loadManifest: () => Promise<PackManifestV1 | null>;
}): ReactNode {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [pack, setPack] = useState<{ state: 'loading' | 'none' | 'ready'; id?: string }>({ state: 'loading' });
  const [tab, setTab] = useState<Tab>('music');
  const [char, setChar] = useState<CharacterId>(0);
  const [mix, setMix] = useState<AudioMix>({ ...sys.engine.settings });
  const [board, setBoard] = useState(false);
  const scenes = useRef(new Map<MusicScene, number>());

  useEffect(() => {
    let alive = true;
    const off = sys.engine.subscribe(bump);
    void loadManifest().then(async (m) => {
      await sys.applyPack(m);
      if (alive) setPack(m ? { state: 'ready', id: m.packId } : { state: 'none' });
    });
    const timer = setInterval(bump, 250);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
    };
  }, [sys, loadManifest]);

  const e = sys.engine;
  const d = sys.director;
  const maps = d.currentMaps;
  const snap = e.musicSnapshot();
  const playSfx = (k: string) => e.playSfx(k);
  const speak = (k: string) => void e.speak({ key: k, speaker: 'lab', policy: 'interrupt' });
  const setVol = (k: keyof AudioMix, v: number | boolean) => {
    const next = { ...mix, [k]: v };
    setMix(next);
    e.setMix(next);
  };
  const toggleScene = (s: MusicScene) => {
    const key = d.currentMaps.musicMap?.scenes[s]?.key;
    if (!key) return;
    const tok = scenes.current.get(s);
    if (tok !== undefined) {
      e.popScene(tok);
      scenes.current.delete(s);
    } else {
      scenes.current.set(s, e.pushScene(key, { noResume: NO_RESUME_SCENES.has(s) }));
    }
    bump();
  };
  const cv = maps.voiceMap?.characters[char];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="audio-lab">
      <header style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>音频试听</h1>
        <Link href="/">首页</Link>
        <span data-testid="audio-state">引擎：{e.state}</span>
        <span data-testid="audio-pack">
          素材包：{pack.state === 'loading' ? '加载中…' : pack.state === 'ready' ? pack.id : '无（只有 ZzFX 回退）'}
        </span>
        <span>格式：{e.formatPreference.join(' > ')}</span>
        <button type="button" className="btn btn--sm btn--blue" onClick={() => void e.unlock()}>
          解锁音频
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            e.stopVoice();
            for (const t of scenes.current.values()) e.popScene(t);
            scenes.current.clear();
          }}
        >
          停止语音与场景曲
        </button>
      </header>
      {sys.packIssues.length > 0 && (
        <ul role="alert">
          {sys.packIssues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
      <section style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {(['master', 'bgm', 'sfx', 'voice', 'ui'] as const).map((k) => (
          <label key={k} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {k}
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(mix[k] * 100)}
              onChange={(ev) => setVol(k, Number(ev.target.value) / 100)}
            />
          </label>
        ))}
        <label>
          <input type="checkbox" checked={mix.muted} onChange={(ev) => setVol('muted', ev.target.checked)} /> 静音
        </label>
        <label>
          <input
            type="checkbox"
            checked={mix.voiceEnabled}
            onChange={(ev) => setVol('voiceEnabled', ev.target.checked)}
          />{' '}
          角色语音
        </label>
        <label>
          <input
            type="checkbox"
            checked={d.options.guessOriginal}
            onChange={(ev) => {
              d.setOptions({ guessOriginal: ev.target.checked });
              bump();
            }}
            data-testid="audio-guess-original"
          />{' '}
          guess 音效也用原版
        </label>
      </section>
      <nav style={{ display: 'flex', gap: 6 }}>
        {(
          [
            ['music', '音乐'],
            ['sfx', '音效'],
            ['voice', '语音'],
            ['events', '事件映射'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`btn btn--sm${tab === k ? ' btn--blue' : ''}`}
            onClick={() => setTab(k)}
            data-testid={`audio-tab-${k}`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'music' && (
        <section data-testid="audio-music">
          <p>
            当前：
            {snap
              ? `${snap.mode} ${snap.key ?? ''} @ ${snap.positionSec?.toFixed(2) ?? '—'} s；栈 [${snap.layers.join(', ')}]`
              : '—'}
          </p>
          <h2 style={{ fontSize: 18 }}>棋盘轮播</h2>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setBoard(!board);
              e.setBoardActive(!board);
            }}
          >
            {board ? '停止棋盘曲' : '播放棋盘曲'}
          </button>
          <ol>
            {(maps.musicMap?.board ?? []).map((t) => (
              <li key={t.key}>
                {t.key}（track{t.track ?? '—'}）<Conf c={t.confidence} />
              </li>
            ))}
          </ol>
          <h2 style={{ fontSize: 18 }}>场景曲（进入时压栈，离开后棋盘曲从断点续播；noResume 除外）</h2>
          <table style={table}>
            <tbody>
              {MUSIC_SCENES.map((s) => {
                const ref = maps.musicMap?.scenes[s];
                return (
                  <tr key={s} data-scene={s}>
                    <td style={cell}>{s}</td>
                    <td style={cell}>{ref?.key ?? '（无）'}</td>
                    <td style={cell}>{ref?.track ?? '—'}</td>
                    <td style={cell}>
                      <Conf c={ref?.confidence} />
                    </td>
                    <td style={cell}>{NO_RESUME_SCENES.has(s) ? 'noResume' : ''}</td>
                    <td style={cell}>
                      <button type="button" className="btn btn--sm" disabled={!ref} onClick={() => toggleScene(s)}>
                        {scenes.current.has(s) ? '离开' : '进入'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'sfx' && (
        <section data-testid="audio-sfx">
          <h2 style={{ fontSize: 18 }}>ZzFX 预设（程序化回退）</h2>
          <div>
            {ZZFX_PRESET_IDS.map((p) => (
              <PlayKey key={p} k={zzfxKey(p)} label={p} onPlay={playSfx} />
            ))}
          </div>
          <h2 style={{ fontSize: 18 }}>素材包音效集（cue.* 为语义用途；guess 默认走 ZzFX）</h2>
          {maps.sfxSets ? (
            <table style={table}>
              <tbody>
                {Object.keys(maps.sfxSets.sets)
                  .sort()
                  .map((name) => {
                    const set = maps.sfxSets!.sets[name]!;
                    return (
                      <tr key={name}>
                        <td style={cell}>{name}</td>
                        <td style={cell}>
                          <Conf c={set.confidence} />
                        </td>
                        <td style={cell}>
                          {set.sfx.map((k) => (
                            <PlayKey key={k} k={k} onPlay={playSfx} />
                          ))}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          ) : (
            <p>（没有音效集表）</p>
          )}
        </section>
      )}

      {tab === 'voice' && (
        <section data-testid="audio-voice">
          <label>
            角色{' '}
            <select className="select" value={char} onChange={(ev) => setChar(Number(ev.target.value) as CharacterId)}>
              {Array.from({ length: CHARACTER_COUNT }, (_, c) => (
                <option key={CHARACTER_KEYS[c as CharacterId]} value={c}>
                  {c} {CHARACTER_KEYS[c as CharacterId]}
                </option>
              ))}
            </select>
          </label>
          {cv ? (
            <>
              <h2 style={{ fontSize: 18 }}>事件槽（27）</h2>
              <table style={table}>
                <tbody>
                  {VOICE_SLOTS.map((s, i) => (
                    <tr key={s}>
                      <td style={cell}>{i}</td>
                      <td style={cell}>{s}</td>
                      <td style={cell}>
                        <Lines lines={cv.slots[i]} onPlay={speak} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h2 style={{ fontSize: 18 }}>道具台词（道具号 1..13）与路面反应</h2>
              <table style={table}>
                <tbody>
                  {cv.itemLines.map((l, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 下标即道具号
                    <tr key={i}>
                      <td style={cell}>item {i + 1}</td>
                      <td style={cell}>
                        <Lines lines={l} onPlay={speak} />
                      </td>
                    </tr>
                  ))}
                  {VOICE_ITEM_REACTIONS.map((r) => (
                    <tr key={r}>
                      <td style={cell}>{r}</td>
                      <td style={cell}>
                        <Lines lines={cv.itemReactions[r]} onPlay={speak} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h2 style={{ fontSize: 18 }}>卡片台词（卡号 1..30）</h2>
              <table style={table}>
                <tbody>
                  {cv.cardLines.use.map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 下标即卡号
                    <tr key={i}>
                      <td style={cell}>card {i + 1}</td>
                      {VOICE_CARD_MODES.map((m) => (
                        <td key={m} style={cell}>
                          {m}: <Lines lines={cv.cardLines[m][i]} onPlay={speak} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p>（没有语音表）</p>
          )}
          {maps.voiceMap && (
            <>
              <h2 style={{ fontSize: 18 }}>NPC</h2>
              <table style={table}>
                <tbody>
                  {Object.keys(maps.voiceMap.npc)
                    .sort()
                    .map((k) => (
                      <tr key={k}>
                        <td style={cell}>{k}</td>
                        <td style={cell}>
                          <Lines lines={maps.voiceMap!.npc[k]} onPlay={speak} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              <h2 style={{ fontSize: 18 }}>新闻与命运播报</h2>
              <div>
                {Object.keys(maps.voiceMap.news)
                  .sort()
                  .map((k) => (
                    <span key={k} style={{ display: 'inline-block', marginRight: 8 }}>
                      {k}: <Lines lines={maps.voiceMap!.news[k]} onPlay={speak} />
                    </span>
                  ))}
              </div>
            </>
          )}
        </section>
      )}

      {tab === 'events' && (
        <section data-testid="audio-events">
          <p>「按事件」表示音效或场景由事件载荷决定（例如交通工具、金额分档）；语音列表示该事件可能触发语音。</p>
          <table style={table}>
            <tbody>
              {GAME_EVENT_TYPES.map((t) => {
                const spec = SOUND_MAP[t] as { sfx?: unknown; voice?: unknown; scene?: unknown };
                const sfx = spec.sfx;
                const cue = typeof sfx === 'object' && sfx !== null ? (sfx as { cue?: string; zzfx?: string }) : null;
                const set = cue?.cue ? maps.sfxSets?.sets[`cue.${cue.cue}`] : undefined;
                const scene = spec.scene;
                return (
                  <tr key={t} data-event={t}>
                    <td style={cell}>{t}</td>
                    <td style={cell}>
                      {typeof sfx === 'function'
                        ? '按事件'
                        : cue
                          ? `${cue.cue ? `cue.${cue.cue}` : ''} ${cue.zzfx ?? ''}`
                          : ''}
                      {set && (
                        <>
                          {' '}
                          <Conf c={set.confidence} />
                          {set.sfx.map((k) => (
                            <PlayKey key={k} k={k} onPlay={playSfx} />
                          ))}
                        </>
                      )}
                      {cue?.zzfx && (
                        <PlayKey k={zzfxKey(cue.zzfx as never)} label={`zzfx.${cue.zzfx}`} onPlay={playSfx} />
                      )}
                    </td>
                    <td style={cell}>{spec.voice ? '语音' : ''}</td>
                    <td style={cell}>
                      {typeof scene === 'function' ? '按事件' : scene ? (scene as { scene: string }).scene : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

/**
 * /dev/audio 路由页：素材包经 skinStore 发现（PackClient 读 manifest；门禁开启而未通过时弹门禁页，通过后自动重新发现），
 * 判定完成后按 packId 建一套试听用的音频系统（素材包变化时整体重建）。
 */
export default function AudioLabPage(): ReactNode {
  const pack = useSkinStore((s) => s.pack);
  useEffect(() => {
    void useSkinStore.getState().ensurePack();
  }, []);
  const manifest = pack.status === 'ready' ? pack.manifest : null;
  const load = useCallback(() => Promise.resolve(manifest), [manifest]);
  if (pack.status === 'idle' || pack.status === 'loading') {
    return (
      <div style={{ padding: 12 }} role="status" data-testid="audio-lab-loading">
        正在检查原版素材包…
      </div>
    );
  }
  return <AudioLab key={manifest?.packId ?? 'none'} loadManifest={load} />;
}
