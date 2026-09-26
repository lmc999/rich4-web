// 兜底对话框（architecture §5.4「未知的 kind 由 GenericChoice 兜底」）：
// 按 ALLOWED_INTENTS 渲染无参数的选项按钮，外加「按默认处理」（defaultIntent，引擎保证合法），保证流程不会卡死。
import { ALLOWED_INTENTS, type IntentType, isDecisionKind, type PlayerIntent } from '@rich4/shared/engine';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import type { LooseT } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

/** 不带参数、可以直接提交的 intent */
const BARE_INTENTS: readonly IntentType[] = [
  'CONFIRM',
  'DECLINE',
  'SKIP',
  'LEAVE',
  'PASS',
  'QUIT',
  'MINIGAME_DECLINE',
  'ROLL',
];

export function bareIntentsOf(kind: string): IntentType[] {
  if (!isDecisionKind(kind)) return [];
  return (ALLOWED_INTENTS[kind] as readonly IntentType[]).filter((x) => BARE_INTENTS.includes(x));
}

export default function GenericChoice(props: DecisionProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { decision } = props;
  const ctl = useDecision(props);
  const known = isDecisionKind(decision.kind);
  useEffect(() => {
    if (import.meta.env.DEV && !known) console.warn(`[decision] 未知决策 ${String(decision.kind)}，使用 GenericChoice`);
  }, [known, decision.kind]);
  const bare = bareIntentsOf(decision.kind);
  const kindName = known ? lt(`dlg.kind.${decision.kind}`) : String(decision.kind);
  return (
    <DecisionFrame
      ctl={ctl}
      kind={decision.kind}
      seat={decision.seat}
      view={props.view}
      isMine={props.isMine}
      title={kindName}
      icon="❔"
      tone="blue"
      size="sm"
      actions={
        <>
          {bare.map((type) => (
            <Button
              key={type}
              variant="cream"
              data-testid={`generic-${type}`}
              onClick={() => ctl.send({ type } as PlayerIntent)}
            >
              {lt(`dlg.intent.${type}`)}
            </Button>
          ))}
          <Button data-testid="generic-default" onClick={() => ctl.send(decision.defaultIntent)}>
            {t('dlg.generic.default')}
          </Button>
        </>
      }
    >
      <p className={s.note}>{t('dlg.generic.body')}</p>
    </DecisionFrame>
  );
}
