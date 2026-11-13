# VESTIGE engine spec

Source of truth is the code in `src/engine`. Section → module:

| § | Module |
|---|--------|
| 1 | `instrument/` |
| 2 | `types.ts` |
| 3, 4 | `replay/` |
| 5 | `sandbox/` |

## 1. Babel visitor spec

```ts
// Parse: sourceType 'script', strictMode true. Runs on the main thread, pure.
// All rewriting on node EXIT (children first). Injected nodes are never revisited.
// $v   = runtime object, passed into the program wrapper
// $sN  = `const` at the top of function N's body holding that invocation's
//        runtime scope id. Inner functions name the outer $sN; closure capture
//        resolves it to the correct invocation. Program is $s0.

// ── PRE-PASS (Program.enter) ───────────────────────────────────────────────
// validate  → throw InstrumentError{message,line,column}
//   Function[async|generator], AwaitExpression, YieldExpression, for-await,
//   ImportExpression, import.meta, referenced `eval`, identifiers /^\$(v|e|s\d+)$/
//   (import/export/with/legacy octal: already parse errors)
// normalize → arrow `x => e`      ⇒ `x => { return e; }`
//             if/else/loop bodies ⇒ BlockStatement
//             DebuggerStatement   ⇒ removed
// keys      → every binding gets a key unique in its owning function:
//             first `x` = "x", block-scoped shadows = "x#2", "x#3"

// ── NODE TYPE            INJECTED                                   WHY ─────
// Program                const $s0 = $v.enter("(main)", null, loc);  root frame + scope
//                        try { BODY }
//                        catch ($e) { throw $v.x($s0, $e); }
//                        finally { $v.exit($s0); }
//
// Function (all 6 kinds) const $sN = $v.enter(name, $sParent, loc);  call stack; one scope per
//                        try {                                       invocation; finally ⇒ exactly
//                          $v.d($sN, "p", p);      // each param     one exit per enter, even on
//                          $v.d($sN, "this", this) // if used        throw
//                          BODY
//                        } catch ($e) { throw $v.x($sN, $e); }
//                        finally { $v.exit($sN); }
//
// ReturnStatement        return $v.r($sN, ARG);                      return value for `exit`
//
// Statement lists        $v.s(loc); STMT                             the timeline: one step per
//  (Block, Program,       for: Expression, VariableDeclaration,      statement about to run
//   SwitchCase,                Return, Throw, Break, Continue, If,
//   StaticBlock)               Switch, For, ForIn, ForOf, ClassDeclaration
//
// VariableDeclaration    STMT; $v.d($s, "x", x);  // per binding id  value after initialisation
// ClassDeclaration       STMT; $v.d($s, "C", C);                     (destructuring included)
// FunctionDeclaration    $v.d($s, "f", f);  // top of its block      hoisted: visible from start
// CatchClause            catch (e) { $v.d($s, "e", e); … }
//
// ForStatement           for (let i = $v.d($s,"i",INIT);             head decl cannot take a
//                             ($v.s(loc), TEST); UPDATE) {…}         trailing statement; test
//                        no TEST ⇒ $v.s(loc) at top of body          carries the per-iteration step
// ForIn / ForOf          { $v.s(loc); $v.d($s, "x", x); … }          binding changes each iteration
// While / DoWhile        while (($v.s(loc), TEST))                   per-iteration step
//
// AssignmentExpression
//   x = v, x += v        $v.w($s, "x", x = v)                        variable write
//   [a, b] = v           $v.after([a, b] = v, $v.w($s,"a",a), …)
//   o.k = v              $v.ps(o, "k", v)                            runtime performs the write:
//   o.k += v             $v.pc(o, "k", "+=", v)                      only way to learn WHICH object
//   o.k ??= v            $v.pl(o, "k", "??=", () => v)               without evaluating `o` twice
// UpdateExpression
//   x++                  $v.after(x++, $v.w($s, "x", x))
//   o.k++                $v.pu(o, "k", "++", /*prefix*/ false)
// UnaryExpression delete $v.pd(o, "k")
// CallExpression o.m(a)  $v.mc(o, "m", [a])                          built-ins (push, sort, set,
//                                                                    Object.assign) mutate with no
//                                                                    assignment in the source;
//                                                                    runtime re-reads receiver +
//                                                                    args after a NATIVE call
// super.x = / this.#x =  $v.after(EXPR, $v.sync(this))               not expressible as (obj, key)

// ── SKIPPED               WHY ────────────────────────────────────────────────
// Identifier reads         state is reconstructed from writes; reads add volume, no information
// Binary/Logical/Literal…  pure; result surfaces at the write that consumes it
// f(x) (non-member call)   callee `enter` already records it; no receiver to re-sync
// NewExpression            constructor `enter` records it; object appears at first write
// Optional call a?.b()     short-circuit semantics; receiver re-synced when next recorded
// BlockStatement, Try,     containers; their children step
//   Labeled, Empty
// Code in param defaults   $sN is declared in the body and is not in scope there
// Per-iteration `let`      loop bindings are keyed per function invocation, not per iteration;
//   copies                 closures capturing a loop variable show its latest value
```

## 2. Event interface

```ts
type Value =
  | number | string | boolean | null              // JSON-safe: inline
  | { t: 'undefined' }
  | { t: 'number'; v: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'bigint'; v: string }
  | { t: 'symbol'; v: string }
  | { t: 'accessor' }                             // getter/setter; never invoked
  | { t: 'ref'; id: number };                     // heap object; keeps aliasing + cycles

interface HeapObject {
  type: 'object' | 'array' | 'function' | 'map' | 'set' | 'error' | 'date' | 'regexp';
  props: Record<string, Value>;   // own enumerable data props; shallow
  ctor?: string;                  // class name; absent for plain objects/arrays
  length?: number;                // arrays only
  entries?: Value[][];            // map: [k, v]; set: [v]
  preview?: string;               // function / date / regexp display string
  truncated?: number;             // items dropped by the 200-per-object cap
}

interface HeapDelta {
  id: number;
  alloc?: HeapObject;             // whole record: first sighting, or non-patchable change
  set?: Record<string, Value>;    // patch: changed/added keys
  del?: string[];                 // patch: removed keys
  length?: number;                // patch: new array length
}

type EventKind = 'step' | 'enter' | 'exit' | 'declare' | 'assign' | 'mutate' | 'log';

interface TraceEvent {              // timestamp = index in Event[]
  kind: EventKind;                  // required
  loc?: number;                     // step, enter      → index into locs[]; others inherit position
  scope?: number;                   // enter, exit, declare, assign → runtime scope id (owner of the
                                    //   binding, not the running frame); step/mutate/log have none
  parent?: number | null;           // enter            → lexical parent scope; null = program
  name?: string;                    // enter: function name │ declare, assign: binding key
  value?: Value;                    // declare, assign: new value │ exit: return or thrown value;
                                    //   absent on exit = fell off the end
  threw?: true;                     // exit             → left by exception; absent = normal
  level?: 'log' | 'info' | 'warn' | 'error';   // log
  args?: Value[];                   // log
  heap?: HeapDelta[];               // any kind         → heap changes observed while recording
                                    //   this event; apply BEFORE the event; absent = none
}

interface SourceLoc { line: number; column: number; endLine: number; endColumn: number }
// locs: SourceLoc[] is returned by instrument(); interned so events carry one int
```

## 3. Snapshot strategy

```ts
// RECORDING (worker)            pure deltas. No state snapshots cross postMessage.
//   variables                   one event per write
//   heap                        worker keeps a shadow copy per reported object:
//                                 first reach   → alloc (shallow; children by ref)
//                                 o[k] = v      → compare that key + length   O(1)
//                                 native call   → shallow diff receiver + args O(size)
//                                 re-recorded   → shallow diff (catches untracked change)
//
// REPLAY (main)                 full-state checkpoint every K = 512 events, built while
//                               events are appended. Nothing else is stored.
//
// TRADEOFF                      seek      memory            build
//   deltas only                 O(N)      O(N)              —
//   snapshot every event        O(1)      O(N·S)            O(N·S)
//   checkpoint every K   ◄──    O(S+K)    O(N + N/K·S)      O(N + N/K·S)
//   deltas + inverse deltas     O(1) ±1   O(2N)             needs old values in every event
//
// 72-HOUR CHOICE                checkpoint every K. One apply(state, event) function is the
//                               entire semantics; checkpoints are clone(state). No undo log,
//                               no persistent data structures. Cap: 200k events ⇒ ≤ 391
//                               checkpoints.
```

## 4. Replay algorithm

```ts
interface ProgramState {
  index: number;                          // last applied event; -1 = nothing ran
  stack: { scope: number; name: string; loc: number }[];   // outermost first
  scopes: Map<number, { id: number; name: string; parent: number | null; vars: Map<string, Value> }>;
  heap: Map<number, HeapObject>;
  logCount: number;                       // visible console lines = logs[0 .. logCount)
  lastExit: { scope: number; value?: Value; threw: boolean } | null;
}

function apply(S: ProgramState, e: TraceEvent, i: number) {
  for (d of e.heap ?? [])
    if (d.alloc)  S.heap.set(d.id, copy(d.alloc))
    else          o = S.heap.get(d.id); assign(o.props, d.set); remove(o.props, d.del);
                  if (d.length != null) o.length = d.length
  switch (e.kind) {
    case 'step':    top(S.stack).loc = e.loc; S.lastExit = null
    case 'enter':   S.scopes.set(e.scope, { id: e.scope, name: e.name, parent: e.parent, vars: new Map })
                    S.stack.push({ scope: e.scope, name: e.name, loc: e.loc })
    case 'exit':    pop S.stack through the frame with scope === e.scope   // scope itself stays:
                    S.lastExit = { scope: e.scope, value: e.value, threw: !!e.threw }  // closures
    case 'declare':
    case 'assign':  S.scopes.get(e.scope).vars.set(e.name, e.value)
    case 'log':     S.logCount++
    case 'mutate':  // heap deltas only
  }
  S.index = i
}

class Replayer {
  events: TraceEvent[]; checkpoints: ProgramState[] = [empty]   // checkpoints[c].index = c·K − 1
  tail: ProgramState = empty; cursor: ProgramState | null

  append(batch) {                         // call per worker batch
    for (e of batch) {
      i = events.length; events.push(e); apply(tail, e, i)
      if ((i + 1) % K === 0) checkpoints.push(clone(tail))
    }
  }

  stateAt(T) {
    T = clamp(T, -1, events.length - 1)
    c = floor((T + 1) / K)
    if (!cursor || cursor.index > T || cursor.index < c·K − 1)
      cursor = clone(checkpoints[c])      // going back, or a later checkpoint is closer
    for (i = cursor.index + 1; i <= T; i++) apply(cursor, events[i], i)
    return cursor                         // working copy: read-only, valid until next call
  }
}

// N events, K interval, S state size
//   append             O(1) amortised, + O(S) every K events
//   stateAt(T+1)       O(1)                      step forward
//   stateAt(T−1)       O(S + K)                  step back
//   stateAt(random)    O(S + K)
//   memory             O(N) + O(N/K · S)
// K↓ ⇒ faster back-step, more memory.  K↑ ⇒ the reverse.  K = 512.
```

## 5. Worker sandbox contract

```ts
// One worker per run. Created → 'ready' → 'run' → 'batch'* → 'done' → terminate().
// Never reused: user code may have patched built-ins.

// main → worker
type ToWorker =
  | { type: 'run'; runId: string; code: string /* instrumented */; limits: Limits };
interface Limits { maxEvents: number /* 200_000 */; batchSize: number /* 5_000 */ }

// worker → main
type FromWorker =
  | { type: 'ready' }
  | { type: 'batch'; runId: string; events: TraceEvent[] }      // in order, while still running
  | { type: 'done';  runId: string;
      status: 'ok' | 'error' | 'limit';
      error?: { name: string; message: string; loc: number };   // status 'error'
      total: number; ms: number };                              // always last

// main-side result
type SandboxStatus = 'ok' | 'error' | 'limit' | 'timeout' | 'cancelled' | 'crashed';
interface SandboxResult { status: SandboxStatus; events: TraceEvent[]; error?: RunError; ms: number }

// MAIN THREAD MUST
//   start the timeout (5 s) at 'ready'; on expiry terminate() → 'timeout', keep received events
//   validate every message shape; drop anything with a foreign runId
//   treat all strings from the worker as data (textContent, never innerHTML)
//   terminate() on done / timeout / cancel / onerror — the promise always resolves

// WORKER MUST
//   accept exactly one 'run'; ignore everything else
//   bind postMessage, then lockdown(), then run:
//       new Function('$v', 'console', ...SHADOWED, '"use strict";\n' + code)
//           .call(undefined, runtime, runtime.console)
//   stop at maxEvents by throwing a sentinel that every later hook re-throws
//     (user try/catch/finally cannot outrun it; every loop iteration passes a hook)
//   flush remaining events, then post 'done'

// USER CODE MUST NEVER BE ABLE TO
//   reach the network        fetch, XMLHttpRequest, WebSocket, EventSource, importScripts, …
//   talk to the page         postMessage, onmessage, BroadcastChannel, MessageChannel
//   outlive its run          setTimeout, setInterval, queueMicrotask, Promise
//   spawn or persist         Worker, SharedWorker, indexedDB, caches
//   reach the global object  self, globalThis; `this` is undefined (strict)
//   compile code             eval rejected statically; Function removed;
//                            (function(){}).constructor replaced with a thrower
//   forge a result           'done' is built by the worker after user code returns;
//                            main trusts only shape-checked fields
//   hang the tab             event limit inside, terminate() outside
//
// Layers: (1) instrumenter rejects async/eval/import  (2) names shadowed as wrapper params
//         (3) same names defined undefined, non-configurable, on the worker global
//         (4) terminate().
// Threat model: the user's own code in the user's own tab. Not a boundary against hostile code.
```
