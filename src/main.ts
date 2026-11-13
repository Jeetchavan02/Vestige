import * as engine from './engine';

/**
 * Engine harness. Exposes the engine on `window.vestige` so it can be driven
 * from the devtools console until the UI exists:
 *
 *   const r = await vestige.trace('let a = 1; a++;').result
 *   new vestige.Replayer(r.events).stateAt(2)
 */
declare global {
  interface Window {
    vestige: typeof engine;
  }
}

window.vestige = engine;
