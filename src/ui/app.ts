import { currentLoc, Replayer, trace, type SourceLoc, type TraceResult } from '../engine';
import { createEditor } from './editor';
import { EXAMPLES } from './examples';
import { createInspector } from './inspector';

/** Rewind mark: a clock face inside a counter-clockwise arrow. */
const LOGO = `<svg class="logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.4"/><path d="M3.5 3.6v4.8h4.8"/><path d="M12 7.5V12l3 2"/></svg>`;

function describe(result: TraceResult): { text: string; bad: boolean } {
  const count = `${result.events.length.toLocaleString()} events`;
  switch (result.status) {
    case 'ok':
      return { text: count, bad: false };
    case 'invalid':
      return { text: `Line ${result.errorLine ?? '?'}: ${result.error?.message ?? 'invalid code'}`, bad: true };
    case 'error':
      return { text: `${count} · ${result.error?.name}: ${result.error?.message}`, bad: true };
    case 'limit':
      return { text: `${count} · stopped at the event limit`, bad: true };
    case 'timeout':
      return { text: `${count} · timed out`, bad: true };
    default:
      return { text: `${count} · ${result.status}`, bad: true };
  }
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <header class="topbar">
      <h1 class="brand">${LOGO}Vestige</h1>
      <select class="examples" aria-label="Example program"></select>
      <button class="run" type="button">Run</button>
      <span class="counter" role="status">Not run yet</span>
    </header>
    <main class="panels">
      <div class="editor"></div>
      <aside class="inspector" aria-label="Variables"></aside>
    </main>
    <footer class="timeline">
      <button class="step step-back" type="button" disabled aria-label="Step back one event">←</button>
      <button class="step step-forward" type="button" disabled aria-label="Step forward one event">→</button>
      <input class="scrubber" type="range" min="0" max="0" value="0" step="1" disabled aria-label="Timeline" />
      <span class="position">0 / 0</span>
    </footer>`;

  const runButton = root.querySelector<HTMLButtonElement>('.run')!;
  const counter = root.querySelector<HTMLElement>('.counter')!;
  const scrubber = root.querySelector<HTMLInputElement>('.scrubber')!;
  const position = root.querySelector<HTMLElement>('.position')!;
  const stepBack = root.querySelector<HTMLButtonElement>('.step-back')!;
  const stepForward = root.querySelector<HTMLButtonElement>('.step-forward')!;
  const examples = root.querySelector<HTMLSelectElement>('.examples')!;
  for (const [index, example] of EXAMPLES.entries()) examples.add(new Option(example.name, String(index)));
  const editor = createEditor(root.querySelector<HTMLElement>('.editor')!, EXAMPLES[0].code);
  const inspector = createInspector(root.querySelector<HTMLElement>('.inspector')!);

  let replayer: Replayer | null = null;
  let locs: SourceLoc[] = [];

  /** Show the program as it was after event `index`. */
  const show = (index: number) => {
    if (!replayer) return;
    const state = replayer.stateAt(index);
    inspector.render(state);
    editor.highlightLine(locs[currentLoc(state)]?.line ?? null);
    position.textContent = `${(index + 1).toLocaleString()} / ${replayer.length.toLocaleString()}`;
    stepBack.disabled = index <= 0;
    stepForward.disabled = index >= replayer.length - 1;
  };

  /** Move the timeline by one event in either direction. */
  const step = (delta: number) => {
    if (!replayer) return;
    const next = Math.max(0, Math.min(replayer.length - 1, Number(scrubber.value) + delta));
    if (next === Number(scrubber.value)) return;
    scrubber.value = String(next);
    show(next);
  };

  const clearTrace = () => {
    replayer = null;
    locs = [];
    scrubber.disabled = true;
    scrubber.max = '0';
    scrubber.value = '0';
    position.textContent = '0 / 0';
    stepBack.disabled = true;
    stepForward.disabled = true;
    inspector.render(null);
  };

  const run = async () => {
    runButton.disabled = true;
    counter.textContent = 'Running…';
    counter.classList.remove('bad');
    clearTrace();
    editor.highlightLine(null);

    const result = await trace(editor.getCode()).result;
    const summary = describe(result);
    counter.textContent = summary.text;
    counter.classList.toggle('bad', summary.bad);
    runButton.disabled = false;
    if (result.events.length === 0) return;

    replayer = new Replayer(result.events);
    locs = result.locs;
    const last = replayer.length - 1;
    scrubber.max = String(last);
    scrubber.value = String(last);
    scrubber.disabled = false;
    show(last);
    scrubber.focus();
  };

  runButton.addEventListener('click', run);
  scrubber.addEventListener('input', () => show(Number(scrubber.value)));
  stepBack.addEventListener('click', () => step(-1));
  stepForward.addEventListener('click', () => step(1));
  // Arrow keys step from anywhere except where they already mean something:
  // the editor (caret), the dropdown (options) and the scrubber (native step).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('.cm-editor, select, input')) return;
    event.preventDefault();
    step(event.key === 'ArrowLeft' ? -1 : 1);
  });
  examples.addEventListener('change', () => {
    editor.setCode(EXAMPLES[Number(examples.value)].code);
    editor.highlightLine(null);
    clearTrace();
    counter.textContent = 'Not run yet';
    counter.classList.remove('bad');
  });
  // An edited program no longer matches the recorded trace.
  editor.onEdit(() => {
    if (!replayer) return;
    clearTrace();
    counter.textContent = 'Code changed. Run again.';
    counter.classList.remove('bad');
  });

  inspector.render(null);
}
