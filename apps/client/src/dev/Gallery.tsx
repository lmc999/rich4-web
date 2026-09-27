// /dev/gallery：美术画廊。建筑各等级（Pixi）、12 角色各姿势（SVG，正/背两向 + 镜像）、头像、
// 神明 / 四大恶人 / NPC 造型（M6/M7，复用角色 rig），以及路面物件与特效的 Pixi 预览（BoardStage）。
import { GOD_KEYS, type GodKind, VILLAIN_KINDS } from '@rich4/shared/engine';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { figureSvg, godSvg, NPC_IDS } from '../game/actors/figures';
import type { StagePreviewHandle } from '../game/fx/stagePreview';
import { CHARACTERS } from '../game/procedural/character/defs';
import { FACINGS, POSES, type Pose } from '../game/procedural/character/rig';
import { characterSvg, portraitSvg, svgDataUrl } from '../game/procedural/character/svg';
import { PopupPreview } from '../ui/popups/PopupPreview';
import styles from './Gallery.module.css';
import { type GalleryHandle, mountBuildingGallery } from './galleryScene';
import { exposeRenderer } from './testHooks';

const ATLAS_KEYS = ['sunXiaomei', 'johnJoe'] as const;
const PORTRAIT_EXPRS = ['normal', 'happy', 'sad', 'shock'] as const;
const GOD_POSES: readonly Pose[] = ['idle0', 'cheer'];
const VILLAIN_POSES: readonly Pose[] = ['idle0', 'walk0', 'walk2', 'cheer', 'hurt', 'sad'];
const NPC_POSES: readonly Pose[] = ['idle0', 'cast'];

/** 路面物件与特效的 Pixi 预览（BoardStage 循环播放特效） */
function StagePreview(): ReactNode {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<StagePreviewHandle | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    import('../game/fx/stagePreview')
      .then((m) => m.mountStagePreview(el))
      .then(
        (h) => {
          if (cancelled) {
            h.destroy();
            return;
          }
          handle.current = h;
          setState('ready');
        },
        (e: unknown) => {
          console.error('[gallery stage]', e);
          if (!cancelled) setState('error');
        },
      );
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
  }, []);
  return (
    <>
      {state === 'loading' && <p role="status">{t('common.loading')}</p>}
      {state === 'error' && <p role="alert">{t('common.error')}</p>}
      <button type="button" className="btn btn--sm btn--blue" onClick={() => handle.current?.next()}>
        ▶
      </button>
      <div
        ref={host}
        style={{ position: 'relative', height: 460, marginTop: 8 }}
        data-testid="gallery-stage"
        data-state={state}
      />
    </>
  );
}

export default function Gallery(): ReactNode {
  const { t } = useTranslation();
  const pixiHost = useRef<HTMLDivElement>(null);
  const [mirror, setMirror] = useState(true);
  const [pixiState, setPixiState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const host = pixiHost.current;
    if (!host) return;
    let cancelled = false;
    let handle: GalleryHandle | null = null;
    mountBuildingGallery(host, ATLAS_KEYS).then(
      (h) => {
        if (cancelled) {
          h.destroy();
          return;
        }
        handle = h;
        setPixiState('ready');
      },
      (e: unknown) => {
        console.error('[gallery]', e);
        if (!cancelled) setPixiState('error');
      },
    );
    exposeRenderer(null);
    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, []);

  // SVG 生成是纯函数，按角色缓存 data URL
  const sheets = useMemo(
    () =>
      CHARACTERS.map((c) => ({
        c,
        frames: FACINGS.map((facing) => ({
          facing,
          poses: POSES.map((pose) => ({ pose, url: svgDataUrl(characterSvg(c, pose, facing)) })),
        })),
        portraits: PORTRAIT_EXPRS.map((e) => ({ e, url: svgDataUrl(portraitSvg(c, e)) })),
      })),
    [],
  );
  const gods = useMemo(
    () =>
      (Object.keys(GOD_KEYS).map(Number) as GodKind[]).map((kind) => ({
        key: GOD_KEYS[kind],
        urls: GOD_POSES.map((pose) => ({ pose, url: svgDataUrl(godSvg(kind, pose)) })),
      })),
    [],
  );
  const villains = useMemo(
    () =>
      VILLAIN_KINDS.map((kind) => ({
        kind,
        urls: [
          ...VILLAIN_POSES.map((pose) => ({
            key: `${pose}/front`,
            url: svgDataUrl(figureSvg(`villain:${kind}`, pose)),
          })),
          { key: 'idle0/back', url: svgDataUrl(figureSvg(`villain:${kind}`, 'idle0', 'back')) },
        ],
      })),
    [],
  );
  const npcs = useMemo(
    () =>
      NPC_IDS.map((id) => ({
        id,
        urls: NPC_POSES.map((pose) => ({ pose, url: svgDataUrl(figureSvg(`npc:${id}`, pose)) })),
      })),
    [],
  );
  const nameOf = (key: string): string => (t as unknown as (k: string) => string)(`characters:${key}.name`);
  const tagOf = (key: string): string => (t as unknown as (k: string) => string)(`characters:${key}.tag`);
  const godName = (key: string): string => (t as unknown as (k: string) => string)(`gods:${key}.name`);
  const tt = t as unknown as (k: string) => string;

  return (
    <main className={styles.page} data-testid="dev-gallery">
      <header className={`panel ${styles.header}`}>
        <h1>{t('dev.gallery.title')}</h1>
        <label>
          <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />{' '}
          {t('dev.gallery.mirrored')}
        </label>
        <Link href="/dev/map" className="btn btn--sm btn--blue">
          {t('nav.devMap')}
        </Link>
        <Link href="/" className="btn btn--sm btn--cream">
          {t('common.back')}
        </Link>
      </header>

      <section className={`panel ${styles.section}`}>
        <h2>{t('dev.gallery.buildings')}</h2>
        {pixiState === 'loading' && <p role="status">{t('common.loading')}</p>}
        {pixiState === 'error' && <p role="alert">{t('common.error')}</p>}
        <div ref={pixiHost} className={styles.pixi} data-testid="gallery-pixi" data-state={pixiState} />
      </section>

      <section className={`panel ${styles.section}`}>
        <h2>{t('dev.gallery.characters')}</h2>
        <div className={styles.poseHeader}>
          <span />
          {POSES.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
        {sheets.map(({ c, frames }) => (
          <div key={c.key} className={styles.character} data-testid={`char-${c.key}`}>
            <div className={styles.charName}>
              <strong>{nameOf(c.key)}</strong>
              <small>{tagOf(c.key)}</small>
              <i style={{ background: c.color }} />
            </div>
            {frames.map(({ facing, poses }) => (
              <div key={facing} className={styles.poseRow}>
                <span className={styles.facing}>
                  {t(facing === 'front' ? 'dev.gallery.front' : 'dev.gallery.back')}
                </span>
                {poses.map(({ pose, url }) => (
                  <img key={pose} src={url} alt={`${c.key} ${pose} ${facing}`} width={64} height={80} />
                ))}
              </div>
            ))}
            {mirror && (
              <div className={styles.poseRow}>
                <span className={styles.facing}>{t('dev.gallery.mirrored')}</span>
                {frames[0]!.poses.map(({ pose, url }) => (
                  <img key={pose} src={url} alt="" width={64} height={80} className={styles.mirror} />
                ))}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className={`panel ${styles.section}`}>
        <h2>{t('dev.gallery.portraits')}</h2>
        <div className={styles.grid}>
          {sheets.map(({ c, portraits }) => (
            <figure key={c.key} className={styles.figure}>
              <div className={styles.portraits}>
                {portraits.map(({ e, url }) => (
                  <img key={e} src={url} alt={`${c.key} ${e}`} width={72} height={72} />
                ))}
              </div>
              <figcaption>{nameOf(c.key)}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className={`panel ${styles.section}`} data-testid="gallery-gods">
        <h2>{tt('gods:gallery.gods')}</h2>
        <div className={styles.grid}>
          {gods.map(({ key, urls }) => (
            <figure key={key} className={styles.figure}>
              <div className={styles.portraits}>
                {urls.map(({ pose, url }) => (
                  <img key={pose} src={url} alt={`${key} ${pose}`} width={96} height={120} />
                ))}
              </div>
              <figcaption>{godName(key)}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className={`panel ${styles.section}`} data-testid="gallery-villains">
        <h2>{tt('gods:gallery.villains')}</h2>
        {villains.map(({ kind, urls }) => (
          <div key={kind} className={styles.poseRow}>
            <span className={styles.facing}>{tt(`events:villain.${kind}`)}</span>
            {urls.map(({ key, url }) => (
              <img key={key} src={url} alt={`${kind} ${key}`} width={64} height={80} />
            ))}
          </div>
        ))}
      </section>

      <section className={`panel ${styles.section}`} data-testid="gallery-npcs">
        <h2>{tt('gods:gallery.npcs')}</h2>
        <div className={styles.grid}>
          {npcs.map(({ id, urls }) => (
            <figure key={id} className={styles.figure}>
              <div className={styles.portraits}>
                {urls.map(({ pose, url }) => (
                  <img key={pose} src={url} alt={`${id} ${pose}`} width={80} height={100} />
                ))}
              </div>
              <figcaption>{tt(`gods:npc.${id}`)}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className={`panel ${styles.section}`}>
        <h2>{tt('gods:gallery.stage')}</h2>
        <StagePreview />
      </section>

      <section className={`panel ${styles.section}`}>
        <h2>{tt('gods:gallery.popups')}</h2>
        <PopupPreview />
      </section>
    </main>
  );
}
