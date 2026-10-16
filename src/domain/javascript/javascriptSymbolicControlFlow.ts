import * as t from "@babel/types";
import {
  javaScriptExactResultOperand,
  readExactJavaScriptLiteral,
} from "./javascriptAstValues.js";
import { javaScriptOptionalOperandsMayBeSkipped } from "./javascriptSemanticEvaluationOrder.js";
import {
  symbolicTruth,
  type SymbolicValue,
} from "./javascriptSymbolicValues.js";

/** Whether short-circuit evaluation reaches the right operand; unknown stays unknown. */
export const symbolicLogicalRight = (
  operator: t.LogicalExpression["operator"],
  left: SymbolicValue,
): boolean | undefined => {
  if (left.kind === "union") {
    const choices = left.values.map((value) =>
      symbolicLogicalRight(operator, value),
    );
    return choices.length > 0 &&
      choices.every((choice) => choice === choices[0])
      ? choices[0]
      : undefined;
  }
  if (operator === "??") {
    if (left.kind === "literal")
      return left.value === null || left.value === undefined;
    return [
      "function",
      "object",
      "namespace",
      "array",
      "record",
      "loader",
    ].includes(left.kind)
      ? false
      : undefined;
  }
  const truth = symbolicTruth(left);
  return truth === undefined ? undefined : operator === "&&" ? truth : !truth;
};

/** Syntax-proven branch operands, shared by reachability and continuation proofs. */
export const syntaxUnconditionalOperands = (
  node: t.Node,
): readonly t.Node[] | undefined => {
  if (t.isConditionalExpression(node)) {
    const branch = javaScriptExactResultOperand(node);
    return branch === undefined ? [node.test] : [node.test, branch];
  }
  if (t.isIfStatement(node)) {
    const test = readExactJavaScriptLiteral(node.test);
    const branch = test.found
      ? test.value
        ? node.consequent
        : node.alternate
      : undefined;
    return branch == null ? [node.test] : [node.test, branch];
  }
  if (t.isLogicalExpression(node)) {
    return javaScriptExactResultOperand(node) === node.right
      ? [node.left, node.right]
      : [node.left];
  }
  if (t.isAssignmentExpression(node)) {
    if (
      node.operator === "=" &&
      (t.isObjectPattern(node.left) || t.isArrayPattern(node.left))
    )
      return [node.right, node.left];
    // Only logical assignments can short-circuit the RHS. Non-logical
    // compound operators read the left value, then always evaluate the RHS.
    return ["&&=", "||=", "??="].includes(node.operator)
      ? [node.left]
      : [node.left, node.right];
  }
  return undefined;
};

/** Recognize abrupt prefixes without treating a loop's jump as a function exit. */
const syntaxDefiniteExit = (
  node: t.Node | null | undefined,
  depth: number,
  includeJumps: boolean,
): boolean => {
  if (!node || depth >= 128) return false;
  if (
    t.isReturnStatement(node) ||
    t.isThrowStatement(node) ||
    (includeJumps && (t.isBreakStatement(node) || t.isContinueStatement(node)))
  )
    return true;
  if (t.isBlockStatement(node))
    return node.body.some((child) =>
      syntaxDefiniteExit(child, depth + 1, includeJumps),
    );
  if (!t.isIfStatement(node)) return false;
  const test = readExactJavaScriptLiteral(node.test);
  if (includeJumps && test.found) {
    const branch = test.value ? node.consequent : node.alternate;
    return syntaxDefiniteExit(branch, depth + 1, includeJumps);
  }
  return (
    syntaxDefiniteExit(node.consequent, depth + 1, includeJumps) &&
    syntaxDefiniteExit(node.alternate, depth + 1, includeJumps)
  );
};

/** Only definite synchronous exits; unsupported control flow stays unknown. */
export const symbolicDefiniteExit = (
  node: t.Node | null | undefined,
  depth = 0,
): boolean => syntaxDefiniteExit(node, depth, false);

/** Prove a syntax-local path is unconditional; unknown branches remain unknown. */
export const createUnconditionalEvaluationProof = (
  parents: WeakMap<t.Node, t.Node>,
): ((node: t.Node, boundary?: t.Node) => boolean) => {
  const reachableStatements = new WeakMap<
    t.Program | t.BlockStatement | t.SwitchCase,
    ReadonlySet<t.Node>
  >();
  const truth = (node: t.Node): boolean | undefined => {
    const literal = readExactJavaScriptLiteral(node);
    return literal.found ? Boolean(literal.value) : undefined;
  };
  return (node, boundary) => {
    let child = node;
    for (;;) {
      if (child === boundary) return true;
      const parent = parents.get(child);
      if (parent === undefined) return boundary === undefined;
      const operands = syntaxUnconditionalOperands(parent);
      if (operands !== undefined && !operands.includes(child)) return false;
      if (t.isWhileStatement(parent) && child === parent.body) {
        if (truth(parent.test) !== true) return false;
      } else if (t.isForStatement(parent)) {
        if (child === parent.update) return false;
        if (
          child === parent.body &&
          parent.test != null &&
          truth(parent.test) !== true
        )
          return false;
      } else if (
        (t.isForInStatement(parent) || t.isForOfStatement(parent)) &&
        child !== parent.right
      )
        return false;
      else if (t.isDoWhileStatement(parent) && child === parent.test)
        return false;
      else if (
        (t.isSwitchCase(parent) && parent !== boundary) ||
        t.isCatchClause(parent)
      )
        return false;
      else if (t.isAssignmentPattern(parent) && child === parent.right)
        return false;
      else if (
        t.isOptionalMemberExpression(parent) &&
        child === parent.property &&
        parent.computed &&
        javaScriptOptionalOperandsMayBeSkipped(parent)
      )
        return false;
      else if (
        (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
        parent.arguments.includes(child as t.Expression) &&
        javaScriptOptionalOperandsMayBeSkipped(parent)
      )
        return false;
      if (
        t.isBlockStatement(parent) ||
        t.isProgram(parent) ||
        t.isSwitchCase(parent)
      ) {
        let reachable = reachableStatements.get(parent);
        if (reachable === undefined) {
          const statements = new Set<t.Node>();
          for (const statement of t.isSwitchCase(parent)
            ? parent.consequent
            : parent.body) {
            statements.add(statement);
            if (syntaxDefiniteExit(statement, 0, true)) break;
          }
          reachable = statements;
          reachableStatements.set(parent, reachable);
        }
        if (!reachable.has(child)) return false;
      }
      if (
        t.isFunction(parent) &&
        !(
          (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
          parent.computed &&
          parent.key === child
        )
      )
        return boundary === undefined;
      child = parent;
    }
  };
};
