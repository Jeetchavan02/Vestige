import type { EventKind, Limits, LogLevel, TraceEvent } from '../types';
import { HeapTracker } from './heap';

/**
 * Thrown by hooks once the event limit is reached. It is not an Error and it
 * is re-thrown by every subsequent hook, so a user `catch` cannot keep the
 * program running past the limit.
 */
export const LIMIT = Object.freeze({ vestige: 'event-limit' });

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const fnToString = Function.prototype.toString;
const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;

function toKey(key: unknown): PropertyKey {
  return typeof key === 'symbol' || typeof key === 'number' ? key : String(key);
}

function binary(operator: string, a: Any, b: Any): Any {
  switch (operator) {
    case '+=': return a + b;
    case '-=': return a - b;
    case '*=': return a * b;
    case '/=': return a / b;
    case '%=': return a % b;
    case '**=': return a ** b;
    case '<<=': return a << b;
    case '>>=': return a >> b;
    case '>>>=': return a >>> b;
    case '&=': return a & b;
    case '|=': return a | b;
    case '^=': return a ^ b;
    default: throw new SyntaxError(`Unsupported assignment operator ${operator}`);
  }
}

/**
 * The object instrumented code calls as `$v`. Method names are short because
 * they appear at every instrumented site:
 *
 *   s      step                    enter / exit / r / x   frame lifecycle
 *   d, w   declare / assign        ps, pc, pl, pu, pd     property writes
 *   mc     method call             after, sync            helpers
 */
export class Runtime {
  /** Loc of the most recent step; reported with uncaught errors. */
  lastLoc = -1;
  /** Total events recorded. */
  count = 0;

  readonly console: Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>;

  private readonly heap = new HeapTracker();
  private readonly nativeCache = new WeakMap<object, boolean>();
  private batch: TraceEvent[] = [];
  private dead = false;
  private nextScope = 0;
  private pendingExit: { scope: number; value: unknown; threw: boolean } | null = null;

  constructor(
    private readonly limits: Limits,
    private readonly onBatch: (events: TraceEvent[]) => void,
  ) {
    const log = (level: LogLevel) => (...args: unknown[]) => this.log(level, args);
    this.console = {
      log: log('log'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      debug: log('log'),
    };
  }

  get limitReached(): boolean {
    return this.dead;
  }

  /** Hand any buffered events to the consumer. */
  flush(): void {
    if (this.batch.length === 0) return;
    const batch = this.batch;
    this.batch = [];
    this.onBatch(batch);
  }

  private guard(): void {
    if (this.dead) throw LIMIT;
  }

  private emit(event: TraceEvent): void {
    if (this.heap.pending.length > 0) {
      event.heap = this.heap.pending;
      this.heap.pending = [];
    }
    this.batch.push(event);
    if (this.batch.length >= this.limits.batchSize) this.flush();
    if (++this.count >= this.limits.maxEvents) {
      this.dead = true;
      throw LIMIT;
    }
  }

  /** Emit a `mutate` event if a sync found changes. */
  private mutated(): void {
    if (this.heap.pending.length === 0) return;
    this.guard();
    this.emit({ kind: 'mutate' });
  }

  // ── steps ────────────────────────────────────────────────────────────────

  s(loc: number): void {
    if (this.heap.busy) return;
    this.guard();
    this.lastLoc = loc;
    this.emit({ kind: 'step', loc });
  }

  // ── frames ───────────────────────────────────────────────────────────────

  enter(name: string, parent: number | null, loc: number): number {
    if (this.heap.busy) return -1;
    this.guard();
    const scope = this.nextScope++;
    this.emit({ kind: 'enter', scope, parent, name, loc });
    return scope;
  }

  /** Remember the return value until the frame's `finally` reports the exit. */
  r<V>(scope: number, value: V): V {
    if (!this.heap.busy) this.pendingExit = { scope, value, threw: false };
    return value;
  }

  /** An exception is leaving this frame. Returns it for re-throwing. */
  x<E>(scope: number, error: E): E {
    if (!this.heap.busy && (error as unknown) !== LIMIT) {
      this.pendingExit = { scope, value: error, threw: true };
    }
    return error;
  }

  exit(scope: number): void {
    if (scope < 0 || this.dead || this.heap.busy) return;
    const event: TraceEvent = { kind: 'exit', scope };
    const pending = this.pendingExit;
    this.pendingExit = null;
    if (pending && pending.scope === scope) {
      event.value = this.heap.ser(pending.value);
      if (pending.threw) event.threw = true;
    }
    this.emit(event);
  }

  // ── variables ────────────────────────────────────────────────────────────

  d<V>(scope: number, name: string, value: V): V {
    return this.write('declare', scope, name, value);
  }

  w<V>(scope: number, name: string, value: V): V {
    return this.write('assign', scope, name, value);
  }

  private write<V>(kind: EventKind, scope: number, name: string, value: V): V {
    if (this.heap.busy || scope < 0) return value;
    this.guard();
    const encoded = this.heap.ser(value);
    this.emit({ kind, scope, name, value: encoded });
    return value;
  }

  /** Evaluate the remaining arguments for their side effects; yield the first. */
  after<V>(value: V, ..._effects: unknown[]): V {
    return value;
  }

  sync(target: unknown): void {
    if (this.heap.busy) return;
    this.heap.sync(target);
    this.mutated();
  }

  // ── properties ───────────────────────────────────────────────────────────

  private touched(target: unknown, key?: PropertyKey): void {
    if (this.heap.busy) return;
    if (key === undefined) this.heap.sync(target);
    else this.heap.syncKey(target, key);
    this.mutated();
  }

  /** o[k] = v */
  ps<V>(target: Any, key: unknown, value: V): V {
    const k = toKey(key);
    target[k] = value;
    this.touched(target, k);
    return value;
  }

  /** o[k] op= v */
  pc(target: Any, key: unknown, operator: string, value: unknown): unknown {
    const k = toKey(key);
    const next = binary(operator, target[k], value);
    target[k] = next;
    this.touched(target, k);
    return next;
  }

  /** o[k] ||= v, o[k] &&= v, o[k] ??= v — `value` is lazy to keep short-circuiting. */
  pl(target: Any, key: unknown, operator: string, value: () => unknown): unknown {
    const k = toKey(key);
    const current = target[k];
    const keep =
      operator === '||=' ? current : operator === '&&=' ? !current : current != null;
    if (keep) return current;
    const next = value();
    target[k] = next;
    this.touched(target, k);
    return next;
  }

  /** o[k]++ / ++o[k] / o[k]-- / --o[k] */
  pu(target: Any, key: unknown, operator: string, prefix: boolean): unknown {
    const k = toKey(key);
    const raw = target[k];
    const old: Any = typeof raw === 'bigint' ? raw : Number(raw);
    const one: Any = typeof old === 'bigint' ? 1n : 1;
    const next = operator === '++' ? old + one : old - one;
    target[k] = next;
    this.touched(target, k);
    return prefix ? next : old;
  }

  /** delete o[k] */
  pd(target: Any, key: unknown): boolean {
    const k = toKey(key);
    const ok = delete target[k];
    this.touched(target);
    return ok;
  }

  // ── calls ────────────────────────────────────────────────────────────────

  /** o[k](...args). After a built-in returns, re-read the objects it could have changed. */
  mc(target: Any, key: unknown, args: unknown[]): unknown {
    const k = toKey(key);
    const fn = target[k];
    if (typeof fn !== 'function') throw new TypeError(`${String(k)} is not a function`);
    const result = Reflect.apply(fn, target, args);
    if (!this.heap.busy && this.isNative(fn)) {
      this.heap.sync(target);
      for (const arg of args) this.heap.sync(arg);
      this.mutated();
    }
    return result;
  }

  /** User functions report their own mutations; only built-ins need a re-read. */
  private isNative(fn: object): boolean {
    let native = this.nativeCache.get(fn);
    if (native === undefined) {
      try {
        native = NATIVE.test(fnToString.call(fn));
      } catch {
        native = true;
      }
      this.nativeCache.set(fn, native);
    }
    return native;
  }

  // ── console ──────────────────────────────────────────────────────────────

  private log(level: LogLevel, args: unknown[]): void {
    if (this.heap.busy) return;
    this.guard();
    const encoded = args.map((arg) => this.heap.ser(arg));
    this.emit({ kind: 'log', level, args: encoded });
  }
}
