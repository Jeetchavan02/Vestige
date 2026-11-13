import type { NodePath, types as T } from '@babel/core';
import { InstrumentError } from './errors';

/** Names the instrumenter injects. User code may not declare or reference them. */
export const RESERVED = /^\$(v|e|s\d+)$/;

function fail(node: T.Node, message: string): never {
  throw new InstrumentError(message, node.loc?.start.line, node.loc?.start.column);
}

/**
 * Reject everything outside the supported subset before any rewriting happens.
 * Module syntax, `with`, and top-level await are already parse errors because
 * the source is parsed as a strict-mode script.
 */
export function validate(program: NodePath<T.Program>): void {
  program.traverse({
    Identifier(path) {
      const { name } = path.node;
      if (RESERVED.test(name)) fail(path.node, `'${name}' is reserved by the debugger`);
      if (name === 'eval' && path.isReferencedIdentifier()) {
        fail(path.node, 'eval is not supported');
      }
    },
    Function(path) {
      if (path.node.async) fail(path.node, 'async functions are not supported');
      if (path.node.generator) fail(path.node, 'generator functions are not supported');
    },
    AwaitExpression(path) {
      fail(path.node, 'await is not supported');
    },
    YieldExpression(path) {
      fail(path.node, 'yield is not supported');
    },
    ForOfStatement(path) {
      if (path.node.await) fail(path.node, 'for await is not supported');
    },
    ImportExpression(path) {
      fail(path.node, 'dynamic import is not supported');
    },
    MetaProperty(path) {
      if (path.node.meta.name === 'import') fail(path.node, 'import.meta is not supported');
    },
  });
}
