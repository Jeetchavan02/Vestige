import { LIMIT, Runtime } from '../runtime/runtime';
import type { Limits, TraceEvent } from '../types';
import type { RunError, WorkerStatus } from './protocol';

/**
 * Globals hidden from user code by declaring them as parameters of the
 * wrapper function. A program that names one of these gets `undefined`.
 * `lockdown()` removes the same capabilities from the real global object;
 * this list is the first of the two layers.
 */
export const SHADOWED = [
  'self', 'globalThis', 'window', 'postMessage', 'close', 'onmessage', 'addEventListener',
  'removeEventListener', 'dispatchEvent', 'importScripts', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'EventSource', 'WebTransport', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Worker',
  'SharedWorker', 'navigator', 'location', 'indexedDB', 'caches', 'setTimeout', 'setInterval',
  'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame',
  'Promise', 'Function', 'WebAssembly', 'Atomics', 'SharedArrayBuffer', 'process', 'require',
] as const;

// Captured at module load: lockdown() later removes the global binding.
const NativeFunction = Function;

export interface ExecuteResult {
  status: WorkerStatus;
  error?: RunError;
  total: number;
  ms: number;
}

function describeError(err: unknown, loc: number): RunError {
  try {
    if (err instanceof Error) return { name: String(err.name), message: String(err.message), loc };
    return { name: 'Uncaught', message: String(err), loc };
  } catch {
    return { name: 'Uncaught', message: '(unprintable value)', loc };
  }
}

/**
 * Run instrumented code to completion and stream its trace to `onBatch`.
 * Synchronous: when this returns, every event has been delivered.
 *
 * User code runs in strict mode with `this === undefined`, so a plain
 * function call cannot reach the global object.
 */
export function execute(
  code: string,
  limits: Limits,
  onBatch: (events: TraceEvent[]) => void,
): ExecuteResult {
  const runtime = new Runtime(limits, onBatch);
  const start = performance.now();
  let status: WorkerStatus = 'ok';
  let error: RunError | undefined;

  try {
    const program = new NativeFunction('$v', 'console', ...SHADOWED, `"use strict";\n${code}`);
    program.call(undefined, runtime, runtime.console);
  } catch (err) {
    if (err === LIMIT || runtime.limitReached) {
      status = 'limit';
    } else {
      status = 'error';
      error = describeError(err, runtime.lastLoc);
    }
  }

  runtime.flush();
  return { status, error, total: runtime.count, ms: performance.now() - start };
}
