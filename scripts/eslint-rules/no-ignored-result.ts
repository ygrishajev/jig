import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import ts from 'typescript';

const RESULT_VARIANTS = new Set(['Ok', 'Err']);

/** Reports a statement that drops a better-result `Result`, awaited or not. */
export const noIgnoredResult = ESLintUtils.RuleCreator.withoutDocs({
  meta: {
    type: 'problem',
    schema: [],
    messages: { ignored: 'A Result is dropped: handle its failure or return it.' },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();

    return {
      ExpressionStatement(node: TSESTree.ExpressionStatement) {
        if (node.expression.type === AST_NODE_TYPES.AssignmentExpression) return;
        const expression = services.esTreeNodeToTSNodeMap.get(node.expression);
        const type = checker.getTypeAtLocation(expression);
        const awaited = checker.getAwaitedType(type) ?? type;
        if (isResult(type) || isResult(awaited)) context.report({ node, messageId: 'ignored' });
      },
    };
  },
});

function isResult(type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type];
  return members.some((member) => RESULT_VARIANTS.has(member.getSymbol()?.getName() ?? ''));
}
