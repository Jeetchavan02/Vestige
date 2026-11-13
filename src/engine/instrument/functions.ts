import type { NodePath, types as T } from '@babel/core';
import type { Ctx, FnNode, Range } from './context';
import { rewriteList } from './statements';

const CAUGHT = '$e';

/** Best-effort display name for a function. */
function fnName(ctx: Ctx, path: NodePath<T.Function>): string {
  const { t } = ctx;
  const node = path.node;
  const keyName = (key: T.Node): string | null => {
    if (t.isIdentifier(key)) return key.name;
    if (t.isStringLiteral(key) || t.isNumericLiteral(key)) return String(key.value);
    if (t.isPrivateName(key)) return `#${key.id.name}`;
    return null;
  };

  if ('id' in node && node.id) return node.id.name;
  if (t.isClassMethod(node) && node.kind === 'constructor') {
    const cls = path.parentPath.parentPath?.node;
    return (t.isClass(cls) && cls.id?.name) || 'constructor';
  }
  if (t.isObjectMethod(node) || t.isClassMethod(node) || t.isClassPrivateMethod(node)) {
    return (!node.computed && keyName(node.key)) || '(anonymous)';
  }
  const parent = path.parent;
  if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) return parent.id.name;
  if (t.isAssignmentExpression(parent) && path.key === 'right') {
    if (t.isIdentifier(parent.left)) return parent.left.name;
    if (t.isMemberExpression(parent.left) && !parent.left.computed) {
      return keyName(parent.left.property) ?? '(anonymous)';
    }
  }
  if ((t.isObjectProperty(parent) || t.isClassProperty(parent)) && !parent.computed) {
    return keyName(parent.key) ?? '(anonymous)';
  }
  return '(anonymous)';
}

/** Does the function's own `this` appear in its body? */
function usesThis(path: NodePath<T.Function>): boolean {
  let found = false;
  path.get('body').traverse({
    ThisExpression(p) {
      found = true;
      p.stop();
    },
    Function(p) {
      if (!p.isArrowFunctionExpression()) p.skip();
    },
    Class(p) {
      p.skip();
    },
  });
  return found;
}

/** `this` is unreadable in a derived constructor until `super()` has run. */
function isDerivedConstructor(ctx: Ctx, path: NodePath<T.Function>): boolean {
  const { t } = ctx;
  if (!t.isClassMethod(path.node) || path.node.kind !== 'constructor') return false;
  const cls = path.parentPath.parentPath?.node;
  return t.isClass(cls) && cls.superClass != null;
}

/**
 * const $sN = $v.enter(name, parentScope, loc);
 * try { <prelude> <body> }
 * catch ($e) { throw $v.x($sN, $e); }
 * finally { $v.exit($sN); }
 *
 * `catch` records that the frame is unwinding; `finally` guarantees exactly
 * one exit per enter, so the replayed call stack can never drift.
 */
function wrap(
  ctx: Ctx,
  owner: FnNode,
  name: string,
  parent: T.Expression,
  range: Range | null | undefined,
  prelude: T.Statement[],
  body: T.Statement[],
): T.Statement[] {
  const { t } = ctx;
  const scope = () => ctx.scopeIdent(owner);
  const enter = ctx.mark(
    t.variableDeclaration('const', [
      t.variableDeclarator(
        scope(),
        ctx.hook('enter', t.stringLiteral(name), parent, ctx.locLit(range)),
      ),
    ]),
  );
  const guarded = ctx.mark(
    t.tryStatement(
      ctx.mark(t.blockStatement([...prelude, ...body])),
      t.catchClause(
        t.identifier(CAUGHT),
        ctx.mark(
          t.blockStatement([
            ctx.mark(t.throwStatement(ctx.hook('x', scope(), t.identifier(CAUGHT)))),
          ]),
        ),
      ),
      ctx.mark(t.blockStatement([ctx.stmt(ctx.hook('exit', scope()))])),
    ),
  );
  return [enter, guarded];
}

export function wrapFunction(ctx: Ctx, path: NodePath<T.Function>): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const body = node.body as T.BlockStatement;
  const bodyPath = path.get('body') as NodePath;
  const prelude: T.Statement[] = [];

  for (const param of node.params) {
    for (const name of Object.keys(t.getBindingIdentifiers(param))) {
      const ref = ctx.varRef(name, bodyPath);
      if (ref) prelude.push(ctx.stmt(ctx.hook('d', ...ref, t.identifier(name))));
    }
  }
  if (!t.isArrowFunctionExpression(node) && !isDerivedConstructor(ctx, path) && usesThis(path)) {
    prelude.push(
      ctx.stmt(ctx.hook('d', ctx.scopeIdent(node), t.stringLiteral('this'), t.thisExpression())),
    );
  }

  const range = node.loc && { start: node.loc.start, end: body.loc?.start ?? node.loc.end };
  const parent = ctx.scopeIdent(ctx.enclosingFn(path));
  const statements = wrap(ctx, node, fnName(ctx, path), parent, range, prelude, body.body);
  node.body = ctx.mark(t.blockStatement(statements, body.directives));
}

export function wrapProgram(ctx: Ctx, path: NodePath<T.Program>): void {
  const { t } = ctx;
  const node = path.node;
  if (!ctx.once(node)) return;
  const body = rewriteList(ctx, node.body as T.Statement[], path);
  node.body = wrap(ctx, node, '(main)', t.nullLiteral(), node.loc, [], body);
}
