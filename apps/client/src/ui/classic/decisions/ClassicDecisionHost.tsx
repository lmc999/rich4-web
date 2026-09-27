// 原版皮肤的决策宿主（original-skin.md §4.2）：优先用原版决策注册表里的场景，未登记、没有素材包、
// 场景依赖的素材逻辑键（模块导出的 requiredKeys）不可用、准备超时或场景渲染出错 → 整体回退到 ui/decisions 的 DecisionHost
// （程序化对话框；它自己再兜底 GenericChoice）。判定按决策（decisionId）做一次，定了就不在同一个决策里来回切换。
// 模块已加载且精灵已在仓库里时同步判定（重发的决策、预取过的场景不闪加载态）。
import { Component, type ErrorInfo, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PackClient } from '../../../skin/pack/PackClient';
import { currentPackClient } from '../../../skin/skinStore';
import { DecisionHost } from '../../decisions/DecisionHost';
import type { DecisionProps } from '../../decisions/types';
import { prepareSceneKeys, sceneKeysStatus } from '../common/sceneAssets';
import { classicDecisionRegistry, getClassicScene } from './registry';
import { type ClassicDecisionRegistry, type ClassicSceneComponent, resolveRequiredKeys, sceneLoader } from './scene';

/** 素材准备的最长等待：超过就整体回退（决策倒计时在走，不能一直等） */
export const SCENE_PREPARE_TIMEOUT_MS = 4000;

export type SceneGateState = 'pending' | 'classic' | 'fallback';

export interface ClassicDecisionHostProps extends DecisionProps {
  /** 原版皮肤判定的素材包（null → 全部回退） */
  packId: string | null;
  /** 测试注入：素材包客户端（缺省取当前的） */
  client?: PackClient | null;
  /** 测试注入：注册表 */
  registry?: ClassicDecisionRegistry;
  prepareTimeoutMs?: number;
  /** 判定结果（测试、诊断） */
  onGate?: (state: SceneGateState, reason: string | null) => void;
}

interface Gate {
  id: string;
  state: SceneGateState;
  reason: string | null;
}

/** 同步判定：能定下来就给出 classic / fallback，否则 pending（要异步加载模块或精灵） */
export function gateSync(
  C: ClassicSceneComponent | null,
  props: DecisionProps,
  client: PackClient | null,
  packId: string | null,
): { state: SceneGateState; reason: string | null } {
  if (!C) return { state: 'fallback', reason: 'unregistered' };
  if (!packId || !client) return { state: 'fallback', reason: 'no-pack' };
  const loader = sceneLoader(C);
  if (loader && !loader.loaded) return { state: 'pending', reason: 'module' };
  const keys = loader?.loaded ? resolveRequiredKeys(loader.loaded, props) : [];
  const st = sceneKeysStatus(keys, client);
  if (st === 'missing') return { state: 'fallback', reason: 'keys' };
  if (st === 'loading') return { state: 'pending', reason: 'sprites' };
  return { state: 'classic', reason: null };
}

class SceneBoundary extends Component<
  { resetKey: string; fallback: ReactNode; children: ReactNode },
  { error: boolean; key: string }
> {
  override state = { error: false, key: this.props.resetKey };

  static getDerivedStateFromError(): { error: boolean } {
    return { error: true };
  }

  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { error: boolean; key: string },
  ): { error: boolean; key: string } | null {
    return props.resetKey === state.key ? null : { error: false, key: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[classic] 原版场景渲染失败，改用程序化对话框', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

function ScenePending(): ReactNode {
  const { t } = useTranslation();
  return (
    <p role="status" data-testid="classic-scene-pending" style={{ margin: 0, color: '#fff', fontSize: 12 }}>
      {t('common.loading')}
    </p>
  );
}

export function ClassicDecisionHost({
  packId,
  client: clientProp,
  registry = classicDecisionRegistry,
  prepareTimeoutMs = SCENE_PREPARE_TIMEOUT_MS,
  onGate,
  ...props
}: ClassicDecisionHostProps): ReactNode {
  const { decision } = props;
  const C = getClassicScene(decision.kind, registry);
  const client = clientProp === undefined ? currentPackClient() : clientProp;
  const id = decision.decisionId;
  const [final, setFinal] = useState<Gate | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const gate: Gate = final && final.id === id ? final : { id, ...gateSync(C, props, client, packId) };

  // 异步准备：加载模块 → 解出 requiredKeys → 载入精灵；超时整体回退
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每个决策只判定一次
  useEffect(() => {
    if (gate.state !== 'pending' || !C) return;
    let live = true;
    const done = (state: SceneGateState, reason: string | null): void => {
      if (!live) return;
      live = false;
      setFinal({ id, state, reason });
    };
    const timer = setTimeout(() => done('fallback', 'timeout'), prepareTimeoutMs);
    (async () => {
      const loader = sceneLoader(C);
      const mod = loader ? await loader.load() : null;
      const keys = mod ? resolveRequiredKeys(mod, propsRef.current) : [];
      const ok = await prepareSceneKeys(keys, client);
      done(ok ? 'classic' : 'fallback', ok ? null : 'keys');
    })().catch((e: unknown) => {
      console.warn('[classic] 原版场景准备失败，改用程序化对话框', e);
      done('fallback', 'error');
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, gate.state]);

  // 判定定下来时锁定（同一决策里不再来回切换）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在判定变化时记录一次
  useEffect(() => {
    if (gate.state === 'pending') return;
    if (!final || final.id !== id) setFinal(gate);
    onGate?.(gate.state, gate.reason);
  }, [id, gate.state]);

  if (gate.state === 'fallback') return <DecisionHost {...props} />;
  if (gate.state === 'pending' || !C) return <ScenePending />;
  const Scene = sceneLoader(C)?.loaded?.default ?? C;
  return (
    <SceneBoundary resetKey={id} fallback={<DecisionHost {...props} />}>
      <Suspense fallback={<ScenePending />}>
        <Scene key={`${decision.seat}:${decision.kind}`} {...props} />
      </Suspense>
    </SceneBoundary>
  );
}
