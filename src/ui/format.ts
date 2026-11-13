import type { ProgramState, Value } from '../engine';

const MAX_DEPTH = 3;
const MAX_ITEMS = 30;

/** One-line, console-style rendering of a traced value. */
export function formatValue(state: ProgramState, value: Value, depth = 0, seen: number[] = []): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return String(value);

  switch (value.t) {
    case 'undefined':
      return 'undefined';
    case 'number':
      return value.v;
    case 'bigint':
      return `${value.v}n`;
    case 'symbol':
      return `Symbol(${value.v})`;
    case 'accessor':
      return '(getter)';
    case 'ref':
      break;
  }

  const object = state.heap.get(value.id);
  if (!object) return '(unknown)';
  if (object.type === 'function' || object.type === 'date' || object.type === 'regexp') {
    return object.preview ?? object.type;
  }
  if (seen.includes(value.id)) return '(circular)';
  const nested = (v: Value) => formatValue(state, v, depth + 1, [...seen, value.id]);
  const more = object.truncated ? [`… ${object.truncated} more`] : [];

  if (object.type === 'array') {
    if (depth >= MAX_DEPTH) return `Array(${object.length ?? 0})`;
    const shown = Math.min(object.length ?? 0, MAX_ITEMS);
    const items: string[] = [];
    for (let i = 0; i < shown; i++) items.push(i in object.props ? nested(object.props[i]) : '(empty)');
    if ((object.length ?? 0) > shown && !object.truncated) items.push('…');
    return `[${[...items, ...more].join(', ')}]`;
  }

  if (object.type === 'map' || object.type === 'set') {
    const name = object.type === 'map' ? 'Map' : 'Set';
    const entries = object.entries ?? [];
    if (depth >= MAX_DEPTH) return `${name}(${entries.length})`;
    const items = entries.slice(0, MAX_ITEMS).map((entry) => entry.map(nested).join(' => '));
    return `${name} {${[...items, ...more].join(', ')}}`;
  }

  if (object.type === 'error') {
    const part = (key: string) => {
      const v = object.props[key];
      return typeof v === 'string' ? v : '';
    };
    return `${part('name') || 'Error'}: ${part('message')}`;
  }

  const prefix = object.ctor ? `${object.ctor} ` : '';
  if (depth >= MAX_DEPTH) return `${prefix}{…}`;
  const items = Object.entries(object.props)
    .slice(0, MAX_ITEMS)
    .map(([key, v]) => `${key}: ${nested(v)}`);
  return `${prefix}{${[...items, ...more].join(', ')}}`;
}
