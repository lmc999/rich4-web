// 通用组件与文案完整性（client-dom）
import {
  CARD,
  CARD_KEYS,
  type Counters2,
  DECISION_KINDS,
  FACILITY_TYPES,
  GOD_KEYS,
  ITEM,
  ITEM_KEYS,
  MAGIC_CONDITION_IDS,
  MAGIC_EFFECT_IDS,
  MINIGAME_IDS,
  type PassiveContext,
  type ReasonKey,
  type RoadObjectKind,
  type Vehicle,
  VILLAIN_KINDS,
} from '@rich4/shared/engine';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { bareIntentsOf } from '../decisions/GenericChoice';
import { AmountSlider } from './AmountSlider';
import { BuildingPreview, previewSpec } from './BuildingPreview';
import { CardTile, ItemTile } from './CardTile';
import { CARD_CATEGORY, CATEGORY_COLOR } from './cardVisuals';
import { Modal } from './Modal';
import { Money } from './Money';
import { makeGameText } from './names';
import { Stepper } from './Stepper';

const REASONS = {
  noTarget: true,
  passive: true,
  marketClosed: true,
  suspended: true,
  limitUp: true,
  limitDown: true,
  tortoise: true,
  sleepwalk: true,
  investBlocked: true,
  notEnoughCash: true,
  notEnoughPoints: true,
  handFull: true,
  itemFull: true,
  poolEmpty: true,
  noAnchor: true,
  humanOnly: true,
  alreadyEquipped: true,
  nothingToDispel: true,
  menuLimit: true,
  notYourTurn: true,
} as const satisfies Record<ReasonKey, true>;

const STATUS = {
  hotel: true,
  away: true,
  jail: true,
  hospital: true,
  hibernate: true,
  sleepwalk: true,
  stay: true,
  tortoise: true,
} as const satisfies Record<keyof Counters2, true>;

const VEHICLES = { walk: true, moto: true, car: true, engineer: true } as const satisfies Record<Vehicle, true>;
const OBJECTS = { roadblock: true, mine: true, bomb: true, gift: true, chest: true } as const satisfies Record<
  RoadObjectKind,
  true
>;
const PASSIVE = {
  toll: true,
  fee: true,
  taxAudit: true,
  fine: true,
  frame: true,
  sleepwalk: true,
  confine: true,
} as const satisfies Record<PassiveContext, true>;

describe('文案完整性（动态键）', () => {
  const has = (k: string): void => {
    expect(i18next.exists(k), k).toBe(true);
  };

  it('卡片、道具、神明、恶人、魔法屋、小游戏', () => {
    for (const key of Object.values(CARD_KEYS)) {
      has(`cards:${key}.name`);
      has(`cards:${key}.desc`);
    }
    for (const key of Object.values(ITEM_KEYS)) {
      has(`items:${key}.name`);
      has(`items:${key}.desc`);
    }
    for (const key of Object.values(GOD_KEYS)) has(`gods:${key}.name`);
    for (const v of VILLAIN_KINDS) {
      has(`events:villain.${v}`);
      has(`ui:dlg.bail.villainDesc.${v}`);
    }
    for (const id of MAGIC_CONDITION_IDS) has(`magic:condition.${id}`);
    for (const id of MAGIC_EFFECT_IDS) {
      has(`magic:effect.${id}.name`);
      has(`magic:effect.${id}.desc`);
    }
    for (const id of MINIGAME_IDS) {
      has(`minigames:${id}.name`);
      has(`minigames:${id}.howTo`);
    }
  });

  it('原因、状态、交通工具、路面物件、被动卡场景', () => {
    for (const k of Object.keys(REASONS)) has(`game:reason.${k}`);
    for (const k of Object.keys(STATUS)) has(`game:status.${k}`);
    for (const k of Object.keys(VEHICLES)) has(`game:vehicle.${k}`);
    for (const k of Object.keys(OBJECTS)) has(`game:object.${k}`);
    for (const k of Object.keys(PASSIVE)) has(`ui:dlg.passive.ctx.${k}`);
    for (const k of ['frame', 'sleepwalk', 'confine']) has(`ui:dlg.passive.ctxDays.${k}`);
  });

  it('决策名、通用选项、设施说明、银行与股市的枚举文案', () => {
    for (const k of DECISION_KINDS) {
      has(`ui:dlg.kind.${k}`);
      for (const type of bareIntentsOf(k)) has(`ui:dlg.intent.${type}`);
    }
    for (const f of FACILITY_TYPES) {
      has(`ui:dlg.facility.desc.${f}`);
      has(`tiles:facility.${f}`);
    }
    for (const k of ['bankRun', 'rejected', 'sunday']) has(`ui:dlg.bank.loanBlocked.${k}`);
    for (const k of ['loan', 'repay', 'finance']) {
      has(`ui:dlg.bank.do.${k}`);
      has(`ui:dlg.bank.hint.${k}`);
    }
    for (const k of ['stay', 'tortoise', 'sleepwalk']) has(`ui:dlg.turn.locked.${k}`);
    for (const k of ['sunday', 'holiday', 'halted']) has(`ui:pnl.stock.closed.${k}`);
    for (const k of ['bankrupt', 'surrender']) has(`ui:pnl.player.out.${k}`);
  });

  it('makeGameText：名字与地块编号（同名地块追加序号）', async () => {
    const { fixture } = await import('../decisions/testing');
    const fx = fixture();
    const text = makeGameText(i18next.t as never, fx.view, fx.map);
    expect(text.card(CARD.TORTOISE)).toBe('乌龟卡');
    expect(text.item(ITEM.NUKE)).toBe('核子飞弹');
    expect(text.player(1)).toBe('阿土伯');
    expect(text.lot('L2')).toBe('测试大道 2');
    expect(text.lot('F1')).toBe('湖畔广场');
    expect(text.stock(0)).toBe('测试银行');
    expect(text.tile(8)).toBe('乐透 #8');
    expect(text.actor({ t: 'villain', kind: 'spy' })).toBe('间谍');
    expect(text.reason(null)).toBe('');
  });
});

describe('CardTile / ItemTile', () => {
  it('卡框按类别配色；不可用时置灰并显示原因', () => {
    render(
      <CardTile card={CARD.DEVIL} name="恶魔卡" price={180} disabled reason="神明作祟" onClick={vi.fn()} testId="t" />,
    );
    const tile = screen.getByTestId('t');
    expect(tile).toBeDisabled();
    expect(tile).toHaveTextContent('神明作祟');
    expect(tile).toHaveTextContent('180');
    expect(tile.getAttribute('style')).toContain(CATEGORY_COLOR[CARD_CATEGORY[CARD.DEVIL]]);
    expect(CARD_CATEGORY[CARD.DEVIL]).toBe('attack');
  });

  it('没有 onClick 时不是按钮；道具显示数量', () => {
    render(<ItemTile item={ITEM.CAR} name="汽车" count={2} testId="i" />);
    expect(screen.getByTestId('i').tagName).toBe('DIV');
    expect(screen.getByTestId('i')).toHaveTextContent('2');
  });
});

describe('Stepper / AmountSlider', () => {
  function StepperHarness({ max }: { max: number }) {
    const [v, setV] = useState(1);
    return <Stepper value={v} onChange={setV} min={1} max={max} bigStep={10} showMax label="数量" />;
  }

  it('加减、大步长、最大，都夹在范围内；输入框可清空重输', async () => {
    const user = userEvent.setup();
    render(<StepperHarness max={25} />);
    const input = screen.getByRole('spinbutton', { name: '数量' });
    await user.click(screen.getByRole('button', { name: '增加' }));
    expect(input).toHaveValue(2);
    await user.click(screen.getByRole('button', { name: '增加 10' }));
    await user.click(screen.getByRole('button', { name: '增加 10' }));
    expect(input).toHaveValue(22);
    expect(screen.getByRole('button', { name: '增加 10' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '增加 10' }));
    expect(input).toHaveValue(25);
    expect(screen.getByRole('button', { name: '增加' })).toBeDisabled();
    await user.clear(input);
    expect(input).toHaveDisplayValue('');
    await user.type(input, '7');
    expect(input).toHaveValue(7);
    await user.click(screen.getByRole('button', { name: '最大' }));
    expect(input).toHaveValue(25);
  });

  it('AmountSlider：快捷档与滑条', () => {
    const onChange = vi.fn();
    render(<AmountSlider value={0} onChange={onChange} max={1000} label="金额" />);
    fireEvent.click(screen.getByRole('button', { name: '一半' }));
    expect(onChange).toHaveBeenLastCalledWith(500);
    fireEvent.change(screen.getByLabelText('金额', { selector: 'input[type="range"]' }), { target: { value: '300' } });
    expect(onChange).toHaveBeenLastCalledWith(300);
  });
});

describe('Money / Modal / BuildingPreview', () => {
  it('Money：千分位、单位、正负着色', () => {
    render(<Money value={-1200} signed tone testId="m" />);
    expect(screen.getByTestId('m')).toHaveTextContent('−1,200元');
    expect(screen.getByTestId('m').className).toMatch(/moneyNeg/);
  });

  it('Modal：标题、关闭按钮', async () => {
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange} title="背包">
        内容
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: '背包' })).toHaveTextContent('内容');
    await userEvent.setup().click(screen.getByRole('button', { name: '关闭' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('BuildingPreview：jsdom 下退回楼层示意；spec 映射到生成器', () => {
    render(<BuildingPreview kind={{ t: 'house' }} level={3} owner={1} label="预览" />);
    expect(screen.getByTestId('building-preview')).toHaveAttribute('data-level', '3');
    expect(previewSpec({ t: 'house' }, 3, 1)).toMatchObject({ kind: 'house', level: 3, owner: 1, w: 1 });
    expect(previewSpec({ t: 'facility', type: 'hotel' }, 0, null).kind).toBe('facility:vacant');
    expect(previewSpec({ t: 'facility', type: 'lab' }, 2, 0).kind).toBe('facility:lab');
  });
});
