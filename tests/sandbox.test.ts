import { describe, expect, it } from 'vitest';
import { isFromWorker } from '../src/engine/sandbox/protocol';
import { logs, record, vars } from './helpers';

describe('execute: outcomes', () => {
  it('reports uncaught errors with the location of the last step', () => {
    const r = record('let a = 1;\nlet b = a.missing.deep;\nlet c = 3;');
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ name: 'TypeError' });
    expect(r.locs[r.error!.loc].line).toBe(2);
    expect(r.events.at(-1)).toMatchObject({ kind: 'exit', scope: 0, threw: true });
    expect(vars(r.final)).toEqual({ a: 1 });
  });

  it('reports thrown non-errors', () => {
    const r = record('throw "plain";');
    expect(r).toMatchObject({ status: 'error', error: { name: 'Uncaught', message: 'plain' } });
  });

  it('survives runaway recursion with a balanced trace', () => {
    const r = record('function f() { return f(); } let caught = false; try { f(); } catch (e) { caught = e instanceof RangeError; }', { maxEvents: 1e6 });
    expect(r.status).toBe('ok');
    expect(vars(r.final).caught).toBe(true);
    expect(r.final.stack).toEqual([]);
  });

  it('counts every event it delivers', () => {
    const r = record('for (let i = 0; i < 100; i++) {}', { batchSize: 7 });
    expect(r.total).toBe(r.events.length);
  });
});

describe('execute: event limit', () => {
  it.each([
    ['while (true) {}'],
    ['for (;;) {}'],
    ['do {} while (true);'],
    ['for (const x of (function () { const a = []; a.length = 1e9; return a; })()) {}'],
    ['function f() { while (true) { g(); } } function g() {} f();'],
    ['const o = { n: 0 }; while (true) o.n++;'],
  ])('stops %s', (source) => {
    const r = record(source, { maxEvents: 1000 });
    expect(r.status).toBe('limit');
    expect(r.events.length).toBe(1000);
  });

  it('cannot be swallowed by user try/catch or finally', () => {
    const r = record(`
      while (true) {
        try { while (true) {} } catch (e) { console.log('caught'); } finally { console.log('finally'); }
      }`, { maxEvents: 500 });
    expect(r.status).toBe('limit');
    expect(r.events.length).toBe(500);
    expect(logs(r)).toEqual([]);
  });

  it('leaves a trace prefix that still replays', () => {
    const r = record('let n = 0; function tick() { n++; } while (true) tick();', { maxEvents: 2000 });
    expect(r.status).toBe('limit');
    expect(vars(r.final).n).toBeGreaterThan(100);
    expect(r.replayer.stateAt(1000).index).toBe(1000);
  });
});

describe('execute: isolation', () => {
  it.each([
    'self', 'globalThis', 'window', 'postMessage', 'fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts',
    'setTimeout', 'setInterval', 'queueMicrotask', 'Promise', 'Function', 'Worker', 'indexedDB', 'process', 'require',
  ])('hides %s', (name) => {
    const r = record(`console.log(typeof ${name});`);
    expect(logs(r)).toEqual([['undefined']]);
  });

  it('runs user code in strict mode with no global this', () => {
    const r = record('const t = (function () { return this; })(); let err; try { undeclared = 1; } catch (e) { err = e.name; }');
    expect(vars(r.final)).toMatchObject({ t: undefined, err: 'ReferenceError' });
  });

  it('starts each run from a clean runtime', () => {
    const a = record('let x = 1;');
    const b = record('let x = 1;');
    expect(b.events).toEqual(a.events);
  });
});

describe('protocol: isFromWorker', () => {
  it('accepts well-formed messages', () => {
    expect(isFromWorker({ type: 'ready' })).toBe(true);
    expect(isFromWorker({ type: 'batch', runId: 'r', events: [] })).toBe(true);
    expect(isFromWorker({ type: 'done', runId: 'r', status: 'ok', total: 0, ms: 1 })).toBe(true);
  });

  it.each([
    null, 'ready', 42, {}, { type: 'run' }, { type: 'batch', runId: 'r' }, { type: 'batch', runId: 1, events: [] },
    { type: 'done', runId: 'r', status: 'timeout', total: 0 }, { type: 'done', runId: 'r', status: 'ok' },
  ])('rejects %j', (message) => {
    expect(isFromWorker(message)).toBe(false);
  });
});
