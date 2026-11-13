import { describe, expect, it } from 'vitest';
import { instrument, InstrumentError } from '../src/engine/instrument';

const rejects = (source: string): InstrumentError => {
  try {
    instrument(source);
  } catch (err) {
    expect(err).toBeInstanceOf(InstrumentError);
    return err as InstrumentError;
  }
  throw new Error(`expected rejection: ${source}`);
};

describe('instrument: validation', () => {
  it('reports syntax errors with a clean message and position', () => {
    const err = rejects('let x = 1;\nlet y = ;');
    expect(err.message).toBe('Unexpected token');
    expect(err.line).toBe(2);
    expect(err.column).toBe(8);
  });

  it.each([
    ['async function f() {}', /async/],
    ['const f = async () => 1;', /async/],
    ['function* g() { yield 1; }', /generator/],
    ['eval("1")', /eval/],
    ['const f = eval;', /eval/],
    ['import("x")', /import/],
    ['let $v = 1;', /reserved/],
    ['function f($s0) {}', /reserved/],
    ['try {} catch ($e) {}', /reserved/],
  ])('rejects %s', (source, pattern) => {
    expect(rejects(source).message).toMatch(pattern);
  });

  it.each(['with (Math) {}', 'import x from "y";', 'export const a = 1;', 'x = 010;', 'await 1;'])(
    'rejects %s at parse time',
    (source) => {
      rejects(source);
    },
  );

  it('allows eval as a property name', () => {
    expect(() => instrument('const o = { eval: 1 }; o.eval;')).not.toThrow();
  });

  it('reports the position of unsupported constructs', () => {
    const err = rejects('let a = 1;\n  async function f() {}');
    expect(err.line).toBe(2);
    expect(err.column).toBe(2);
  });
});

describe('instrument: output', () => {
  it('produces code that parses as a strict function body', () => {
    const { code } = instrument('let a = 1; function f(x) { return x * 2; } a = f(a);');
    expect(() => new Function('$v', `"use strict";\n${code}`)).not.toThrow();
  });

  it('interns one loc per step and enter', () => {
    const { code, locs } = instrument('let a = 1;\na = 2;');
    const used = [...code.matchAll(/\$v\.(?:s|enter)\([^)]*?(\d+)\)/g)].map((m) => Number(m[1]));
    expect(used.length).toBeGreaterThan(0);
    for (const index of used) expect(locs[index]).toBeDefined();
    expect(locs).toContainEqual({ line: 2, column: 0, endLine: 2, endColumn: 6 });
  });

  it('highlights only the condition of an if statement', () => {
    const { locs } = instrument('if (1 < 2) {\n  let a = 1;\n}');
    expect(locs).toContainEqual({ line: 1, column: 4, endLine: 1, endColumn: 9 });
  });

  it('removes debugger statements', () => {
    expect(instrument('debugger; let a = 1;').code).not.toContain('debugger');
  });

  it('is deterministic', () => {
    const source = 'const f = (a) => a + 1; let b = f(1);';
    expect(instrument(source)).toEqual(instrument(source));
  });
});
