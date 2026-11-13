import type { NodePath, types as T } from '@babel/core';
import type { Ctx, Range } from './context';

/**
 * The range a step should highlight. Compound statements highlight only the
 * part evaluated at that moment, not their whole body.
 */
export function stepRange(node: T.Statement): Range | null | undefined {
  switch (node.type) {
    case 'IfStatement':
      return node.test.loc;
    case 'SwitchStatement':
      return node.discriminant.loc;
    case 'ForStatement':
      return node.init?.loc ?? headRange(node);
    case 'ForInStatement':
    case 'ForOfStatement':
      return headRange(node);
    default:
      return node.loc;
  }
}

/** From the loop keyword to the end of its head. */
export function headRange(node: T.For): Range | null | undefined {
  if (!node.loc) return null;
  const last =
    node.type === 'ForStatement' ? (node.update ?? node.test ?? node.init) : node.right;
  return { start: node.loc.start, end: last?.loc?.end ?? node.body.loc?.start ?? node.loc.end };
}

/**
 * Rewrite one statement list:
 *  - `$v.s(loc)` before every statement that does work on its own,
 *  - `$v.d(scope, key, x)` after each declaration, once the binding is readable,
 *  - `$v.d(...)` for function declarations hoisted to the top of the list.
 *
 * `while` / `do-while` get their step in the loop test instead, so each
 * iteration is visible. Blocks, `try` and labels are containers and get none.
 */
export function rewriteList(ctx: Ctx, list: T.Statement[], scopePath: NodePath): T.Statement[] {
  const { t } = ctx;
  const hoisted: T.Statement[] = [];
  const out: T.Statement[] = [];

  const declare = (name: string): T.Statement | null => {
    const ref = ctx.varRef(name, scopePath);
    return ref ? ctx.stmt(ctx.hook('d', ...ref, t.identifier(name))) : null;
  };

  for (const statement of list) {
    if (ctx.isGenerated(statement)) {
      out.push(statement);
      continue;
    }
    // A label must stay attached to its loop, so the step goes before the label.
    let inner: T.Statement = statement;
    while (t.isLabeledStatement(inner)) inner = inner.body;

    switch (inner.type) {
      case 'FunctionDeclaration': {
        const write = inner.id && declare(inner.id.name);
        if (write) hoisted.push(write);
        out.push(statement);
        break;
      }
      case 'VariableDeclaration':
      case 'ClassDeclaration': {
        out.push(ctx.step(stepRange(inner)), statement);
        for (const name of Object.keys(t.getBindingIdentifiers(inner))) {
          const write = declare(name);
          if (write) out.push(write);
        }
        break;
      }
      case 'ExpressionStatement':
      case 'ReturnStatement':
      case 'ThrowStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'IfStatement':
      case 'SwitchStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
        out.push(ctx.step(stepRange(inner)), statement);
        break;
      default:
        out.push(statement);
    }
  }
  return [...hoisted, ...out];
}
