// 小游戏文案：键放在 i18n 命名空间 minigames（locales/zh-CN/minigames.json）下；json 里还没有的键用这里的中文缺省值，
// 以后补进 json 即可覆盖（不改代码）。
import i18next from 'i18next';

const DEFAULTS: Readonly<Record<string, string>> = {
  'host.score': '得分',
  'host.time': '时间',
  'host.startsIn': '准备',
  'host.go': '开始！',
  'host.waiting': '等待 {{who}}…',
  'host.watching': '{{who}} 正在玩',
  'host.replay': '回放：{{who}}',
  'host.final': '最终得分',
  'host.coupons': '获得 {{n}} 点券',
  'host.submitting': '结算中…',
  'host.skip': '点击跳过',
  'host.close': '收起',
  'host.paused': '对局已暂停',
  'host.resumeLost': '断线期间的游戏已按已上传的操作结算',
  'host.loading': '加载中…',
  'pose.low': '再接再厉！',
  'pose.mid': '还不错！',
  'pose.high': '太厉害了！',
  'pose.top': '财源滚滚！',
  'pose.bomb': '砰！被炸到了',
  'penguin.hint': '点冰面让企鹅走过去挖宝；开局先记住土堆的位置',
  'penguin.memorize': '记住土堆的位置！',
  'penguin.items': '宝物',
  'balloon.hint': '点击射爆升空的气球：数字加分，×2 翻倍，÷2 减半，? 随机效果',
  'balloon.effect.0': '时间到！',
  'balloon.effect.1': '冻结！',
  'balloon.effect.2': '加速！',
  'balloon.effect.3': '减速！',
  'balloon.effect.4': '分数清零！',
  'balloon.effect.5': '分数翻倍！',
  'balloon.freeze': '冻结中',
  'balloon.fast': '加速中',
  'balloon.slow': '减速中',
  'xicong.hint': '左右移动接住财神撒下的宝物，看到红色警告快躲开炸弹',
  'xicong.warn': '炸弹！',
};

/** minigames:<key>，缺省为上表的中文 */
export function mgText(key: string, params: Record<string, unknown> = {}): string {
  const dv = DEFAULTS[key] ?? key;
  return (i18next.t as unknown as (k: string, o: Record<string, unknown>) => string)(`minigames:${key}`, {
    defaultValue: dv,
    ...params,
  });
}

/** 游戏名（minigames:<id>.name 已存在） */
export function mgName(id: string): string {
  return (i18next.t as unknown as (k: string, o: Record<string, unknown>) => string)(`minigames:${id}.name`, {
    defaultValue: id,
  });
}
