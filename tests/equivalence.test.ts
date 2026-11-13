import { describe, expect, it } from 'vitest';
import { logs, record, runNative } from './helpers';

/**
 * Differential test: instrumentation must not change what a program does.
 * Each program runs natively and instrumented; console output must match.
 */
const programs: Record<string, string> = {
  arithmetic: `
    let a = 1, b = 2; a += b; b = a * b - 1; a++; --b;
    console.log(a, b, a ** b, a % 3, -a, 7 / 2, 0 / 0, 1 / 0);`,
  'closures share state': `
    function counter() { let n = 0; return { inc: () => ++n, get: () => n }; }
    const c1 = counter(), c2 = counter();
    c1.inc(); c1.inc(); c2.inc();
    console.log(c1.get(), c2.get());`,
  recursion: `
    function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
    const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
    console.log(fib(12), fact(10));`,
  'array methods': `
    const xs = [5, 3, 8, 1];
    xs.push(9); xs.sort((a, b) => a - b); xs.reverse(); xs.splice(1, 2, 'x');
    const ys = xs.map((x) => String(x) + '!').filter((s) => s !== 'x!');
    console.log(xs, ys, xs.indexOf(1), xs.length, xs.reduce((n, x) => n + String(x).length, 0));`,
  'property writes': `
    const o = { a: 1, nested: { k: [] } };
    o.b = o.a + 1; o['c'] = 3; o.a += 10; o.a++; --o.b; o.nested.k[2] = 'z';
    delete o.c; o.d ??= 4; o.d ??= 5; o.a ||= 0; o.e &&= 1; o.a &&= 99;
    console.log(o, 'c' in o, o.nested.k.length);`,
  destructuring: `
    const { a, b: [c, ...d], e = 5 } = { a: 1, b: [2, 3, 4] };
    let x = 1, y = 2; [x, y] = [y, x];
    const swap = ({ p, q }) => ({ p: q, q: p });
    console.log(a, c, d, e, x, y, swap({ p: 1, q: 2 }));`,
  'loops and labels': `
    const out = [];
    outer: for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (j === 2) continue outer;
        if (i === 3) break outer;
        out.push(i * 10 + j);
      }
    }
    let n = 0; while (n < 3) n++;
    do { n--; } while (n > 1);
    for (const k in { a: 1, b: 2 }) out.push(k);
    for (const [i, v] of ['p', 'q'].entries()) out.push(i + v);
    let m = 0; for (;;) { if (++m > 2) break; }
    console.log(out, n, m);`,
  switch: `
    const kind = (v) => { switch (typeof v) { case 'number': return 'n'; case 'string': { const s = 's'; return s; } default: return '?'; } };
    let fall = ''; switch (2) { case 1: fall += 'a'; case 2: fall += 'b'; case 3: fall += 'c'; break; case 4: fall += 'd'; }
    console.log(kind(1), kind('x'), kind(null), fall);`,
  'try catch finally': `
    const log = [];
    function risky(n) { try { if (n > 1) throw new RangeError('big'); return 'ok'; } catch (e) { log.push(e.message); return 'caught'; } finally { log.push('fin' + n); } }
    function rethrow() { try { null.x; } finally { log.push('cleanup'); } }
    let msg; try { rethrow(); } catch (e) { msg = e instanceof TypeError; }
    const override = () => { try { return 1; } finally { log.push('f'); } };
    console.log(risky(1), risky(2), log, msg, override());`,
  classes: `
    class Animal {
      #secret = 1; static count = 0; legs = 4;
      constructor(name) { this.name = name; Animal.count++; }
      speak() { return this.name + ' makes a sound'; }
      get upper() { return this.name.toUpperCase(); }
      set nick(v) { this.name = v + '!'; }
      bump() { this.#secret++; return this.#secret; }
      static create(n) { return new Animal(n); }
    }
    class Dog extends Animal {
      constructor(name) { super(name); this.tricks = []; }
      speak() { return super.speak() + ' (woof)'; }
      learn(t) { this.tricks.push(t); return this; }
    }
    const d = new Dog('Rex'); d.learn('sit').learn('roll'); d.nick = 'Rexy';
    console.log(d.speak(), d.upper, d.bump(), d.tricks, Animal.count, d instanceof Animal, Animal.create('x').legs);`,
  'this and call/apply/bind': `
    const o = { v: 2, mul(x) { return this.v * x; } };
    const f = o.mul; const g = f.bind({ v: 10 });
    function who() { return this === undefined; }
    console.log(o.mul(3), f.call({ v: 5 }, 3), f.apply({ v: 7 }, [3]), g(1), who());`,
  'default params and rest': `
    function f(a, b = a + 1, ...rest) { return [a, b, rest.length]; }
    const g = (x, cb = () => x * 2) => cb();
    const h = (x = 1) => { x += 1; return x; };
    console.log(f(1), f(1, 5, 6, 7), g(4), h(), h(5));`,
  'maps sets and json': `
    const m = new Map([['a', 1]]); m.set('b', { deep: true }); m.delete('a');
    const s = new Set([1, 2, 2, 3]); s.add(4); s.delete(1);
    const j = JSON.parse(JSON.stringify({ x: [1, { y: 2 }] }));
    console.log([...m.keys()], m.get('b'), [...s], j.x[1].y, m.size, s.has(2));`,
  'string and number built-ins': `
    const s = 'Hello, World';
    console.log(s.toUpperCase(), s.split(', '), s.slice(-5), s.replace(/o/g, '0'), s.length, (3.14159).toFixed(2), Math.max(1, 5, 3), parseInt('42px'), [3, 1, 2].join('-'), s.at(-1), 'ab'.repeat(2));`,
  'hoisting and shadowing': `
    console.log(typeof hoisted, hoisted());
    function hoisted() { return 'up'; }
    var v = 1; { let v2 = 2; { let v2 = 3; v += v2; } v += v2; }
    let x = 'outer'; { let x = 'inner'; x += '!'; console.log(x); }
    console.log(v, x, (function () { return typeof later; var later = 1; })());`,
  'sequence, comma, ternary, chaining': `
    let a = 0; const b = (a++, a++, a); const o = { p: { q: () => 7 } };
    let u; const c = u?.x?.y, d = o.p?.q?.(), e = o.z?.q();
    let t = a > 1 ? (a = 10) : (a = 20);
    console.log(a, b, c, d, e, t, void 0, typeof u);`,
  'getters, setters, object literals': `
    let hits = 0;
    const o = { _v: 1, get v() { hits++; return this._v; }, set v(n) { this._v = n * 2; }, ['k' + 1]: 'computed', m() { return 'm'; } };
    o.v = 5; o.v += 1;
    console.log(o.v, o._v, o.k1, o.m(), hits);`,
  'higher-order and iife': `
    const compose = (...fns) => (x) => fns.reduceRight((acc, fn) => fn(acc), x);
    const add1 = (x) => x + 1, dbl = (x) => x * 2;
    const r = (function (n) { let acc = []; for (let i = 0; i < n; i++) acc.push(() => i); return acc.map((f) => f()); })(3);
    console.log(compose(add1, dbl)(5), r, [1, 2, 3].flatMap((x) => [x, x]).length);`,
  'bubble sort': `
    function sort(a) { const n = a.length; for (let i = 0; i < n; i++) for (let j = 0; j < n - i - 1; j++) if (a[j] > a[j + 1]) { const t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; } return a; }
    console.log(sort([5, 2, 9, 1, 5, 6]));`,
  'linked list and cycles': `
    function node(v, next) { return { v, next }; }
    let list = null; for (let i = 3; i > 0; i--) list = node(i, list);
    let sum = 0; for (let n = list; n; n = n.next) sum += n.v;
    const a = { name: 'a' }; const b = { name: 'b', peer: a }; a.peer = b;
    console.log(sum, a.peer.peer === a, list.next.next.next);`,
  'exotic values': `
    const big = 2n ** 64n; let bi = 1n; bi++; const o = { n: 1n }; o.n++; o.n += 5n;
    console.log(big, bi, o.n, -0, NaN, Infinity, undefined, null, typeof Symbol('s'), [, 1].length, new Date(0).getTime(), /a+/.test('caat'));`,
  'throwing getters and frozen objects': `
    const frozen = Object.freeze({ a: 1 }); let err1, err2;
    try { frozen.a = 2; } catch (e) { err1 = e.constructor.name; }
    try { undefined.x = 1; } catch (e) { err2 = e.constructor.name; }
    let err3; try { ({}).nope(); } catch (e) { err3 = e.constructor.name; }
    console.log(err1, err2, err3, frozen.a);`,
  'static blocks and class expressions': `
    const K = class Named { static total; static { Named.total = 0; let t = 5; Named.total += t; } tick = () => ++K.total; };
    const k = new K(); k.tick(); k.tick();
    console.log(K.total, K.name);`,
  'evaluation order': `
    const order = []; const t = (n, v) => (order.push(n), v);
    const o = {}; t(1, o)[t(2, 'k')] = t(3, 'v');
    t(4, o).k2 = t(5, 1); o[t(6, 'm')] = () => t(8, 'r'); t(7, o).m();
    console.log(order, o.k);`,
};

describe('equivalence: instrumented output matches native output', () => {
  for (const [name, source] of Object.entries(programs)) {
    it(name, () => {
      const native = runNative(source);
      expect(native.error, 'test program must run natively').toBeUndefined();
      expect(native.logs.length).toBeGreaterThan(0);
      const recorded = record(source);
      expect(recorded.error).toBeUndefined();
      expect(recorded.status).toBe('ok');
      expect(logs(recorded)).toEqual(native.logs.map((line) => line.map(normalise)));
    });
  }
});

/** Bring native log arguments to the same shape `decode` produces. */
function normalise(value: unknown): unknown {
  if (typeof value === 'function') return undefined;
  if (typeof value === 'symbol') return `Symbol(${value.description})`;
  return value;
}
