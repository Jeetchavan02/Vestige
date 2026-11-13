import type { NodePath, types as T } from '@babel/core';
import type { SourceLoc } from '../types';

export type Types = typeof T;
export type FnNode = T.Function | T.Program;
type Scope = NodePath['scope'];
type Binding = NonNullable<ReturnType<Scope['getBinding']>>;

export interface Range {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

/** The runtime object every injected call goes through. */
export const HOOK = '$v';

/**
 * Shared state and node builders for one instrumentation run.
 *
 * Injected code refers to runtime scopes through lexical constants: each
 * function body starts with `const $sN = $v.enter(...)`, where N is a
 * compile-time id for that function. A nested function that writes an outer
 * variable names the outer `$sN`, and ordinary closure capture resolves it to
 * the right invocation at run time.
 */
export class Ctx {
  private readonly generated = new WeakSet<object>();
  private readonly visited = new WeakSet<object>();
  private readonly fnIds = new WeakMap<object, number>();
  private readonly keys = new WeakMap<object, Map<string, object[]>>();
  private nextFnId = 1;

  constructor(
    readonly t: Types,
    private readonly locs: SourceLoc[],
    readonly program: T.Program,
  ) {
    this.fnIds.set(program, 0);
  }

  /** True the first time a user node is seen; false for injected or repeated nodes. */
  once(node: object): boolean {
    if (this.generated.has(node) || this.visited.has(node)) return false;
    this.visited.add(node);
    return true;
  }

  mark<N extends object>(node: N): N {
    this.generated.add(node);
    return node;
  }

  isGenerated(node: object): boolean {
    return this.generated.has(node);
  }

  /** `$v.<name>(...args)` */
  hook(name: string, ...args: Array<T.Expression | T.SpreadElement>): T.CallExpression {
    const { t } = this;
    return this.mark(
      t.callExpression(t.memberExpression(t.identifier(HOOK), t.identifier(name)), args),
    );
  }

  stmt(expr: T.Expression): T.ExpressionStatement {
    return this.mark(this.t.expressionStatement(expr));
  }

  /** Intern a source range and return its index as a literal. -1 means unknown. */
  locLit(range: Range | null | undefined): T.Expression {
    const { t } = this;
    if (!range) return t.unaryExpression('-', t.numericLiteral(1));
    this.locs.push({
      line: range.start.line,
      column: range.start.column,
      endLine: range.end.line,
      endColumn: range.end.column,
    });
    return t.numericLiteral(this.locs.length - 1);
  }

  /** `$v.s(loc);` */
  step(range: Range | null | undefined): T.ExpressionStatement {
    return this.stmt(this.hook('s', this.locLit(range)));
  }

  private fnId(node: FnNode): number {
    let id = this.fnIds.get(node);
    if (id === undefined) {
      id = this.nextFnId++;
      this.fnIds.set(node, id);
    }
    return id;
  }

  /** The `$sN` constant holding `node`'s runtime scope id. */
  scopeIdent(node: FnNode): T.Identifier {
    return this.t.identifier(`$s${this.fnId(node)}`);
  }

  /** The function (or program) whose invocation owns bindings declared in `scope`. */
  private ownerOf(scope: Scope): FnNode {
    const { t } = this;
    let s: Scope | undefined = scope;
    while (s && !t.isFunction(s.block) && !t.isProgram(s.block)) s = s.parent;
    return (s?.block ?? this.program) as FnNode;
  }

  /**
   * Whether `fn`'s `$sN` constant is in lexical scope at `path`. It is declared
   * in the function body, so code in parameter defaults cannot see it.
   */
  private visible(fn: FnNode, path: NodePath): boolean {
    if (fn === this.program) return true;
    for (let p: NodePath | null = path; p?.parentPath; p = p.parentPath) {
      if (p.parentPath.node === fn) return p.key === 'body';
    }
    return false;
  }

  /** Innermost function whose body contains `path`; the program if none. */
  enclosingFn(path: NodePath): FnNode {
    for (let p: NodePath | null = path; p?.parentPath; p = p.parentPath) {
      const parent: NodePath = p.parentPath;
      if (parent.isFunction() && p.key === 'body') return parent.node;
    }
    return this.program;
  }

  /**
   * Display key for a binding, unique within its owning function. The first
   * binding of a name keeps the bare name; block-scoped shadows get `name#2`…
   */
  private keyOf(binding: Binding, owner: FnNode): string {
    let names = this.keys.get(owner);
    if (!names) this.keys.set(owner, (names = new Map()));
    const name = binding.identifier.name;
    let list = names.get(name);
    if (!list) names.set(name, (list = []));
    let index = list.indexOf(binding.identifier);
    if (index < 0) index = list.push(binding.identifier) - 1;
    return index === 0 ? name : `${name}#${index + 1}`;
  }

  /** Assign binding keys in source order so outer declarations win the bare name. */
  registerBindings(program: NodePath<T.Program>): void {
    const register = (scope: Scope) => {
      const owner = this.ownerOf(scope);
      for (const binding of Object.values(scope.bindings)) this.keyOf(binding as Binding, owner);
    };
    register(program.scope);
    program.traverse({
      Scopable(path) {
        register(path.scope);
      },
    });
  }

  /**
   * `[$sN, "key"]` arguments addressing the variable `name` as seen from
   * `path`, or null when it cannot be recorded (no binding, or its scope
   * constant is not visible here).
   */
  varRef(name: string, path: NodePath): [T.Identifier, T.StringLiteral] | null {
    const binding = path.scope.getBinding(name);
    if (!binding) return null;
    const owner = this.ownerOf(binding.scope);
    if (!this.visible(owner, path)) return null;
    return [this.scopeIdent(owner), this.t.stringLiteral(this.keyOf(binding, owner))];
  }

  /**
   * Replace an expression in its parent without Babel's requeue, which would
   * re-traverse the already-instrumented subtree.
   */
  swap(path: NodePath, node: T.Expression): void {
    (path.container as unknown as Record<string | number, unknown>)[path.key as string | number] =
      node;
  }

  /** Property key of a member access as a runtime value expression. */
  propKey(member: T.MemberExpression): T.Expression {
    const { t } = this;
    if (member.computed) return member.property as T.Expression;
    return t.stringLiteral((member.property as T.Identifier).name);
  }
}
