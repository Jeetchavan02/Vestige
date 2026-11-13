import { describe, expect, it } from 'vitest';
import { currentLoc } from '../src/engine/replay/state';
import type { TraceEvent } from '../src/engine/types';
import { decode, record, vars } from './helpers';

const kinds = (events: TraceEvent[]) => events.map((e) => e.kind);

describe('trace: frames', () => {
  it('opens with the program frame and closes it last', () => {
    const { events } = record('let a = 1;');
    expect(events[0]).toMatchObject({ kind: 'enter', scope: 0, parent: null, name: '(main)' });
    expect(events.at(-1)).toMatchObject({ kind: 'exit', scope: 0 });
    expect(kinds(events)).toEqual(['enter', 'step', 'declare', 'exit']);
  });

  it('balances enter and exit and records return values', () => {
    const { events } = record('function sq(n) { return n * n; } sq(3); sq(4);');
    const enters = events.filter((e) => e.kind === 'enter' && e.name === 'sq');
    const exits = events.filter((e) => e.kind === 'exit' && e.scope !== 0);
    expect(enters.map((e) => e.scope)).toEqual([1, 2]);
    expect(exits.map((e) => [e.scope, e.value])).toEqual([[1, 9], [2, 16]]);
    expect(enters.every((e) => e.parent === 0)).toBe(true);
  });

  it('marks frames left by an exception', () => {
    const r = record('function boom() { throw new Error("no"); } try { boom(); } catch (e) {}');
    const exit = r.events.find((e) => e.kind === 'exit' && e.scope === 1)!;
    expect(exit.threw).toBe(true);
    expect(decode(r.final, exit.value)).toMatchObject({ name: 'Error', message: 'no' });
    expect(r.events.at(-1)).toEqual({ kind: 'exit', scope: 0 });
  });

  it('grows the replayed stack with recursion and unwinds it fully', () => {
    const r = record('function down(n) { if (n > 0) down(n - 1); } down(4);');
    let deepest = 0;
    for (let t = 0; t < r.events.length; t++) {
      deepest = Math.max(deepest, r.replayer.stateAt(t).stack.length);
    }
    expect(deepest).toBe(6);
    expect(r.final.stack).toEqual([]);
  });

  it('names functions from their binding context', () => {
    const r = record(`
      const arrow = () => 1; const o = { method() {}, prop: function () {} };
      class C { constructor() {} go() {} }
      arrow(); o.method(); o.prop(); new C().go(); (function () {})();`);
    const names = r.events.filter((e) => e.kind === 'enter').map((e) => e.name);
    expect(names).toEqual(['(main)', 'arrow', 'method', 'prop', 'C', 'go', '(anonymous)']);
  });

  it('keeps a caller on its call site while the callee runs', () => {
    const r = record('function f() {\n  return 1;\n}\nlet a = f();');
    const inside = r.events.findIndex((e) => e.kind === 'enter' && e.name === 'f');
    const state = r.replayer.stateAt(inside);
    expect(state.stack.map((f) => f.name)).toEqual(['(main)', 'f']);
    expect(r.locs[state.stack[0].loc].line).toBe(4);
    expect(r.locs[currentLoc(state)].line).toBe(1);
  });
});

describe('trace: variables', () => {
  it('records declarations, assignments and updates', () => {
    const r = record('let a = 1; a = 2; a += 3; a++; var b; const c = a;');
    expect(vars(r.final)).toEqual({ a: 6, b: undefined, c: 6 });
    const writes = r.events.filter((e) => e.name === 'a').map((e) => [e.kind, e.value]);
    expect(writes).toEqual([['declare', 1], ['assign', 2], ['assign', 5], ['assign', 6]]);
  });

  it('attributes closure writes to the scope that owns the binding', () => {
    const r = record(`
      function counter() { let n = 0; return () => { n++; return n; }; }
      const a = counter(); const b = counter(); a(); a(); b();`);
    const scopeOf = (i: number) => r.events.filter((e) => e.kind === 'enter' && e.name === 'counter')[i].scope!;
    expect(vars(r.final, scopeOf(0))).toEqual({ n: 2 });
    expect(vars(r.final, scopeOf(1))).toEqual({ n: 1 });
    const inner = r.events.filter((e) => e.kind === 'enter' && e.name === '(anonymous)');
    expect(inner.map((e) => e.parent)).toEqual([scopeOf(0), scopeOf(0), scopeOf(1)]);
  });

  it('records parameters, defaults, rest and this', () => {
    const r = record('const o = { k: 1, f(a, b = 2, ...rest) { return this.k; } }; o.f(1, undefined, 3, 4);');
    const scope = r.events.find((e) => e.kind === 'enter' && e.name === 'f')!.scope!;
    expect(vars(r.final, scope)).toMatchObject({ a: 1, b: 2, rest: [3, 4], this: { k: 1 } });
  });

  it('gives shadowed block bindings distinct keys', () => {
    const r = record('let x = 1; { let x = 2; x = 3; { let x = 4; } } x = 5;');
    expect(vars(r.final)).toEqual({ x: 5, 'x#2': 3, 'x#3': 4 });
  });

  it('records destructuring targets and loop bindings', () => {
    const r = record(`
      const { a, b: [c, d] } = { a: 1, b: [2, 3] };
      let p, q; [p, q] = [a, c];
      let last; for (const item of ['x', 'y']) { last = item; }
      let key; for (key in { only: 1 }) {}
      try { throw 7; } catch (err) { p = err; }`);
    expect(vars(r.final)).toEqual({ a: 1, c: 2, d: 3, p: 7, q: 2, last: 'y', item: 'y', key: 'only', err: 7 });
  });

  it('shows the loop counter at every iteration', () => {
    const r = record('let s = 0; for (let i = 0; i < 3; i++) { s += i; }');
    const seen = r.events.filter((e) => e.name === 'i').map((e) => e.value);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  it('encodes values JSON cannot carry', () => {
    const r = record('const a = undefined, b = NaN, c = -0, d = 10n, e = Symbol("tag"), f = -Infinity, g = null;');
    const raw = Object.fromEntries(r.final.scopes.get(0)!.vars);
    expect(raw).toEqual({
      a: { t: 'undefined' }, b: { t: 'number', v: 'NaN' }, c: { t: 'number', v: '-0' },
      d: { t: 'bigint', v: '10' }, e: { t: 'symbol', v: 'tag' }, f: { t: 'number', v: '-Infinity' }, g: null,
    });
  });

  it('survives a JSON round trip', () => {
    const { events } = record('const o = { a: [1, { b: undefined }], n: NaN }; o.a.push(2n);');
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });
});

describe('trace: heap', () => {
  it('preserves aliasing', () => {
    const r = record('const a = { n: 1 }; const b = a; b.n = 2;');
    const scope = r.final.scopes.get(0)!.vars;
    expect(scope.get('a')).toEqual(scope.get('b'));
    expect(vars(r.final).a).toEqual({ n: 2 });
  });

  it('preserves cycles', () => {
    const r = record('const a = { name: "a" }; a.self = a;');
    const a = vars(r.final).a as { self: unknown };
    expect(a.self).toBe(a);
  });

  it('sends a property write as a single-key delta', () => {
    const r = record('const xs = [1, 2, 3]; xs[1] = 20; xs[3] = 4;');
    const deltas = r.events.filter((e) => e.kind === 'mutate').map((e) => e.heap);
    expect(deltas).toEqual([[{ id: 1, set: { '1': 20 } }], [{ id: 1, set: { '3': 4 }, length: 4 }]]);
  });

  it('sees mutations made by built-in methods', () => {
    const r = record(`
      const xs = [3, 1, 2]; xs.sort(); xs.push(9); xs.shift();
      const o = {}; Object.assign(o, { a: 1 }); 
      const m = new Map(); m.set('k', xs); const s = new Set(); s.add(1);`);
    expect(vars(r.final)).toEqual({ xs: [2, 3, 9], o: { a: 1 }, m: new Map([['k', [2, 3, 9]]]), s: new Set([1]) });
  });

  it('does not report a mutation when a built-in changes nothing', () => {
    const r = record('const xs = [1, 2]; xs.includes(1); xs.slice(); xs.map((x) => x);');
    expect(r.events.some((e) => e.kind === 'mutate')).toBe(false);
  });

  it('tracks deletes, shrinking arrays and nested writes', () => {
    const r = record('const o = { a: 1, b: { c: [1, 2, 3] } }; delete o.a; o.b.c.length = 1; o.b.c[0]++; o.b.d = { e: 1 };');
    expect(vars(r.final).o).toEqual({ b: { c: [2], d: { e: 1 } } });
  });

  it('tracks class instances, fields written via this, and private state changes', () => {
    const r = record(`
      class Stack { #n = 0; items = []; push(v) { this.items.push(v); this.#n++; this.top = v; return this; } }
      const s = new Stack(); s.push(1).push(2);`);
    const id = (r.final.scopes.get(0)!.vars.get('s') as { id: number }).id;
    expect(r.final.heap.get(id)!.ctor).toBe('Stack');
    expect(vars(r.final).s).toEqual({ items: [1, 2], top: 2 });
  });

  it('never invokes getters while recording', () => {
    const r = record('let calls = 0; const o = { get g() { calls++; return 1; } }; const p = o; console.log(o);');
    expect(vars(r.final)).toMatchObject({ calls: 0, o: { g: '<accessor>' } });
  });

  it('is not confused by proxies whose traps run instrumented code', () => {
    const r = record(`
      let trapped = 0;
      const p = new Proxy({ a: 1 }, { ownKeys(t) { trapped++; return Reflect.ownKeys(t); }, get(t, k) { trapped++; return t[k]; } });
      const q = p; console.log(p.a);`);
    expect(r.status).toBe('ok');
    expect(r.final.stack).toEqual([]);
  });

  it('caps large arrays and long strings', () => {
    const r = record('const big = Array.from({ length: 1000 }, (_, i) => i); const s = "x".repeat(5000);');
    const id = (r.final.scopes.get(0)!.vars.get('big') as { id: number }).id;
    const object = r.final.heap.get(id)!;
    expect(Object.keys(object.props).length).toBe(200);
    expect(object).toMatchObject({ length: 1000, truncated: 800 });
    expect((vars(r.final).s as string).length).toBe(2001);
  });

  it('describes functions, dates, regexps and errors', () => {
    const r = record('function f() {} class K {} const d = new Date(0), re = /a/g, e = new TypeError("bad");');
    expect(vars(r.final)).toMatchObject({
      f: 'ƒ f()', K: 'class K', d: '1970-01-01T00:00:00.000Z', re: '/a/g', e: { name: 'TypeError', message: 'bad' },
    });
  });

  it('handles very deep structures without overflowing the stack', () => {
    const r = record('let list = null; for (let i = 0; i < 20000; i++) list = { next: list }; const head = list;', { maxEvents: 1e6 });
    expect(r.status).toBe('ok');
    expect(r.final.heap.size).toBe(20000);
  });
});

describe('trace: console', () => {
  it('records level and arguments, and reveals output progressively', () => {
    const r = record('console.log("a", 1); console.warn({ w: true }); console.error("c");');
    const logged = r.replayer.logs.map((i) => r.events[i]);
    expect(logged.map((e) => e.level)).toEqual(['log', 'warn', 'error']);
    expect(logged[0].args).toEqual(['a', 1]);
    expect(r.replayer.stateAt(r.replayer.logs[1] - 1).logCount).toBe(1);
    expect(r.final.logCount).toBe(3);
  });
});
