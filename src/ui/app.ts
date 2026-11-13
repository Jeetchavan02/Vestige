import { currentLoc, Replayer, trace, type SourceLoc, type TraceResult } from '../engine';
import { createEditor } from './editor';
import { createInspector } from './inspector';

const DEFAULT_CODE = `// Bubble sort with a bug. Hit Run, then drag the timeline backward
// and watch \`arr\` to find the line where a value gets lost.
function bubbleSort(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length - i - 1; j++) {
      if (arr[j] > arr[j + 1]) {
        arr[j] = arr[j + 1];
        arr[j + 1] = arr[j];
      }
    }
  }
  return arr;
}

const numbers = [5, 2, 9, 1, 7];
const sorted = bubbleSort(numbers);
console.log(sorted);
`;

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
      <h1 class="brand">Vestige</h1>
      <button class="run" type="button">Run</button>
      <span class="counter" role="status">Not run yet</span>
    </header>
    <main class="panels">
      <div class="editor"></div>
      <aside class="inspector" aria-label="Variables"></aside>
    </main>
    <footer class="timeline">
      <input class="scrubber" type="range" min="0" max="0" value="0" step="1" disabled aria-label="Timeline" />
      <span class="position">0 / 0</span>
    </footer>`;

  const runButton = root.querySelector<HTMLButtonElement>('.run')!;
  const counter = root.querySelector<HTMLElement>('.counter')!;
  const scrubber = root.querySelector<HTMLInputElement>('.scrubber')!;
  const position = root.querySelector<HTMLElement>('.position')!;
  const editor = createEditor(root.querySelector<HTMLElement>('.editor')!, DEFAULT_CODE);
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
  };

  const clearTrace = () => {
    replayer = null;
    locs = [];
    scrubber.disabled = true;
    scrubber.max = '0';
    scrubber.value = '0';
    position.textContent = '0 / 0';
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
  // An edited program no longer matches the recorded trace.
  editor.onEdit(() => {
    if (!replayer) return;
    clearTrace();
    counter.textContent = 'Code changed. Run again.';
    counter.classList.remove('bad');
  });

  inspector.render(null);
}
