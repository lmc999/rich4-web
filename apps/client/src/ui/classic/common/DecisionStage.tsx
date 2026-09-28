// 决策场景的外壳：Stage4x3 + 决策控制器（ui/decisions 的 useDecision）的状态——与程序化对话框的 DecisionFrame 同一套
// data-testid（decision-<KIND>）与状态属性（data-kind / data-locked / data-expired / data-readonly），E2E 两种皮肤共用；
// 状态条：非本人「等待 X 做决定…」、已提交「已提交，等待服务器确认…」、超时「时间到，将按默认选项处理」；倒计时圆环在右上角。
import type { MapIndex } from '@rich4/shared/data';
import type { DecisionForYou, GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameText } from '../../components/names';
import type { DecisionController } from '../../decisions/useDecision';
import { type SceneBackdrop, type SceneStatusTone, Stage4x3, type Stage4x3Props } from './Stage4x3';

export interface DecisionStageProps
  extends Pick<
    Stage4x3Props,
    | 'initialFocus'
    | 'className'
    | 'onKeyDown'
    | 'closeButton'
    | 'closeTestId'
    | 'scale'
    | 'countdownAt'
    | 'countdownBadgeAt'
  > {
  ctl: DecisionController;
  decision: Pick<DecisionForYou, 'kind' | 'seat' | 'decisionId'>;
  view: GameView;
  map?: MapIndex | null;
  isMine: boolean;
  /** 场景名称（读屏） */
  label: string;
  children?: ReactNode;
  /** Esc / 关闭钮（通常是「放弃 / 离开」对应的 intent） */
  onClose?: () => void;
  backdrop?: SceneBackdrop;
  /** 附加属性 */
  attrs?: Stage4x3Props['attrs'];
}

export function DecisionStage({
  ctl,
  decision,
  view,
  map = null,
  isMine,
  label,
  children,
  onClose,
  backdrop = 'none',
  attrs,
  ...rest
}: DecisionStageProps): ReactNode {
  const { t } = useTranslation();
  const text = useGameText(view, map);
  let status: string | null = null;
  let tone: SceneStatusTone = 'info';
  if (!isMine) {
    status = t('dlg.common.waiting', { name: text.player(decision.seat) });
    tone = 'wait';
  } else if (ctl.locked) {
    status = t('dlg.common.sent');
    tone = 'sent';
  } else if (ctl.expired) {
    status = t('dlg.common.expired');
    tone = 'expired';
  }
  return (
    <Stage4x3
      testId={`decision-${decision.kind}`}
      label={label}
      readOnly={!isMine}
      interactive={ctl.interactive}
      status={status}
      statusTone={tone}
      countdown={{ remainingMs: ctl.remainingMs, totalMs: ctl.totalMs }}
      onClose={onClose}
      closeLabel={t('cmp.close')}
      backdrop={backdrop}
      attrs={{
        'data-kind': decision.kind,
        'data-decision-id': decision.decisionId,
        'data-locked': ctl.locked ? 'true' : 'false',
        'data-expired': ctl.expired ? 'true' : 'false',
        ...attrs,
      }}
      {...rest}
    >
      {children}
    </Stage4x3>
  );
}
