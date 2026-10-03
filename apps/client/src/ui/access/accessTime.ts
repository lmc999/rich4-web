// 访问会话到期时间的显示（首页「本次登录有效期至 …」，architecture §35）：本地时间「M月D日 HH:mm」，简繁通用。

export function formatAccessDeadline(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
