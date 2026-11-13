import type { NodePath, types as T } from '@babel/core';
import type { Ctx } from './context';
import { headRange } from './statements';

/** Statements that report the current value of each named binding. */
function writes(ctx: Ctx, names: string[], hook: 'd' | 'w', path: NodePath): T.Statement[] {
  const out: T.Statement[] = [];
  for (const name of names) {
    const ref = ctx.varRef(name, path);
    if (ref) out.push(ctx.stmt(ctx.hook(hook, ...ref, ctx.t.identifier(name))));
  }
  return out;
}

/**
 * for (let i = 0; i < n; i++) { … }
 *   → for (let i = $v.d($s, "i", 0); ($v.s(loc), i < n); <update>) { … }
 *
 * Head declarations cannot be followed by a statement, so their initialisers
 * are wrapped instead. The test carries the per-iteration step. A loop with no
 * test gets the step at the top of its body, which also guarantees that every
 * loop iteration passes through the runtime and can be stopped by the limit.
 */
export function forStatement(ctx: Ctx, path: NodePath<T.ForStatement>): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const body = node.body as T.BlockStatement;
  const top: T.Statement[] = [];

  if (t.isVariableDeclaration(node.init)) {
    const late: string[] = [];
    for (const declarator of node.init.declarations) {
      const ref = t.isIdentifier(declarator.id) && ctx.varRef(declarator.id.name, path);
      if (ref && declarator.init) {
        declarator.init = ctx.hook('d', ...ref, declarator.init);
      } else {
        late.push(...Object.keys(t.getBindingIdentifiers(declarator.id)));
      }
    }
    top.push(...writes(ctx, late, 'w', path));
  }

  if (node.test) {
    node.test = t.sequenceExpression([ctx.hook('s', ctx.locLit(node.test.loc)), node.test]);
  } else {
    top.unshift(ctx.step(headRange(node)));
  }
  body.body.unshift(...top);
}

/**
 * for (const x of xs) { … } → for (const x of xs) { $v.s(loc); $v.d($s, "x", x); … }
 */
export function forXStatement(
  ctx: Ctx,
  path: NodePath<T.ForInStatement | T.ForOfStatement>,
): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const body = node.body as T.BlockStatement;
  const names = Object.keys(t.getBindingIdentifiers(node.left));
  const hook = t.isVariableDeclaration(node.left) ? 'd' : 'w';
  body.body.unshift(ctx.step(headRange(node)), ...writes(ctx, names, hook, path));
}

/** while (c) → while (($v.s(loc), c)); same for do-while. */
export function whileStatement(
  ctx: Ctx,
  path: NodePath<T.WhileStatement | T.DoWhileStatement>,
): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  node.test = t.sequenceExpression([ctx.hook('s', ctx.locLit(node.test.loc)), node.test]);
}
