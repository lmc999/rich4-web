// 不对应决策的原版全屏界面（资产表、月结颁奖、监狱 / 医院 / 恶人、新闻命运板、终局…；original-skin.md §4.2、§5 A11/A12）的
// 注册表骨架：由负责的代理填充并在各自的宿主里使用。组件建议同样用 ../common 的 Stage4x3 搭建，素材缺失时回退程序化界面。
import type { ComponentType, LazyExoticComponent } from 'react';

/** 界面组件的 props（骨架：由填充本注册表的代理按需要收窄） */
export type ClassicScreenProps = Record<string, unknown>;

/** 界面 id → 懒加载组件 */
export type ClassicScreenRegistry = Readonly<Record<string, LazyExoticComponent<ComponentType<ClassicScreenProps>>>>;

export const classicScreens: ClassicScreenRegistry = {};
