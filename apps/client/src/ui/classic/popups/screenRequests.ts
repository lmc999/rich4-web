// 工具列打开原版界面的请求通道（很小，不带任何界面代码：经典外壳直接引用，原版界面本身在懒加载的 ClassicPopupHost 里）。
// ClassicPopupHost 挂载时登记处理函数：素材就绪就接管并返回 true；没有宿主或素材不可用时返回 false，由调用方打开程序化界面。
// （此前宿主在 document 捕获阶段截下工具列的点击，手机紧凑工具列「更多」菜单里的 LOAD / SAVE 因此收不到点击、菜单不收起。）

export type ClassicScreenRequest = { k: 'saves'; mode: 'load' | 'save' };

type Handler = (r: ClassicScreenRequest) => boolean;

let handler: Handler | null = null;

/** 登记处理函数（ClassicPopupHost）；返回撤销 */
export function registerClassicScreenHandler(h: Handler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** 请求用原版界面打开；true = 已接管，false = 调用方照旧打开程序化界面 */
export function requestClassicScreen(r: ClassicScreenRequest): boolean {
  return handler ? handler(r) : false;
}
