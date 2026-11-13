import { instrument, InstrumentError } from './instrument';
import { runInSandbox, type SandboxOptions, type SandboxResult, type SandboxRun } from './sandbox/runner';
import type { SourceLoc } from './types';

export * from './types';
export { instrument, InstrumentError } from './instrument';
export type { Instrumented } from './instrument';
export { Replayer, DEFAULT_CHECKPOINT_INTERVAL } from './replay/replayer';
export { currentLoc } from './replay/state';
export type { ExitInfo, Frame, ProgramState, ScopeState } from './replay/state';
export { runInSandbox, DEFAULT_TIMEOUT_MS } from './sandbox/runner';
export type { SandboxOptions, SandboxResult, SandboxRun, SandboxStatus } from './sandbox/runner';
export type { RunError } from './sandbox/protocol';

export interface TraceResult extends Omit<SandboxResult, 'status'> {
  /** `invalid`: the source was rejected before running; see `error`. */
  status: SandboxResult['status'] | 'invalid';
  /** Source ranges for `TraceEvent.loc`. Empty when `invalid`. */
  locs: SourceLoc[];
  /** `invalid` only: where the problem is in the source. */
  errorLine?: number;
  errorColumn?: number;
}

export interface TraceRun {
  result: Promise<TraceResult>;
  cancel(): void;
}

/**
 * Source text in, trace out: instrument on the calling thread, then record in
 * a fresh sandbox worker. Never throws; failures are reported in the result.
 */
export function trace(source: string, options: SandboxOptions = {}): TraceRun {
  let instrumented;
  try {
    instrumented = instrument(source);
  } catch (err) {
    const e = err instanceof InstrumentError ? err : new InstrumentError(String(err));
    const result: TraceResult = {
      status: 'invalid',
      events: [],
      locs: [],
      ms: 0,
      error: { name: 'SyntaxError', message: e.message, loc: -1 },
      errorLine: e.line,
      errorColumn: e.column,
    };
    return { result: Promise.resolve(result), cancel() {} };
  }

  const { locs } = instrumented;
  const run: SandboxRun = runInSandbox(instrumented.code, options);
  return {
    result: run.result.then((sandbox) => ({ ...sandbox, locs })),
    cancel: run.cancel,
  };
}
