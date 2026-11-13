# Vestige

A browser-based time-travel debugger for synchronous JavaScript. Runs entirely
client-side: no backend, no API keys.

This repository currently contains the **engine**: instrumentation, recording
and replay. The UI is not built yet.

## How it works

```
source ──instrument()──▶ recording code ──Web Worker──▶ TraceEvent[] ──Replayer──▶ state at any T
         Babel plugin                     sandbox        delta log      checkpoints
```

1. `instrument(source)` rewrites the program with a Babel plugin so that every
   statement, call, variable write and heap mutation reports to a runtime.
2. The rewritten code runs once in a locked-down, single-use Web Worker and
   streams a trace of delta events back to the page.
3. `Replayer` rebuilds the full program state (call stack, scopes, heap,
   console) at any event index, forwards or backwards.

The full design is in [docs/ENGINE.md](docs/ENGINE.md).

## Usage

```ts
import { trace, Replayer, currentLoc } from './src/engine';

const run = trace(`
  let total = 0;
  for (let i = 1; i <= 3; i++) total += i;
`);
const { status, events, locs } = await run.result;

const replayer = new Replayer(events);
const state = replayer.stateAt(10);          // any index, any order
state.stack;                                 // call stack
state.scopes.get(0)!.vars;                   // program-level variables
locs[currentLoc(state)];                     // source range being executed
```

`status` is one of `ok`, `error`, `limit`, `timeout`, `cancelled`, `crashed`
or `invalid`. `trace()` never throws.

## Supported JavaScript

Synchronous scripts only, run in strict mode. Rejected up front, with a line
and column: `async`/`await`, generators, `import`/`export`, dynamic `import()`,
`eval`, `with`. Not available at run time: timers, promises, DOM, network.

## Limits

| Limit | Default | Result |
| --- | --- | --- |
| Events per run | 200,000 | `limit`, trace keeps the first 200,000 |
| Wall-clock time | 5 s | `timeout`, worker is terminated |
| Props recorded per object | 200 | `truncated` count on the object |
| String length | 2,000 | cut, with a trailing `…` |

## Known gaps

- Loop-head `let` bindings are tracked per function call, not per iteration.
  A closure that captured `i` shows the latest `i`.
- Writes inside parameter default expressions are not recorded.
- Mutations made by a built-in to objects that are neither its receiver nor an
  argument show up the next time the object is recorded, not at the call.
- `this` is not shown inside derived-class constructors.

## Development

```bash
npm install
npm test          # engine tests, run in Node
npm run dev       # harness page; the engine is on window.vestige
npm run build
```

Stack: TypeScript, Vite, `@babel/standalone`, Web Workers. No framework.
