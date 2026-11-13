import { describe, expect, it } from 'vitest';
import { Replayer } from '../src/engine/replay/replayer';
import { applyEvent, cloneState, emptyState, type ProgramState } from '../src/engine/replay/state';
import type { TraceEvent } from '../src/engine/types';
import { record, vars } from './helpers';

const SOURCE = `
  function push(list, v) { list.items.push(v); list.size++; return list; }
  const list = { items: [], size: 0 };
  let total = 0;
  for (let i = 0; i < 40; i++) {
    push(list, i * i);
    if (i % 3 === 0) { total += list.items[i]; list.items[0] = total; }
    if (i % 10 === 0) console.log(i, total);
  }
  delete list.size;
`;

/** Reference implementation: replay from zero every time. */
function linear(events: TraceEvent[], t: number): ProgramState {
  const state = emptyState();
  for (let i = 0; i <= t; i++) applyEvent(state, events[i], i);
  return state;
}

describe('Replayer', () => {
  const { events } = record(SOURCE);

  it('has enough events to cross several checkpoints', () => {
    expect(events.length).toBeGreaterThan(500);
  });

  it.each([1, 7, 64, 512, 100_000])('matches linear replay at every index (interval %i)', (interval) => {
    const replayer = new Replayer(events, interval);
    for (let t = -1; t < events.length; t++) {
      expect(replayer.stateAt(t)).toEqual(linear(events, t));
    }
  });

  it('matches linear replay when stepping backwards', () => {
    const replayer = new Replayer(events, 64);
    for (let t = events.length - 1; t >= -1; t--) {
      expect(replayer.stateAt(t)).toEqual(linear(events, t));
    }
  });

  it('matches linear replay for random seeks', () => {
    const replayer = new Replayer(events, 50);
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % events.length;
    for (let n = 0; n < 300; n++) {
      const t = next();
      expect(replayer.stateAt(t)).toEqual(linear(events, t));
    }
  });

  it('clamps out-of-range times', () => {
    const replayer = new Replayer(events);
    expect(replayer.stateAt(-50)).toEqual(emptyState());
    expect(replayer.stateAt(1e9).index).toBe(events.length - 1);
    expect(replayer.stateAt(3.9).index).toBe(3);
  });

  it('gives the same result whether events arrive at once or in batches', () => {
    const streamed = new Replayer([], 64);
    for (let i = 0; i < events.length; i += 37) streamed.append(events.slice(i, i + 37));
    const whole = new Replayer(events, 64);
    expect(streamed.length).toBe(whole.length);
    expect(streamed.logs).toEqual(whole.logs);
    for (const t of [0, 63, 64, 65, 300, events.length - 1]) {
      expect(streamed.stateAt(t)).toEqual(whole.stateAt(t));
    }
  });

  it('can be queried mid-stream and again after more events arrive', () => {
    const replayer = new Replayer([], 16);
    replayer.append(events.slice(0, 100));
    expect(replayer.stateAt(99)).toEqual(linear(events, 99));
    replayer.append(events.slice(100));
    expect(replayer.stateAt(99)).toEqual(linear(events, 99));
    expect(replayer.stateAt(events.length - 1)).toEqual(linear(events, events.length - 1));
  });

  it('never mutates the trace', () => {
    const frozen = JSON.stringify(events);
    const replayer = new Replayer(events, 32);
    for (let t = events.length - 1; t >= 0; t -= 5) replayer.stateAt(t);
    expect(JSON.stringify(events)).toBe(frozen);
  });

  it('returns independent snapshots', () => {
    const replayer = new Replayer(events, 32);
    const snapshot = replayer.snapshotAt(200);
    const copy = cloneState(snapshot);
    replayer.stateAt(events.length - 1);
    replayer.stateAt(10);
    expect(snapshot).toEqual(copy);
  });

  it('rejects a bad checkpoint interval', () => {
    expect(() => new Replayer([], 0)).toThrow(RangeError);
    expect(() => new Replayer([], 1.5)).toThrow(RangeError);
  });

  it('shows the past exactly as it was', () => {
    const r = record('let a = 1; const o = { v: a }; a = 2; o.v = a; a = 3; o.v = a;');
    const history = [];
    for (let t = 0; t < r.events.length; t++) {
      const kind = r.events[t].kind;
      if (kind === 'assign' || kind === 'mutate') history.push(vars(r.replayer.stateAt(t)));
    }
    expect(history).toEqual([
      { a: 2, o: { v: 1 } }, { a: 2, o: { v: 2 } }, { a: 3, o: { v: 2 } }, { a: 3, o: { v: 3 } },
    ]);
    expect(vars(r.replayer.stateAt(2))).toEqual({ a: 1 });
  });
});
