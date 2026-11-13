import { transform } from '@babel/standalone';
import type { SourceLoc } from '../types';
import { InstrumentError, toInstrumentError } from './errors';
import { createPlugin } from './plugin';

export { InstrumentError };

export interface Instrumented {
  /** Recording version of the program. Expects `$v` (the runtime) in scope. */
  code: string;
  /** Source ranges referenced by `TraceEvent.loc`. */
  locs: SourceLoc[];
}

/**
 * Rewrite a synchronous script so that running it reports every step,
 * call, variable write and heap mutation to a runtime object named `$v`.
 *
 * Pure and synchronous; safe to call on the main thread.
 * @throws InstrumentError on syntax errors and unsupported constructs.
 */
export function instrument(source: string): Instrumented {
  const locs: SourceLoc[] = [];
  try {
    const result = transform(source, {
      babelrc: false,
      configFile: false,
      sourceType: 'script',
      parserOpts: { strictMode: true },
      plugins: [createPlugin(locs)],
      comments: false,
      compact: false,
    });
    return { code: result?.code ?? '', locs };
  } catch (err) {
    throw toInstrumentError(err);
  }
}
