/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 角色名集：original（默认，原作 12 名）或 alt（虚构名） */
  readonly VITE_NAMESET?: 'original' | 'alt';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
