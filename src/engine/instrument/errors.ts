/** Source could not be instrumented: a syntax error or an unsupported construct. */
export class InstrumentError extends Error {
  readonly line?: number;
  readonly column?: number;

  constructor(message: string, line?: number, column?: number) {
    super(message);
    this.name = 'InstrumentError';
    this.line = line;
    this.column = column;
  }
}

interface BabelLikeError {
  message?: unknown;
  loc?: { line?: unknown; column?: unknown };
}

/** Babel prefixes messages with the filename and appends a code frame. Strip both. */
function cleanMessage(raw: string): string {
  return raw
    .split('\n')[0]
    .replace(/^unknown: /, '')
    .replace(/\s*\(\d+:\d+\)$/, '');
}

export function toInstrumentError(err: unknown): InstrumentError {
  if (err instanceof InstrumentError) {
    return new InstrumentError(cleanMessage(err.message), err.line, err.column);
  }
  const e = (err ?? {}) as BabelLikeError;
  const message = typeof e.message === 'string' ? cleanMessage(e.message) : 'Could not parse source';
  const line = typeof e.loc?.line === 'number' ? e.loc.line : undefined;
  const column = typeof e.loc?.column === 'number' ? e.loc.column : undefined;
  return new InstrumentError(message, line, column);
}
