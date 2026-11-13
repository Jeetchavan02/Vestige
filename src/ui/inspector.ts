import type { ProgramState } from '../engine';
import { formatValue } from './format';

export interface Inspector {
  /** Show the variables in scope at `state`; null shows the empty hint. */
  render(state: ProgramState | null): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Lists the running function's variables, then each enclosing scope out to
 * the program. Values that differ from the previous render are marked, so
 * scrubbing shows what each step changed.
 */
export function createInspector(root: HTMLElement): Inspector {
  let previous = new Map<string, string>();

  return {
    render(state) {
      root.replaceChildren();
      if (!state || state.scopes.size === 0) {
        previous = new Map();
        root.append(el('p', 'inspector-empty', 'Run the code to inspect its variables.'));
        return;
      }
      // After the program has returned there is no frame; show its final variables.
      const top = state.stack[state.stack.length - 1];
      if (!top) root.append(el('p', 'inspector-empty', 'Program finished. Drag the timeline back to replay it.'));

      const current = new Map<string, string>();
      const visited = new Set<number>();
      for (let id: number | null = top?.scope ?? 0; id !== null && !visited.has(id); ) {
        visited.add(id);
        const scope = state.scopes.get(id);
        if (!scope) break;

        const section = el('section', 'scope');
        section.append(el('h3', 'scope-name', scope.name));
        if (scope.vars.size === 0) section.append(el('p', 'scope-none', 'no variables yet'));
        for (const [name, value] of scope.vars) {
          const text = formatValue(state, value);
          const key = `${id}:${name}`;
          current.set(key, text);
          const row = el('div', 'var');
          if (previous.size > 0 && previous.get(key) !== text) row.classList.add('var-changed');
          row.append(el('span', 'var-name', name), el('span', 'var-value', text));
          section.append(row);
        }
        root.append(section);
        id = scope.parent;
      }
      previous = current;
    },
  };
}
