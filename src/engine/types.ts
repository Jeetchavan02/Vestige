/**
 * Wire format shared by the recorder (worker) and the replayer (main thread).
 * Everything here must survive structured clone and JSON round-trips.
 */

/**
 * A JavaScript value as it appears in the trace.
 *
 * JSON-safe primitives are stored inline. Anything that JSON cannot carry is
 * tagged. Objects and functions are never inlined: they live in the heap and
 * are referenced by id, so aliasing and cycles are preserved.
 */
export type Value =
  | number
  | string
  | boolean
  | null
  | { t: 'undefined' }
  | { t: 'number'; v: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'bigint'; v: string }
  | { t: 'symbol'; v: string }
  /** A getter/setter property. Never invoked by the recorder. */
  | { t: 'accessor' }
  | { t: 'ref'; id: number };

export type HeapType =
  | 'object'
  | 'array'
  | 'function'
  | 'map'
  | 'set'
  | 'error'
  | 'date'
  | 'regexp';

/** Shallow record of one heap object. Children are `ref` values. */
export interface HeapObject {
  type: HeapType;
  /** Own enumerable string-keyed data properties (array indices included). */
  props: Record<string, Value>;
  /** Class name, when the prototype is not Object.prototype / Array.prototype. */
  ctor?: string;
  /** Arrays only: `length`, which may exceed the number of recorded props. */
  length?: number;
  /** Map: [key, value] pairs. Set: [value] singletons. */
  entries?: Value[][];
  /** Functions, dates and regexps: a short display string. */
  preview?: string;
  /** Number of props/entries dropped by the size cap. */
  truncated?: number;
}

/**
 * One change to one heap object.
 * `alloc` replaces the whole record (first sighting, or a non-diffable change).
 * `set` / `del` / `length` patch the existing record.
 */
export interface HeapDelta {
  id: number;
  alloc?: HeapObject;
  set?: Record<string, Value>;
  del?: string[];
  length?: number;
}

/** A source range. Lines are 1-based, columns 0-based (Babel convention). */
export interface SourceLoc {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export type EventKind =
  | 'step' // a statement (or loop test) is about to run
  | 'enter' // a function invocation started; creates a scope and a frame
  | 'exit' // that invocation finished, by return or by throw
  | 'declare' // a binding was initialised
  | 'assign' // a binding was written
  | 'mutate' // heap changed with no variable write (property set, native call)
  | 'log'; // console output

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

/**
 * One captured execution event. The event's position in the trace array is
 * its timestamp; there is no separate sequence field.
 */
export interface TraceEvent {
  kind: EventKind;

  /** step, enter: index into the instrumenter's `locs` table. */
  loc?: number;

  /**
   * enter, exit, declare, assign: runtime scope id. One scope per function
   * invocation (scope 0 is the program). Writes through a closure carry the
   * id of the scope that owns the binding, not the scope that is running.
   */
  scope?: number;

  /** enter: lexical parent scope (closure environment). null for the program. */
  parent?: number | null;

  /** enter: function name. declare, assign: binding key (`x`, or `x#2` if shadowed). */
  name?: string;

  /** declare, assign: new value. exit: return value, or the thrown value. */
  value?: Value;

  /** exit: present when the frame was left by an exception. */
  threw?: true;

  /** log: console method used. */
  level?: LogLevel;

  /** log: console arguments. */
  args?: Value[];

  /**
   * Any kind: heap objects first seen or found changed while recording this
   * event. Applied before the event's own effect.
   */
  heap?: HeapDelta[];
}

/** Hard caps enforced inside the worker. */
export interface Limits {
  /** Recording stops (status `limit`) once this many events exist. */
  maxEvents: number;
  /** Events are posted to the main thread in chunks of this size. */
  batchSize: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxEvents: 200_000,
  batchSize: 5_000,
};
