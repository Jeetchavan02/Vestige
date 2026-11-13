import type { NodePath, types as T } from '@babel/core';
import type { Ctx } from './context';

const LOGICAL = new Set(['||=', '&&=', '??=']);

/** `super.x` and `this.#x` cannot be passed to the runtime as (object, key). */
function isOpaque(ctx: Ctx, member: T.MemberExpression): boolean {
  return ctx.t.isSuper(member.object) || ctx.t.isPrivateName(member.property);
}

/** `expr` → `$v.after(expr, $v.sync(this))`: run natively, then re-read `this`. */
function syncThisAfter(ctx: Ctx, node: T.Expression): T.Expression {
  return ctx.hook('after', node, ctx.hook('sync', ctx.t.thisExpression()));
}

/**
 * x = v            → $v.w($s, "x", x = v)
 * [a, b] = v       → $v.after([a, b] = v, $v.w($s, "a", a), $v.w($s, "b", b))
 * o.k = v          → $v.ps(o, "k", v)
 * o.k += v         → $v.pc(o, "k", "+=", v)
 * o.k ??= v        → $v.pl(o, "k", "??=", () => v)
 *
 * Variable writes stay native and are reported afterwards. Property writes are
 * performed by the runtime, which is the only way to learn which object was
 * written without evaluating `o` twice.
 */
export function assignment(ctx: Ctx, path: NodePath<T.AssignmentExpression>): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const { left, right, operator } = node;

  if (t.isIdentifier(left)) {
    const ref = ctx.varRef(left.name, path);
    if (ref) ctx.swap(path, ctx.hook('w', ...ref, node));
    return;
  }

  if (t.isMemberExpression(left)) {
    if (isOpaque(ctx, left)) {
      ctx.swap(path, syncThisAfter(ctx, node));
      return;
    }
    const object = left.object as T.Expression;
    const key = ctx.propKey(left);
    if (operator === '=') {
      ctx.swap(path, ctx.hook('ps', object, key, right));
    } else if (LOGICAL.has(operator)) {
      const thunk = ctx.mark(t.arrowFunctionExpression([], right));
      ctx.swap(path, ctx.hook('pl', object, key, t.stringLiteral(operator), thunk));
    } else {
      ctx.swap(path, ctx.hook('pc', object, key, t.stringLiteral(operator), right));
    }
    return;
  }

  // Destructuring assignment.
  const writes: T.Expression[] = [];
  for (const name of Object.keys(t.getBindingIdentifiers(left))) {
    const ref = ctx.varRef(name, path);
    if (ref) writes.push(ctx.hook('w', ...ref, t.identifier(name)));
  }
  if (writes.length) ctx.swap(path, ctx.hook('after', node, ...writes));
}

/**
 * x++     → $v.after(x++, $v.w($s, "x", x))
 * o.k++   → $v.pu(o, "k", "++", false)
 */
export function update(ctx: Ctx, path: NodePath<T.UpdateExpression>): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const target = node.argument;

  if (t.isIdentifier(target)) {
    const ref = ctx.varRef(target.name, path);
    if (ref) ctx.swap(path, ctx.hook('after', node, ctx.hook('w', ...ref, t.identifier(target.name))));
    return;
  }
  if (t.isMemberExpression(target)) {
    if (isOpaque(ctx, target)) {
      ctx.swap(path, syncThisAfter(ctx, node));
      return;
    }
    ctx.swap(
      path,
      ctx.hook(
        'pu',
        target.object as T.Expression,
        ctx.propKey(target),
        t.stringLiteral(node.operator),
        t.booleanLiteral(node.prefix),
      ),
    );
  }
}

/** delete o.k → $v.pd(o, "k") */
export function unary(ctx: Ctx, path: NodePath<T.UnaryExpression>): void {
  const { t } = ctx;
  const node = path.node;
  if (node.operator !== 'delete' || !ctx.once(node)) return;
  const target = node.argument;
  if (!t.isMemberExpression(target) || isOpaque(ctx, target)) return;
  ctx.swap(path, ctx.hook('pd', target.object as T.Expression, ctx.propKey(target)));
}

/**
 * o.m(a, b) → $v.mc(o, "m", [a, b])
 *
 * Built-ins such as `push`, `sort` and `Object.assign` mutate objects with no
 * assignment in the source. Routing method calls through the runtime lets it
 * re-read the receiver and arguments after a native call returns.
 */
export function call(ctx: Ctx, path: NodePath<T.CallExpression>): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const callee = node.callee;
  if (!t.isMemberExpression(callee) || isOpaque(ctx, callee)) return;
  const args = t.arrayExpression(node.arguments as Array<T.Expression | T.SpreadElement>);
  ctx.swap(path, ctx.hook('mc', callee.object as T.Expression, ctx.propKey(callee), args));
}

/** return v → return $v.r($s, v) */
export function returnStatement(ctx: Ctx, path: NodePath<T.ReturnStatement>): void {
  const node = path.node;
  if (!ctx.once(node) || !node.argument) return;
  const fn = path.getFunctionParent();
  if (!fn) return;
  node.argument = ctx.hook('r', ctx.scopeIdent(fn.node), node.argument);
}
