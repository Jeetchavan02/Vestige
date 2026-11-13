import type { Limits, TraceEvent } from '../types';

/**
 * Main thread ⇄ sandbox worker protocol.
 *
 * A worker handles exactly one run and is then terminated. A fresh global
 * environment per run means user code that patches built-ins cannot affect
 * the next run, and `terminate()` is the only cancellation mechanism needed.
 */

// ── main → worker ──────────────────────────────────────────────────────────

export interface RunMessage {
  type: 'run';
  /** Echoed on every reply; the main thread drops replies with another id. */
  runId: string;
  /** Output of `instrument()`. The worker never sees the original source. */
  code: string;
  limits: Limits;
}

export type ToWorker = RunMessage;

// ── worker → main ──────────────────────────────────────────────────────────

/** The worker script has loaded and is waiting for `run`. */
export interface ReadyMessage {
  type: 'ready';
}

/** A chunk of the trace, in order. Sent while user code is still running. */
export interface BatchMessage {
  type: 'batch';
  runId: string;
  events: TraceEvent[];
}

/**
 * ok     the program ran to completion
 * error  the program threw and nothing caught it
 * limit  `limits.maxEvents` was reached; the trace is a valid prefix
 */
export type WorkerStatus = 'ok' | 'error' | 'limit';

export interface RunError {
  name: string;
  message: string;
  /** `locs` index of the last step before the error, or -1. */
  loc: number;
}

/** Always the last message of a run. */
export interface DoneMessage {
  type: 'done';
  runId: string;
  status: WorkerStatus;
  error?: RunError;
  /** Number of events sent across all batches. */
  total: number;
  /** Execution time inside the worker. */
  ms: number;
}

export type FromWorker = ReadyMessage | BatchMessage | DoneMessage;

/**
 * Worker messages are untrusted input: user code shares the worker's realm.
 * Accept only well-formed messages and treat every string in them as data.
 */
export function isFromWorker(data: unknown): data is FromWorker {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      return true;
    case 'batch':
      return typeof msg.runId === 'string' && Array.isArray(msg.events);
    case 'done':
      return (
        typeof msg.runId === 'string' &&
        (msg.status === 'ok' || msg.status === 'error' || msg.status === 'limit') &&
        typeof msg.total === 'number'
      );
    default:
      return false;
  }
}
