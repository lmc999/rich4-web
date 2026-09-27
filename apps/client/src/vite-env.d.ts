/// <reference types="vite/client" />
// 测试断言类型：jest-dom 的匹配器（client-dom）须先于 @vitest/browser 的同名匹配器（client-browser 测试 import
// vitest/browser 时引入）载入——两者都扩展 vitest 的 Assertion，同名成员以先载入者为准，而 jest-dom 的
// toHaveTextContent 接受 RegExp。本文件位于 src 根目录，先于各子目录的测试文件进入类型程序。
/// <reference types="@testing-library/jest-dom/vitest" />

interface ImportMetaEnv {
  /** 角色名集：original（默认，原作 12 名）或 alt（虚构名） */
  readonly VITE_NAMESET?: 'original' | 'alt';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
