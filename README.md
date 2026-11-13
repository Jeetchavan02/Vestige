# Vestige

A time-travel debugger for JavaScript that runs entirely in your browser. Run
your code once, then scrub backward and forward through every step and watch
the variables change. No backend, no account, no API keys.

**Try it: https://vestige-js-debugger.vercel.app**

## Using it

1. Pick an example (buggy bubble sort, Fibonacci, binary search) or write your
   own code in the editor.
2. Press **Run**. The whole execution is recorded.
3. Drag the timeline, click **←** / **→**, or press the Left / Right arrow
   keys to move one event at a time.

The editor highlights the line being executed. The inspector shows the
variables of the running function and every enclosing scope, and marks the
values that changed at the current step.

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

## Engine API

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
npm run dev       # the app; the engine is also on window.vestige
npm run build
```

Layout: `src/engine` (instrumenter, recorder, replayer, worker sandbox) and
`src/ui` (editor, inspector, timeline). The UI only talks to the engine
through `trace()` and `Replayer`.

Stack: TypeScript, Vite, `@babel/standalone`, CodeMirror 6, Web Workers. No
framework.

## Deployment

The site is a static Vite build hosted on Vercel.

```bash
npx vercel --prod
```
