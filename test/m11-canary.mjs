// M11：空闲进程的事件循环延迟金丝雀——每 5ms 一个定时器，记录每秒最大迟到，判断宿主机是否有周期性调度抖动。
// 用法：node test/m11-canary.mjs [秒=40]
const secs = Number(process.argv[2] ?? 40);
const t0 = performance.now();
let prev = t0;
const worst = new Array(secs).fill(0);
const iv = setInterval(() => {
  const now = performance.now();
  const late = now - prev - 5;
  prev = now;
  const s = Math.floor((now - t0) / 1000);
  if (s < secs) worst[s] = Math.max(worst[s], late);
  else {
    clearInterval(iv);
    console.log(worst.map((w, i) => `${i}:${w.toFixed(0)}`).join(' '));
  }
}, 5);
