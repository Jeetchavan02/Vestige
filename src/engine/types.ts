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

