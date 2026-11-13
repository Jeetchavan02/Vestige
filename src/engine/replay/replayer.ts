import type { TraceEvent } from '../types';
import { applyEvent, cloneState, emptyState, type ProgramState } from './state';

export const DEFAULT_CHECKPOINT_INTERVAL = 512;

/**
 * Reconstructs program state at any point of a trace.
 *
 * The trace is a pure delta log. While events are appended, a full copy of
 * the state is kept every `interval` events. `stateAt(t)` starts from the
 * nearest earlier copy (or from wherever the last call left off, if that is
 * closer) and replays forward.
 *
 *   N = events, K = interval, S = size of one state
 *   append            O(1) amortised + O(S) every K events
 *   step forward      O(1)
 *   step back / seek  O(S + K)
 *   memory            O(N) events + O(N / K · S) checkpoints
 */
export class Replayer {
  private readonly events: TraceEvent[] = [];
  /** checkpoints[c] is the state after event c·K − 1; checkpoints[0] is empty. */
  private readonly checkpoints: ProgramState[] = [emptyState()];
  /** State after the last appended event; only ever moves forward. */
  private readonly tail: ProgramState = emptyState();
  private cursor: ProgramState | null = null;
  private readonly logIndices: number[] = [];

  constructor(
    events: TraceEvent[] = [],
    private readonly interval: number = DEFAULT_CHECKPOINT_INTERVAL,
  ) {
    if (!Number.isInteger(interval) || interval < 1) {
      throw new RangeError('Checkpoint interval must be a positive integer');
    }
    this.append(events);
  }

  /** Number of events. Valid times are -1 (before anything ran) to length − 1. */
  get length(): number {
    return this.events.length;
  }

  /** Extend the trace. Safe to call per worker batch while a run is in progress. */
  append(batch: TraceEvent[]): void {
    for (const event of batch) {
      const index = this.events.length;
      this.events.push(event);
      applyEvent(this.tail, event, index);
      if (event.kind === 'log') this.logIndices.push(index);
      if ((index + 1) % this.interval === 0) this.checkpoints.push(cloneState(this.tail));
    }
  }

  eventAt(index: number): TraceEvent | undefined {
    return this.events[index];
  }

  /** Indices of all `log` events; the first `state.logCount` are visible at that state. */
  get logs(): readonly number[] {
    return this.logIndices;
  }

  /**
   * State after events[0..t]. Out-of-range `t` is clamped.
   *
   * The returned object is the replayer's working copy: read it, do not
   * mutate it, and do not hold it across another `stateAt` call. Use
   * `snapshotAt` for a copy you can keep.
   */
  stateAt(t: number): ProgramState {
    const target = Math.max(-1, Math.min(Math.trunc(t), this.events.length - 1));
    const base = Math.floor((target + 1) / this.interval);
    const baseIndex = base * this.interval - 1;

    let state = this.cursor;
    if (!state || state.index > target || state.index < baseIndex) {
      state = this.cursor = cloneState(this.checkpoints[base]);
    }
    for (let i = state.index + 1; i <= target; i++) applyEvent(state, this.events[i], i);
    return state;
  }

  snapshotAt(t: number): ProgramState {
    return cloneState(this.stateAt(t));
  }
}
