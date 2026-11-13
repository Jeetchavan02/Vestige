import { javascript } from '@codemirror/lang-javascript';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

/** 1-based line to mark as "executing now", or null to clear. */
const setActiveLine = StateEffect.define<number | null>();

const activeLineMark = Decoration.line({ class: 'cm-vestige-line' });

const activeLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    // Editing invalidates the trace's line numbers, so the mark is dropped.
    if (tr.docChanged) return Decoration.none;
    for (const effect of tr.effects) {
      if (!effect.is(setActiveLine)) continue;
      const line = effect.value;
      if (line === null || line < 1 || line > tr.state.doc.lines) return Decoration.none;
      return Decoration.set([activeLineMark.range(tr.state.doc.line(line).from)]);
    }
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface Editor {
  getCode(): string;
  /** Highlight a 1-based line and bring it into view; null clears. */
  highlightLine(line: number | null): void;
  /** Called on every document change. */
  onEdit(listener: () => void): void;
}

export function createEditor(parent: HTMLElement, code: string): Editor {
  const listeners: Array<() => void> = [];
  const view = new EditorView({
    parent,
    doc: code,
    extensions: [
      basicSetup,
      javascript(),
      activeLineField,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) for (const listener of listeners) listener();
      }),
    ],
  });

  return {
    getCode: () => view.state.doc.toString(),
    highlightLine(line) {
      const effects: StateEffect<unknown>[] = [setActiveLine.of(line)];
      if (line !== null && line >= 1 && line <= view.state.doc.lines) {
        effects.push(EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'nearest' }));
      }
      view.dispatch({ effects });
    },
    onEdit(listener) {
      listeners.push(listener);
    },
  };
}
