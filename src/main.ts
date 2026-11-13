import * as engine from './engine';
import './style.css';
import { mountApp } from './ui/app';

declare global {
  interface Window {
    /** The engine, for poking at from the devtools console. */
    vestige: typeof engine;
  }
}

window.vestige = engine;
mountApp(document.getElementById('app')!);
