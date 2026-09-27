// 语音通道的排队 / 打断策略（原版阻塞语义：每句至少停留 minHold 毫秒）。
import { describe, expect, it } from 'vitest';
import { FakeAudioBuffer, FakeClock, flushMicrotasks } from './testing/fakeAudio';
import { VoiceChannel, type VoiceChannelOptions, type VoiceOutcome } from './voice';

interface Played {
  key: string;
  at: number;
  stoppedAt: number | null;
  endedAt: number | null;
}

function harness(o: Partial<VoiceChannelOptions> = {}, lengths: Record<string, number | null> = {}) {
  const clock = new FakeClock();
  const played: Played[] = [];
  const active: boolean[] = [];
  const loadDelay: Record<string, number> = {};
  const ch = new VoiceChannel(
    {
      now: () => clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      load: (key) => {
        const ms = lengths[key] === undefined ? 1500 : lengths[key];
        const buf = ms === null ? null : new FakeAudioBuffer(1, Math.round((ms / 1000) * 1000), 1000);
        const d = loadDelay[key];
        if (d) return new Promise((r) => clock.setTimeout(() => r(buf), d));
        return Promise.resolve(buf);
      },
      start: (key, buffer, onEnd) => {
        const p: Played = { key, at: clock.now, stoppedAt: null, endedAt: null };
        played.push(p);
        const t = clock.setTimeout(() => {
          p.endedAt = clock.now;
          onEnd();
        }, buffer.duration * 1000);
        return {
          stop: () => {
            p.stoppedAt = clock.now;
            clock.clearTimeout(t);
          },
        };
      },
      onActive: (on) => active.push(on),
      log: () => {},
    },
    o,
  );
  return { clock, ch, played, active, loadDelay };
}

describe('VoiceChannel', () => {
  it('original：一句 600 ms 的短句结束后，下一句仍要等满 1000 ms 才开口', async () => {
    const { clock, ch, played } = harness({}, { a: 600, b: 800 });
    const ra = ch.speak({ key: 'a' });
    const rb = ch.speak({ key: 'b' });
    await clock.advance(2000, 5);
    expect(played.map((p) => [p.key, p.at])).toEqual([
      ['a', 0],
      ['b', 1000],
    ]);
    await expect(ra).resolves.toBe('ended');
    await expect(rb).resolves.toBe('ended');
  });

  it('original：长句满 1000 ms 后被下一句打断；三句依次间隔 1000 ms', async () => {
    const { clock, ch, played } = harness({ maxWaitMs: 5000 }, { a: 3000, b: 3000, c: 500 });
    const out: VoiceOutcome[] = [];
    for (const k of ['a', 'b', 'c']) void ch.speak({ key: k }).then((r) => out.push(r));
    await clock.advance(4000, 5);
    expect(played.map((p) => [p.key, p.at])).toEqual([
      ['a', 0],
      ['b', 1000],
      ['c', 2000],
    ]);
    expect(played[0]!.stoppedAt).toBe(1000);
    expect(out).toEqual(['interrupted', 'interrupted', 'ended']);
  });

  it('queue：等前一句自然结束再开口（开局宣言）', async () => {
    const { clock, ch, played } = harness({}, { a: 1800, b: 1200 });
    void ch.speak({ key: 'a', policy: 'queue' });
    const rb = ch.speak({ key: 'b', policy: 'queue', maxWaitMs: 10_000 });
    await clock.advance(4000, 5);
    expect(played.map((p) => [p.key, p.at])).toEqual([
      ['a', 0],
      ['b', 1800],
    ]);
    await expect(rb).resolves.toBe('ended');
  });

  it('interrupt：清空队列并立即打断', async () => {
    const { clock, ch, played } = harness({}, { a: 3000, b: 3000, c: 500 });
    const ra = ch.speak({ key: 'a' });
    const rb = ch.speak({ key: 'b' });
    await clock.advance(100, 5);
    const rc = ch.speak({ key: 'c', policy: 'interrupt' });
    await flushMicrotasks();
    await expect(ra).resolves.toBe('interrupted');
    await expect(rb).resolves.toBe('dropped');
    expect(played.map((p) => [p.key, p.at])).toEqual([
      ['a', 0],
      ['c', 100],
    ]);
    await clock.advance(600, 5);
    await expect(rc).resolves.toBe('ended');
  });

  it('排队超过 maxWaitMs 作废；队列超过 maxQueue 丢最早的', async () => {
    const { clock, ch, played } = harness({ maxWaitMs: 1500, maxQueue: 2 }, { a: 5000, b: 500, c: 500, d: 500 });
    void ch.speak({ key: 'a', policy: 'queue' });
    await flushMicrotasks();
    const rb = ch.speak({ key: 'b', policy: 'queue' });
    const rc = ch.speak({ key: 'c', policy: 'queue' });
    const rd = ch.speak({ key: 'd', policy: 'queue' });
    await flushMicrotasks();
    await expect(rb).resolves.toBe('dropped'); // 队列上限 2：b 最早，被挤掉
    await clock.advance(6000, 5);
    await expect(rc).resolves.toBe('dropped'); // a 播 5 s，c、d 等不到
    await expect(rd).resolves.toBe('dropped');
    expect(played.map((p) => p.key)).toEqual(['a']);
  });

  it('缺素材记 missing 并继续下一句；加载慢的语音在加载完后开口', async () => {
    const { clock, ch, played, loadDelay } = harness({}, { a: null, b: 400 });
    loadDelay.b = 300;
    const ra = ch.speak({ key: 'a' });
    const rb = ch.speak({ key: 'b' });
    await expect(ra).resolves.toBe('missing');
    await clock.advance(1000, 5);
    expect(played.map((p) => [p.key, p.at])).toEqual([['b', 300]]);
    await expect(rb).resolves.toBe('ended');
  });

  it('onActive 在开口与结束时切换（引擎据此压低 BGM）', async () => {
    const { clock, ch, active } = harness({}, { a: 500 });
    void ch.speak({ key: 'a' });
    await clock.advance(1000, 5);
    expect(active).toEqual([true, false]);
    expect(ch.status).toBeNull();
  });

  it('stopAll：当前与排队的全部结束', async () => {
    const { clock, ch } = harness({}, { a: 3000, b: 500 });
    const ra = ch.speak({ key: 'a' });
    const rb = ch.speak({ key: 'b' });
    await clock.advance(100, 5);
    ch.stopAll();
    await expect(ra).resolves.toBe('cancelled');
    await expect(rb).resolves.toBe('cancelled');
    expect(ch.queued).toBe(0);
  });
});
