import { SHADOWED } from './execute';

/** Not shadowable as parameter names in strict mode, but still removed from the global. */
const EXTRA = ['eval'];

function blocked(): never {
  throw new TypeError('Dynamic code evaluation is disabled in the Vestige sandbox');
}

/**
 * Second sandbox layer: strip the worker's global object of everything that
 * reaches outside the worker or schedules work after the run.
 *
 * Shadowing alone is not enough, because `(function(){}).constructor` is the
 * Function constructor, and code it compiles runs in the global scope. So the
 * `constructor` link on every function prototype is cut, and the globals that
 * such code could have reached are gone anyway.
 *
 * Call once, after the worker has captured the references it needs
 * (`postMessage`), and before any user code runs. Irreversible by design.
 */
export function lockdown(scope: object): void {
  // Collected first: the loop below removes the global `Function` binding.
  const prototypes: object[] = [Object.getPrototypeOf(function () {})];
  try {
    // Reached through syntax, so they exist even though the instrumenter
    // rejects async and generator functions in user code.
    prototypes.push(
      Object.getPrototypeOf(async function () {}),
      Object.getPrototypeOf(function* () {}),
      Object.getPrototypeOf(async function* () {}),
    );
  } catch {
    // Older engines without these forms have nothing to patch.
  }
  for (const name of [...SHADOWED, ...EXTRA]) {
    try {
      Object.defineProperty(scope, name, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Non-configurable on this platform; the parameter shadow still applies.
    }
  }

  for (const proto of prototypes) {
    try {
      Object.defineProperty(proto, 'constructor', {
        value: blocked,
        writable: false,
        configurable: false,
      });
    } catch {
      // Already locked.
    }
  }
}
