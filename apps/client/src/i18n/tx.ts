// 动态键的 t（键由 id 或事件名拼出，编译期无法逐个校验；由 i18n 测试遍历断言存在）
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';

export type LooseT = (key: string, params?: Record<string, unknown>) => string;

export const tx: LooseT = (key, params) => (i18next.t as unknown as LooseT)(key, params);

/** React 钩子版本：语言切换时组件重渲染 */
export function useTx(): LooseT {
  const { t } = useTranslation();
  return t as unknown as LooseT;
}
