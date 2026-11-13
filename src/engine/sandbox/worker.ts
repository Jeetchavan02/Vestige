import { execute } from './execute';
import { lockdown } from './lockdown';
import type { FromWorker, ToWorker } from './protocol';

interface WorkerScope {
  postMessage(message: FromWorker): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as WorkerScope;

// Bound before lockdown removes `postMessage` from the global object.
const post = scope.postMessage.bind(scope);
let used = false;

scope.addEventListener('message', (event) => {
  const message = event.data;
  // One run per worker. Anything else is ignored, never interpreted.
  if (used || !message || message.type !== 'run') return;
  if (typeof message.code !== 'string' || typeof message.runId !== 'string') return;
  used = true;

  const { runId, code, limits } = message;
  lockdown(self);
  const result = execute(code, limits, (events) => post({ type: 'batch', runId, events }));
  post({ type: 'done', runId, ...result });
});

post({ type: 'ready' });
