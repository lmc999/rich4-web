// /dev/gallery：美术画廊。建筑各等级（Pixi）、12 角色各姿势（SVG，正/背两向 + 镜像）、头像、神明占位图。
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'wouter';
import { CHARACTERS, GOD_LOOKS } from '../game/procedural/character/defs';
import { FACINGS, POSES } from '../game/procedural/character/rig';
import { characterSvg, godPlaceholderSvg, portraitSvg, svgDataUrl } from '../game/procedural/character/svg';
import styles from './Gallery.module.css';
import { type GalleryHandle, mountBuildingGallery } from './galleryScene';
import { exposeRenderer } from './testHooks';

const ATLAS_KEYS = ['sunXiaomei', 'johnJoe'] as const;
const PORTRAIT_EXPRS = ['normal', 'happy', 'sad', 'shock'] as const;

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
  const gods = useMemo(() => GOD_LOOKS.map((g) => ({ g, url: svgDataUrl(godPlaceholderSvg(g)) })), []);
  const nameOf = (key: string): string => (t as unknown as (k: string) => string)(`characters:${key}.name`);
  const tagOf = (key: string): string => (t as unknown as (k: string) => string)(`characters:${key}.tag`);
  const godName = (key: string): string => (t as unknown as (k: string) => string)(`gods:${key}.name`);

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

      <section className={`panel ${styles.section}`}>
        <h2>{t('dev.gallery.gods')}</h2>
        <div className={styles.grid}>
          {gods.map(({ g, url }) => (
            <figure key={g.key} className={styles.figure}>
              <img src={url} alt={g.key} width={96} height={120} />
              <figcaption>{godName(g.key)}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </main>
  );
}
