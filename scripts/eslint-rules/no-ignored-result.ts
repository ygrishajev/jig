import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import ts from 'typescript';

const RESULT_VARIANTS = new Set(['Ok', 'Err']);

/**
 * Reports a better-result `Result` that is dropped, awaited or not: a statement on its own, one
 * behind `void`, or an arrow callback's body where the caller expects nothing back.
 */
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
    const typeOf = (node: TSESTree.Node): ts.Type =>
      checker.getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(node));
    const holdsResult = (node: TSESTree.Node): boolean => {
      const type = typeOf(node);
      return isResult(type) || isResult(checker.getAwaitedType(type) ?? type);
    };

    return {
      ExpressionStatement(node: TSESTree.ExpressionStatement) {
        const { expression } = node;
        if (expression.type === AST_NODE_TYPES.AssignmentExpression) return;
        const dropped =
          expression.type === AST_NODE_TYPES.UnaryExpression && expression.operator === 'void'
            ? expression.argument
            : expression;
        if (holdsResult(dropped)) context.report({ node, messageId: 'ignored' });
      },
      ArrowFunctionExpression(node: TSESTree.ArrowFunctionExpression) {
        if (node.body.type === AST_NODE_TYPES.BlockStatement) return;
        const expected = checker.getContextualType(
          services.esTreeNodeToTSNodeMap.get(node) as ts.Expression,
        );
        if (expected && returnsNothing(expected) && holdsResult(node.body)) {
          context.report({ node: node.body, messageId: 'ignored' });
        }
      },
    };
  },
});

function isResult(type: ts.Type): boolean {
  const members = type.isUnion() ? type.types : [type];
  return members.some((member) => RESULT_VARIANTS.has(member.getSymbol()?.getName() ?? ''));
}

/** A callback slot whose every signature returns `void`, so whatever the arrow yields is thrown away. */
function returnsNothing(type: ts.Type): boolean {
  const signatures = type.getCallSignatures();
  return (
    signatures.length > 0 &&
    signatures.every((signature) => (signature.getReturnType().flags & ts.TypeFlags.Void) !== 0)
  );
}
