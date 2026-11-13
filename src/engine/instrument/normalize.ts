import type { NodePath, types as T } from '@babel/core';

type Types = typeof T;

function asBlock(t: Types, node: T.Statement): T.BlockStatement {
  return t.isBlockStatement(node) ? node : t.blockStatement([node]);
}

/**
 * Put the tree into a shape where every steppable statement sits in a
 * statement list and every function has a block body. Semantics are unchanged.
 */
export function normalize(program: NodePath<T.Program>, t: Types): void {
  program.traverse({
    ArrowFunctionExpression(path) {
      const { body } = path.node;
      if (t.isBlockStatement(body)) return;
      const ret = t.returnStatement(body);
      ret.loc = body.loc;
      path.node.body = t.blockStatement([ret]);
    },
    IfStatement(path) {
      path.node.consequent = asBlock(t, path.node.consequent);
      if (path.node.alternate) path.node.alternate = asBlock(t, path.node.alternate);
    },
    Loop(path) {
      path.node.body = asBlock(t, path.node.body);
    },
    DebuggerStatement(path) {
      path.remove();
    },
  });
}
