import type { HeapDelta, HeapObject, TraceEvent, Value } from '../types';

/** One function invocation's variables. Outlives its frame while closures can see it. */
export interface ScopeState {
  id: number;
  /** Function name, `(main)` for the program. */
  name: string;
  /** Lexical parent, for walking the closure chain. */
  parent: number | null;
  /** Binding key → current value, in declaration order. */
  vars: Map<string, Value>;
}

/** One entry of the call stack. */
export interface Frame {
  scope: number;
  name: string;
  /** `locs` index this frame is currently at; a caller stays on its call site. */
  loc: number;
}

/** How the most recent frame was left. Cleared by the next step. */
export interface ExitInfo {
  scope: number;
  value?: Value;
  threw: boolean;
}

/** Everything observable about the program after some event T. */
export interface ProgramState {
  /** Index of the last applied event; -1 before the first. */
  index: number;
  /** Call stack, outermost first. */
  stack: Frame[];
  scopes: Map<number, ScopeState>;
  heap: Map<number, HeapObject>;
  /** Number of `log` events applied so far. */
  logCount: number;
  lastExit: ExitInfo | null;
}

export function emptyState(): ProgramState {
  return { index: -1, stack: [], scopes: new Map(), heap: new Map(), logCount: 0, lastExit: null };
}

function cloneHeapObject(object: HeapObject): HeapObject {
  // `entries` and Values are never mutated in place, so sharing them is safe.
  return { ...object, props: { ...object.props } };
}

/** Deep enough that the copy and the original can be mutated independently. */
export function cloneState(state: ProgramState): ProgramState {
  const scopes = new Map<number, ScopeState>();
  for (const [id, scope] of state.scopes) scopes.set(id, { ...scope, vars: new Map(scope.vars) });
  const heap = new Map<number, HeapObject>();
  for (const [id, object] of state.heap) heap.set(id, cloneHeapObject(object));
  return {
    index: state.index,
    stack: state.stack.map((frame) => ({ ...frame })),
    scopes,
    heap,
    logCount: state.logCount,
    lastExit: state.lastExit && { ...state.lastExit },
  };
}

function applyDelta(heap: Map<number, HeapObject>, delta: HeapDelta): void {
  if (delta.alloc) {
    heap.set(delta.id, cloneHeapObject(delta.alloc));
    return;
  }
  const object = heap.get(delta.id);
  if (!object) return;
  if (delta.set) Object.assign(object.props, delta.set);
  if (delta.del) for (const key of delta.del) delete object.props[key];
  if (delta.length !== undefined) object.length = delta.length;
}

/**
 * Advance `state` by one event, in place. This is the only place that defines
 * what each event kind means; events themselves are never modified.
 */
export function applyEvent(state: ProgramState, event: TraceEvent, index: number): void {
  if (event.heap) for (const delta of event.heap) applyDelta(state.heap, delta);

  switch (event.kind) {
    case 'step': {
      const top = state.stack[state.stack.length - 1];
      if (top && event.loc !== undefined) top.loc = event.loc;
      state.lastExit = null;
      break;
    }
    case 'enter': {
      const id = event.scope!;
      const name = event.name ?? '(anonymous)';
      state.scopes.set(id, { id, name, parent: event.parent ?? null, vars: new Map() });
      state.stack.push({ scope: id, name, loc: event.loc ?? -1 });
      state.lastExit = null;
      break;
    }
    case 'exit': {
      // Pop to the matching frame. Enter/exit are balanced by construction;
      // searching keeps replay sane on a trace cut off by the event limit.
      for (let i = state.stack.length - 1; i >= 0; i--) {
        if (state.stack[i].scope === event.scope) {
          state.stack.length = i;
          break;
        }
      }
      state.lastExit = { scope: event.scope!, value: event.value, threw: event.threw === true };
      break;
    }
    case 'declare':
    case 'assign':
      state.scopes.get(event.scope!)?.vars.set(event.name!, event.value!);
      break;
    case 'log':
      state.logCount++;
      break;
    case 'mutate':
      break;
  }
  state.index = index;
}

/** The `locs` index the program is at, or -1. */
export function currentLoc(state: ProgramState): number {
  return state.stack.length ? state.stack[state.stack.length - 1].loc : -1;
}
