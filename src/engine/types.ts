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

