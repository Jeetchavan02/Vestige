import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { tags } from '@lezer/highlight';

const darkTheme = EditorView.theme(
  {
    '&': { color: '#ccc', backgroundColor: '#111111' },
    '.cm-content': { caretColor: '#e06c00' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#e06c00' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: '#3a2a10' },
    '.cm-gutters': { backgroundColor: '#111111', color: '#555', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#161616' },
    '.cm-activeLineGutter': { backgroundColor: '#161616', color: '#888' },
    '.cm-selectionMatch': { backgroundColor: '#2a2a2a' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: '#333', outline: 'none' },
    '.cm-foldPlaceholder': { backgroundColor: '#222', border: 'none', color: '#888' },
    '.cm-tooltip': { backgroundColor: '#1a1a1a', border: '1px solid #333', color: '#ccc' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#3a2a10', color: '#ccc' },
    '.cm-panels': { backgroundColor: '#1a1a1a', color: '#ccc' },
    '.cm-textfield': { backgroundColor: '#111', color: '#ccc', border: '1px solid #333' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: '#222', color: '#ccc', border: '1px solid #333' },
  },
  { dark: true },
);

const darkHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#666', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: '#e0995c' },
  { tag: [tags.string, tags.regexp, tags.special(tags.string)], color: '#9fbf6a' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#d7b06a' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: '#7fb4d8' },
  { tag: [tags.className, tags.typeName], color: '#7fb4d8' },
  { tag: [tags.propertyName, tags.variableName], color: '#ccc' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: '#999' },
  { tag: tags.invalid, color: '#e06c5c' },
]);

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
  /** Replace the whole document. */
  setCode(code: string): void;
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
      darkTheme,
      syntaxHighlighting(darkHighlight),
      activeLineField,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) for (const listener of listeners) listener();
      }),
    ],
  });

  return {
    getCode: () => view.state.doc.toString(),
    setCode(code) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
    },
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
