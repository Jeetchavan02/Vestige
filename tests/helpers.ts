import { instrument } from '../src/engine/instrument';
import { Replayer } from '../src/engine/replay/replayer';
import type { ProgramState } from '../src/engine/replay/state';
import { execute, type ExecuteResult } from '../src/engine/sandbox/execute';
import { DEFAULT_LIMITS, type Limits, type SourceLoc, type TraceEvent, type Value } from '../src/engine/types';

export interface Recorded extends ExecuteResult {
  events: TraceEvent[];
  locs: SourceLoc[];
  code: string;
  replayer: Replayer;
  /** State after the last event. */
  final: ProgramState;
}

/** Instrument and run in-process: the same path the worker takes, minus the worker. */
export function record(source: string, limits: Partial<Limits> = {}): Recorded {
  const { code, locs } = instrument(source);
  const events: TraceEvent[] = [];
  const result = execute(code, { ...DEFAULT_LIMITS, ...limits }, (batch) => events.push(...batch));
  const replayer = new Replayer(events);
  return { ...result, events, locs, code, replayer, final: replayer.snapshotAt(events.length - 1) };
}

/** Rebuild a plain JS value from the replayed heap, for readable assertions. */
export function decode(state: ProgramState, value: Value | undefined, seen = new Map<number, unknown>()): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  switch (value.t) {
    case 'undefined':
      return undefined;
    case 'number':
      return value.v === '-0' ? -0 : Number(value.v);
    case 'bigint':
      return BigInt(value.v);
    case 'symbol':
      return `Symbol(${value.v})`;
    case 'accessor':
      return '<accessor>';
    case 'ref': {
      if (seen.has(value.id)) return seen.get(value.id);
      const object = state.heap.get(value.id);
      if (!object) throw new Error(`dangling heap ref ${value.id}`);
      if (object.type === 'array') {
        const out: unknown[] = [];
        seen.set(value.id, out);
        out.length = object.length ?? 0;
        for (const [key, item] of Object.entries(object.props)) out[Number(key)] = decode(state, item, seen);
        return out;
      }
      if (object.type === 'map' || object.type === 'set') {
        const entries = (object.entries ?? []).map((entry) => entry.map((item) => decode(state, item, seen)));
        const out = object.type === 'map' ? new Map(entries as [unknown, unknown][]) : new Set(entries.map((e) => e[0]));
        seen.set(value.id, out);
        return out;
      }
      if (object.type === 'function' || object.type === 'date' || object.type === 'regexp') {
        return object.preview;
      }
      const out: Record<string, unknown> = {};
      seen.set(value.id, out);
      for (const [key, item] of Object.entries(object.props)) out[key] = decode(state, item, seen);
      return out;
    }
  }
}

/** Decoded variables of a scope (default: the program scope). */
export function vars(state: ProgramState, scope = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of state.scopes.get(scope)?.vars ?? []) out[name] = decode(state, value);
  return out;
}

/** Decoded console output visible at `state`. */
export function logs(recorded: Recorded, state: ProgramState = recorded.final): unknown[][] {
  return recorded.replayer.logs
    .slice(0, state.logCount)
    .map((index) => (recorded.events[index].args ?? []).map((arg) => decode(state, arg)));
}

/** Run the original, uninstrumented source and capture what it logs. */
export function runNative(source: string): { logs: unknown[][]; error?: string } {
  const out: unknown[][] = [];
  const log = (...args: unknown[]) => out.push(args);
  const console = { log, info: log, warn: log, error: log, debug: log };
  try {
    new Function('console', `"use strict";\n${source}`)(console);
    return { logs: out };
  } catch (err) {
    return { logs: out, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}
