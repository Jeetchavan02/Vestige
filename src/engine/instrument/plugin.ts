import type { PluginObject, types as T } from '@babel/core';
import type { SourceLoc } from '../types';
import { Ctx } from './context';
import { assignment, call, returnStatement, unary, update } from './expressions';
import { wrapFunction, wrapProgram } from './functions';
import { forStatement, forXStatement, whileStatement } from './loops';
import { normalize } from './normalize';
import { rewriteList } from './statements';
import { validate } from './validate';

/**
 * The Babel plugin. All rewriting happens on node exit, so children are
 * already instrumented when their parent is handled, and nothing that was
 * injected is ever visited as user code.
 */
export function createPlugin(locs: SourceLoc[]) {
  return ({ types: t }: { types: typeof T }): PluginObject => {
    let ctx!: Ctx;
    return {
      name: 'vestige-instrument',
      visitor: {
        Program: {
          enter(path) {
            validate(path);
            normalize(path, t);
            ctx = new Ctx(t, locs, path.node);
            ctx.registerBindings(path);
          },
          exit(path) {
            wrapProgram(ctx, path);
          },
        },
        BlockStatement: {
          exit(path) {
            if (!ctx.once(path.node)) return;
            path.node.body = rewriteList(ctx, path.node.body, path);
          },
        },
        StaticBlock: {
          exit(path) {
            if (!ctx.once(path.node)) return;
            path.node.body = rewriteList(ctx, path.node.body, path);
          },
        },
        SwitchStatement: {
          exit(path) {
            if (!ctx.once(path.node)) return;
            for (const clause of path.node.cases) {
              clause.consequent = rewriteList(ctx, clause.consequent, path);
            }
          },
        },
        Function: { exit: (path) => wrapFunction(ctx, path) },
        ReturnStatement: { exit: (path) => returnStatement(ctx, path) },
        ForStatement: { exit: (path) => forStatement(ctx, path) },
        ForInStatement: { exit: (path) => forXStatement(ctx, path) },
        ForOfStatement: { exit: (path) => forXStatement(ctx, path) },
        WhileStatement: { exit: (path) => whileStatement(ctx, path) },
        DoWhileStatement: { exit: (path) => whileStatement(ctx, path) },
        AssignmentExpression: { exit: (path) => assignment(ctx, path) },
        UpdateExpression: { exit: (path) => update(ctx, path) },
        UnaryExpression: { exit: (path) => unary(ctx, path) },
        CallExpression: { exit: (path) => call(ctx, path) },
      },
    };
  };
}
