// 卡通风格的 radix Tabs 封装
import { Tabs as RTabs } from 'radix-ui';
import type { ReactNode } from 'react';
import s from './components.module.css';

export interface TabDef<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  content: ReactNode;
}

export interface TabsProps<V extends string> {
  tabs: readonly TabDef<V>[];
  value?: V;
  defaultValue?: V;
  onValueChange?(v: V): void;
  label: string;
}

export function Tabs<V extends string>({ tabs, value, defaultValue, onValueChange, label }: TabsProps<V>): ReactNode {
  return (
    <RTabs.Root
      value={value}
      defaultValue={defaultValue ?? tabs[0]?.value}
      onValueChange={onValueChange ? (v) => onValueChange(v as V) : undefined}
      activationMode="manual"
    >
      <RTabs.List className={s.tabsList} aria-label={label}>
        {tabs.map((tab) => (
          <RTabs.Trigger key={tab.value} value={tab.value} className={s.tabsTrigger} disabled={tab.disabled}>
            {tab.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((tab) => (
        <RTabs.Content key={tab.value} value={tab.value}>
          {tab.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}
