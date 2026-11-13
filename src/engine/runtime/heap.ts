import type { HeapDelta, HeapObject, Value } from '../types';

/** Per-object cap on recorded props / entries. */
export const MAX_PROPS = 200;
/** Longer strings are cut and suffixed with an ellipsis. */
export const MAX_STRING = 2_000;

const UNDEFINED: Value = Object.freeze({ t: 'undefined' as const });
const ACCESSOR: Value = Object.freeze({ t: 'accessor' as const });

const fnToString = Function.prototype.toString;

export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.t !== b.t) return false;
  if (a.t === 'ref') return a.id === (b as typeof a).id;
  return (a as { v?: string }).v === (b as { v?: string }).v;
}

function copy(record: HeapObject): HeapObject {
  return { ...record, props: { ...record.props } };
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * Turns live values into trace `Value`s and keeps a shadow copy of every heap
 * object that has been reported, so later changes can be sent as deltas.
 *
 * Objects are discovered lazily: an object enters the trace the first time a
 * recorded value can reach it. Deltas accumulate in `pending` until the
 * runtime attaches them to an event.
 */
export class HeapTracker {
  pending: HeapDelta[] = [];

  /**
   * True while user objects are being read. Reading can run user code (proxy
   * traps, `toString`), and that code is instrumented; the runtime ignores
   * hooks while this is set so serialisation never records itself.
   */
  busy = false;

  private readonly ids = new WeakMap<object, number>();
  private readonly shadow = new Map<number, HeapObject>();
  private queue: object[] = [];
  private nextId = 1;

  /** Encode a value, reporting any heap objects it newly reaches. */
  ser(value: unknown): Value {
    switch (typeof value) {
      case 'number':
        if (Object.is(value, -0)) return { t: 'number', v: '-0' };
        if (Number.isFinite(value)) return value;
        return { t: 'number', v: String(value) as 'NaN' | 'Infinity' | '-Infinity' };
      case 'string':
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
      case 'boolean':
        return value;
      case 'undefined':
        return UNDEFINED;
      case 'bigint':
        return { t: 'bigint', v: value.toString() };
      case 'symbol':
        return { t: 'symbol', v: value.description ?? '' };
      default:
        if (value === null) return null;
        return { t: 'ref', id: this.track(value as object) };
    }
  }

  /** Re-read a known object and report what changed. Unknown values are ignored. */
  sync(value: unknown): void {
    if (this.busy || !isObject(value)) return;
    const id = this.ids.get(value);
    if (id !== undefined) this.resync(value, id);
  }

  /**
   * Cheap path for `o[key] = v`: only that key (and an array's length) can
   * have changed, so skip the full diff.
   */
  syncKey(target: unknown, key: PropertyKey): void {
    if (this.busy || !isObject(target)) return;
    const id = this.ids.get(target);
    if (id === undefined) return;
    const old = this.shadow.get(id);
    const isArray = old?.type === 'array';
    const name = typeof key === 'symbol' ? null : String(key);
    const simple =
      old !== undefined &&
      name !== null &&
      (old.type === 'object' || isArray) &&
      old.truncated === undefined &&
      !(isArray && name === 'length');
    const descriptor = simple ? safeDescriptor(target, name) : undefined;
    if (!old || name === null || !descriptor) {
      this.resync(target, id);
      return;
    }

    const delta: HeapDelta = { id };
    let changed = false;
    this.busy = true;
    try {
      const next = 'value' in descriptor ? this.ser(descriptor.value) : ACCESSOR;
      if (!(name in old.props) || !sameValue(old.props[name], next)) {
        old.props[name] = next;
        delta.set = { [name]: next };
        changed = true;
      }
    } finally {
      this.busy = false;
    }
    if (isArray) {
      const length = (target as unknown[]).length;
      if (length !== old.length) {
        if (length > MAX_PROPS) {
          this.resync(target, id);
          return;
        }
        old.length = length;
        delta.length = length;
        changed = true;
      }
    }
    if (changed) this.pending.push(delta);
    this.drain();
  }

  private track(target: object): number {
    let id = this.ids.get(target);
    if (id !== undefined) {
      // A known object is being recorded again: catch any untracked changes.
      if (!this.busy) this.resync(target, id);
      return id;
    }
    id = this.nextId++;
    this.ids.set(target, id);
    this.queue.push(target);
    if (!this.busy) this.drain();
    return id;
  }

  /** Describe every queued object. Iterative, so deep structures cannot overflow the stack. */
  private drain(): void {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    try {
      for (let i = 0; i < this.queue.length; i++) {
        const target = this.queue[i];
        const id = this.ids.get(target)!;
        const record = this.describe(target);
        this.shadow.set(id, record);
        this.pending.push({ id, alloc: copy(record) });
      }
    } finally {
      this.queue = [];
      this.busy = false;
    }
  }

  private resync(target: object, id: number): void {
    const old = this.shadow.get(id);
    if (!old) return; // still queued for its first description
    let record: HeapObject;
    this.busy = true;
    try {
      record = this.describe(target);
    } finally {
      this.busy = false;
    }
    const delta = diff(id, old, record);
    if (delta) {
      this.shadow.set(id, record);
      this.pending.push(delta);
    }
    this.drain();
  }

  /** Shallow record of one object. Must be called with `busy` set. */
  private describe(target: object): HeapObject {
    try {
      return this.describeUnsafe(target);
    } catch {
      return { type: 'object', props: {}, preview: '[unreadable]' };
    }
  }

  private describeUnsafe(target: object): HeapObject {
    if (typeof target === 'function') {
      const isClass = /^class\b/.test(fnToString.call(target));
      const name = String(target.name || '(anonymous)');
      return { type: 'function', props: {}, preview: isClass ? `class ${name}` : `ƒ ${name}()` };
    }

    if (Array.isArray(target)) {
      const length = target.length;
      const limit = Math.min(length, MAX_PROPS);
      const record: HeapObject = { type: 'array', props: {}, length };
      for (let i = 0; i < limit; i++) {
        if (Object.hasOwn(target, i)) record.props[i] = this.ser(target[i]);
      }
      if (length > limit) record.truncated = length - limit;
      return record;
    }

    if (target instanceof Map || target instanceof Set) {
      const isMap = target instanceof Map;
      const record: HeapObject = { type: isMap ? 'map' : 'set', props: {}, entries: [] };
      let seen = 0;
      for (const entry of isMap ? target.entries() : target.values()) {
        if (seen++ >= MAX_PROPS) continue;
        record.entries!.push(
          isMap
            ? [this.ser((entry as [unknown, unknown])[0]), this.ser((entry as [unknown, unknown])[1])]
            : [this.ser(entry)],
        );
      }
      if (seen > MAX_PROPS) record.truncated = seen - MAX_PROPS;
      return record;
    }

    if (target instanceof Date) {
      const time = target.getTime();
      return {
        type: 'date',
        props: {},
        preview: Number.isNaN(time) ? 'Invalid Date' : target.toISOString(),
      };
    }

    if (target instanceof RegExp) {
      return { type: 'regexp', props: {}, preview: String(target) };
    }

    const record: HeapObject = { type: 'object', props: {} };
    if (target instanceof Error) {
      record.type = 'error';
      record.props.name = this.ser(target.name);
      record.props.message = this.ser(target.message);
    }
    const keys = Object.keys(target);
    const limit = Math.min(keys.length, MAX_PROPS);
    for (let i = 0; i < limit; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(target, keys[i]);
      if (!descriptor) continue;
      record.props[keys[i]] = 'value' in descriptor ? this.ser(descriptor.value) : ACCESSOR;
    }
    if (keys.length > limit) record.truncated = keys.length - limit;

    const proto = Object.getPrototypeOf(target);
    if (proto !== null && proto !== Object.prototype) {
      const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
      if (typeof ctor === 'function' && ctor.name) record.ctor = String(ctor.name);
    }
    return record;
  }
}

function safeDescriptor(target: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(target, key);
  } catch {
    return undefined;
  }
}

/** Smallest delta that turns `old` into `next`, or null when they are equal. */
function diff(id: number, old: HeapObject, next: HeapObject): HeapDelta | null {
  const patchable =
    old.type === next.type &&
    (next.type === 'object' || next.type === 'array' || next.type === 'error') &&
    old.ctor === next.ctor &&
    old.truncated === next.truncated;
  if (!patchable) {
    return JSON.stringify(old) === JSON.stringify(next) ? null : { id, alloc: copy(next) };
  }

  const delta: HeapDelta = { id };
  let changed = false;
  for (const key of Object.keys(next.props)) {
    if (key in old.props && sameValue(old.props[key], next.props[key])) continue;
    (delta.set ??= {})[key] = next.props[key];
    changed = true;
  }
  for (const key of Object.keys(old.props)) {
    if (key in next.props) continue;
    (delta.del ??= []).push(key);
    changed = true;
  }
  if (old.length !== next.length) {
    delta.length = next.length;
    changed = true;
  }
  return changed ? delta : null;
}
