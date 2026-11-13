import { DEFAULT_LIMITS, type Limits, type TraceEvent } from '../types';
import { isFromWorker, type RunError, type RunMessage, type WorkerStatus } from './protocol';

/**
 * timeout    the wall-clock budget ran out and the worker was killed
 * cancelled  `cancel()` was called
 * crashed    the worker failed to load or died outside user code
 */
export type SandboxStatus = WorkerStatus | 'timeout' | 'cancelled' | 'crashed';

export interface SandboxResult {
  status: SandboxStatus;
  /** Every event received before the run ended. Always a valid trace prefix. */
  events: TraceEvent[];
  error?: RunError;
  /** Execution time reported by the worker, or wall time if it never reported. */
  ms: number;
}

export interface SandboxOptions {
  limits?: Partial<Limits>;
  /** Wall-clock budget for user code, measured from the worker's `ready`. */
  timeoutMs?: number;
  /** Budget for the worker script itself to load. */
  bootTimeoutMs?: number;
  /** Called as chunks arrive, before the run finishes. */
  onBatch?: (events: TraceEvent[]) => void;
}

export interface SandboxRun {
  result: Promise<SandboxResult>;
  /** Kill the worker now. Resolves `result` with status `cancelled`. */
  cancel(): void;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_BOOT_TIMEOUT_MS = 10_000;

let counter = 0;

/**
 * Run instrumented code in a fresh worker. The promise always resolves and
 * the worker is always terminated, whatever the user code does.
 */
export function runInSandbox(code: string, options: SandboxOptions = {}): SandboxRun {
  const limits: Limits = { ...DEFAULT_LIMITS, ...options.limits };
  const runId = `run-${Date.now().toString(36)}-${(counter++).toString(36)}`;
  const events: TraceEvent[] = [];
  const started = performance.now();

  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'vestige-sandbox',
  });

  let settle!: (result: SandboxResult) => void;
  const result = new Promise<SandboxResult>((resolve) => (settle = resolve));
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;

  const finish = (status: SandboxStatus, error?: RunError, ms?: number) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    worker.terminate();
    settle({ status, events, error, ms: ms ?? performance.now() - started });
  };

  timer = setTimeout(() => finish('crashed'), options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS);

  worker.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (finished || !isFromWorker(message)) return;

    if (message.type === 'ready') {
      clearTimeout(timer);
      timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const run: RunMessage = { type: 'run', runId, code, limits };
      worker.postMessage(run);
      return;
    }
    if (message.runId !== runId) return;

    if (message.type === 'batch') {
      for (const item of message.events) events.push(item);
      options.onBatch?.(message.events);
    } else {
      finish(message.status, message.error, message.ms);
    }
  };

  worker.onerror = (event) => {
    event.preventDefault();
    finish('crashed', { name: 'WorkerError', message: event.message || 'Worker failed', loc: -1 });
  };

  return { result, cancel: () => finish('cancelled') };
}
