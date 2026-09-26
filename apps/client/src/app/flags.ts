// URL 调试开关（design/client.md §12.2）：?anim=instant（只提交不播放）、?audio=off、?test=1（暴露测试钩子）
export interface AppFlags {
  animInstant: boolean;
  audioOff: boolean;
  test: boolean;
}

export function parseFlags(search: string): AppFlags {
  const q = new URLSearchParams(search);
  return {
    animInstant: q.get('anim') === 'instant',
    audioOff: q.get('audio') === 'off',
    test: q.get('test') === '1',
  };
}

let cached: AppFlags | null = null;

/** 首次读取时解析当前地址（之后路由跳转不影响） */
export function appFlags(): AppFlags {
  cached ??= parseFlags(typeof location === 'undefined' ? '' : location.search);
  return cached;
}

/** 是否暴露 window.__rich4（开发模式或 URL 带测试开关） */
export function testHooksEnabled(): boolean {
  const f = appFlags();
  return import.meta.env.DEV || f.test || f.animInstant;
}
