import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  semanticStaticPropertyName,
  javaScriptExactResultOperand,
  readExactJavaScriptLiteral,
  semanticFinalObjectMember,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import {
  javaScriptOptionalOperandsMayBeSkipped,
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import type { JavaScriptSemanticAnalysisState } from "./javascriptSemanticState.js";
import { semanticAwaitedResultSites } from "./javascriptSemanticPromiseIdentity.js";
import { syntaxUnconditionalOperands } from "./javascriptSymbolicControlFlow.js";
import { childNodes } from "./javascriptSemanticTraversal.js";

/** Outward syntax wrappers preserve the expression's runtime identity. */
const webSocketOuterExpression = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.Node => {
  let current = node;
  let identity = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (
      parent !== undefined &&
      javaScriptExactResultOperand(parent) === current
    ) {
      current = parent;
      identity = parent;
      continue;
    }
    if (
      parent === undefined ||
      unwrapJavaScriptExpression(parent).node !== identity
    )
      return current;
    current = parent;
  }
};

/** A directly selected method/data function on a fresh literal owns its call. */
const webSocketFreshMethodSelection = (
  node: t.Function | t.ClassExpression,
  value: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.MemberExpression | t.OptionalMemberExpression | undefined => {
  const parent = state.parentsByNode.get(value);
  const property =
    t.isObjectMethod(node) && node.kind === "method"
      ? node
      : t.isObjectProperty(parent) && parent.value === value
        ? parent
        : undefined;
  if (property === undefined) return undefined;
  const container = state.parentsByNode.get(property);
  if (!t.isObjectExpression(container)) return undefined;
  const object = webSocketOuterExpression(container, state);
  const member = state.parentsByNode.get(object);
  if (
    (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) ||
    member.object !== object
  )
    return undefined;
  const key = semanticStaticPropertyKey(member.property, member.computed);
  return key !== null && semanticFinalObjectMember(container, key) === property
    ? member
    : undefined;
};

/** Binding a literal defers it only until that bound result is invoked. */
const webSocketImmediateInvocation = (
  node: t.Function | t.ClassExpression,
  state: JavaScriptSemanticAnalysisState,
):
  | t.CallExpression
  | t.OptionalCallExpression
  | t.NewExpression
  | t.TaggedTemplateExpression
  | t.Decorator
  | undefined => {
  const value = webSocketOuterExpression(node, state);
  const selection = webSocketFreshMethodSelection(node, value, state);
  let callee =
    selection === undefined
      ? value
      : webSocketOuterExpression(selection, state);
  for (;;) {
    let invocation = state.parentsByNode.get(callee);
    let binds = false;
    if (
      (t.isMemberExpression(invocation) ||
        t.isOptionalMemberExpression(invocation)) &&
      invocation.object === callee
    ) {
      const member = semanticStaticPropertyName(
        invocation.property,
        invocation.computed,
      );
      if (member !== "call" && member !== "apply" && member !== "bind")
        return undefined;
      binds = member === "bind";
      callee = webSocketOuterExpression(invocation, state);
      invocation = state.parentsByNode.get(callee);
    }
    if (t.isDecorator(invocation)) {
      if (invocation.expression !== callee) return undefined;
    } else if (t.isTaggedTemplateExpression(invocation)) {
      if (invocation.tag !== callee) return undefined;
    } else if (
      (!t.isCallExpression(invocation) &&
        !t.isOptionalCallExpression(invocation) &&
        !t.isNewExpression(invocation)) ||
      invocation.callee !== callee
    )
      return undefined;
    if (!binds || t.isNewExpression(invocation)) return invocation;
    callee = webSocketOuterExpression(invocation, state);
  }
};

type WebSocketSuspension =
  | t.AwaitExpression
  | t.YieldExpression
  | t.ForOfStatement;

const loopJumpFacts = new WeakMap<t.Node, boolean>();
/** An abrupt loop path cannot prove normal body completion before its test/update. */
const webSocketBodyMayJump = (body: t.Node): boolean => {
  const known = loopJumpFacts.get(body);
  if (known !== undefined) return known;
  const pending = [body];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined || t.isFunction(node)) continue;
    if (t.isBreakStatement(node) || t.isContinueStatement(node)) {
      loopJumpFacts.set(body, true);
      return true;
    }
    for (const child of childNodes(node)) pending.push(child);
  }
  loopJumpFacts.set(body, false);
  return false;
};

const finalizerEntries = new WeakMap<
  t.BlockStatement,
  t.AwaitExpression | null
>();
/** A finally entry can precede a wait if any earlier evaluation can throw. */
const webSocketFinalizerEntrySuspension = (
  block: t.BlockStatement,
): t.AwaitExpression | undefined => {
  const known = finalizerEntries.get(block);
  if (known !== undefined) return known ?? undefined;
  const pending: t.Node[] = [block];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const node = unwrapJavaScriptExpression(next).node;
    if (
      t.isAwaitExpression(node) &&
      readExactJavaScriptLiteral(node.argument).found
    ) {
      finalizerEntries.set(block, node);
      return node;
    }
    if (
      readExactJavaScriptLiteral(node).found ||
      t.isEmptyStatement(node) ||
      t.isFunctionDeclaration(node)
    )
      continue;
    if (t.isExpressionStatement(node)) pending.push(node.expression);
    else if (t.isBlockStatement(node)) pending.push(...node.body.toReversed());
    else if (t.isSequenceExpression(node))
      pending.push(...node.expressions.toReversed());
    else if (
      t.isVariableDeclaration(node) &&
      (node.kind === "var" || node.kind === "let" || node.kind === "const") &&
      node.declarations.every((item) => t.isIdentifier(item.id))
    ) {
      for (const item of node.declarations.toReversed())
        if (item.init != null) pending.push(item.init);
    } else break;
  }
  finalizerEntries.set(block, null);
  return undefined;
};

/** Class keys complete before any static initializer or instance construction. */
const webSocketClassKeys = (node: t.Class): readonly t.Node[] => [
  ...(t.isNode(node.superClass) ? [node.superClass] : []),
  ...node.body.body.flatMap((member) =>
    (t.isClassProperty(member) || t.isClassMethod(member)) && member.computed
      ? [member.key]
      : [],
  ),
];

const webSocketStaticInitializers = (member: t.Node): readonly t.Node[] =>
  t.isStaticBlock(member)
    ? member.body
    : (t.isClassProperty(member) || t.isClassPrivateProperty(member)) &&
        member.static &&
        t.isNode(member.value)
      ? [member.value]
      : [];

/** Children completed in order if this straight-line node completes normally. */
const webSocketOrderedEvaluation = (node: t.Node): readonly t.Node[] => {
  const operands = syntaxUnconditionalOperands(node);
  if (operands !== undefined) return operands;
  if (t.isBlockStatement(node)) return node.body;
  if (t.isSwitchCase(node)) return node.consequent;
  if (t.isExpressionStatement(node)) return [node.expression];
  if (t.isVariableDeclaration(node)) return node.declarations;
  if (t.isVariableDeclarator(node))
    return t.isNode(node.init) ? [node.init, node.id] : [];
  if (t.isObjectPattern(node)) return node.properties;
  if (t.isArrayPattern(node))
    return node.elements.filter((item) => item !== null);
  if (t.isRestElement(node) || t.isAssignmentPattern(node))
    return [t.isRestElement(node) ? node.argument : node.left];
  if (t.isUnaryExpression(node) || t.isUpdateExpression(node))
    return [node.argument];
  if (t.isMemberExpression(node))
    return node.computed ? [node.object, node.property] : [node.object];
  if (t.isOptionalMemberExpression(node))
    return node.computed && !javaScriptOptionalOperandsMayBeSkipped(node)
      ? [node.object, node.property]
      : [node.object];
  if (t.isClass(node))
    return [
      ...webSocketClassKeys(node),
      ...node.body.body.flatMap(webSocketStaticInitializers),
    ];
  if (t.isSequenceExpression(node)) return node.expressions;
  if (t.isTemplateLiteral(node)) return node.expressions;
  if (t.isTaggedTemplateExpression(node)) return [node.tag, node.quasi];
  if (t.isArrayExpression(node))
    return node.elements.filter((element) => element !== null);
  if (t.isObjectExpression(node)) return node.properties;
  if (t.isObjectProperty(node))
    return node.computed ? [node.key, node.value] : [node.value];
  if (t.isObjectMethod(node)) return node.computed ? [node.key] : [];
  if (t.isSpreadElement(node)) return [node.argument];
  if (t.isBinaryExpression(node)) return [node.left, node.right];
  if (t.isSwitchStatement(node)) return [node.discriminant];
  // Every normally completed loop evaluates its initial test, but its body
  // and updates may never execute. A do/while body precedes its first test.
  if (t.isWhileStatement(node)) return [node.test];
  if (t.isDoWhileStatement(node))
    return webSocketBodyMayJump(node.body) ? [] : [node.body, node.test];
  if (t.isTryStatement(node))
    return [
      node.handler == null ? node.block : undefined,
      node.finalizer,
    ].filter((item) => item != null);
  if (t.isForOfStatement(node) || t.isForInStatement(node)) return [node.right];
  if (t.isForStatement(node))
    return [node.init, node.test].filter((element) => element != null);
  if (t.isYieldExpression(node) && node.argument != null)
    return [node.argument];
  if (t.isCallExpression(node) || t.isOptionalCallExpression(node))
    return javaScriptOptionalOperandsMayBeSkipped(node)
      ? [node.callee]
      : [node.callee, ...node.arguments];
  if (t.isImportExpression(node))
    return [node.source, node.options].filter((item) => item != null);
  if (t.isNewExpression(node)) return [node.callee, ...node.arguments];
  // Conditional/short-circuit branches, nested functions and try/catch do not
  // establish a suspension on every path to the following expression.
  return [];
};

const webSocketCompletedSuspensions = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, WebSocketSuspension | null>
>();

/** Successful completion crosses the last suspension in this straight-line node. */
const webSocketCompletedSuspension = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  let cached = webSocketCompletedSuspensions.get(state);
  if (cached === undefined) {
    cached = new WeakMap();
    webSocketCompletedSuspensions.set(state, cached);
  }
  const existing = cached.get(node);
  if (existing !== undefined) return existing ?? undefined;
  const pending = [node];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    const current = unwrapJavaScriptExpression(next).node;
    const delegateOwner =
      t.isYieldExpression(current) && current.delegate
        ? webSocketSuspensionOwner(current, state)
        : undefined;
    if (
      t.isAwaitExpression(current) ||
      (t.isForOfStatement(current) && current.await) ||
      (t.isYieldExpression(current) &&
        (!current.delegate ||
          // Async delegation awaits the iterator result even when it is done;
          // synchronous delegation can finish without yielding at all.
          (t.isFunction(delegateOwner) && delegateOwner.async)))
    ) {
      cached.set(node, current);
      return current;
    }
    for (const child of webSocketOrderedEvaluation(current))
      pending.push(child);
  }
  cached.set(node, null);
  return undefined;
};

const webSocketSuspensionPrefixes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, ReadonlyMap<t.Node, WebSocketSuspension>>
>();

/** Index sibling phases once rather than rescan a suspended body per socket. */
const webSocketPrecedingSuspension = (
  parent: t.Node,
  child: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  if (
    (t.isIfStatement(parent) || t.isConditionalExpression(parent)) &&
    (child === parent.consequent || child === parent.alternate)
  )
    return webSocketCompletedSuspension(parent.test, state);
  if (
    (t.isLogicalExpression(parent) ||
      (t.isAssignmentExpression(parent) &&
        ["&&=", "||=", "??="].includes(parent.operator))) &&
    child === parent.right
  )
    return webSocketCompletedSuspension(parent.left, state);
  if (t.isTryStatement(parent) && child === parent.finalizer)
    return webSocketFinalizerEntrySuspension(parent.block);
  if (
    t.isSwitchStatement(parent) &&
    parent.cases.includes(child as t.SwitchCase)
  )
    return webSocketCompletedSuspension(parent.discriminant, state);
  // Executed optional children follow the mandatory receiver/callee, even
  // though skipped children cannot prove completion for following siblings.
  if (
    (t.isCallExpression(parent) || t.isOptionalCallExpression(parent)) &&
    parent.arguments.includes(child as t.Expression) &&
    javaScriptOptionalOperandsMayBeSkipped(parent)
  )
    return webSocketCompletedSuspension(parent.callee, state);
  if (
    t.isOptionalMemberExpression(parent) &&
    parent.computed &&
    child === parent.property
  )
    return webSocketCompletedSuspension(parent.object, state);
  if (
    t.isForOfStatement(parent) &&
    parent.await &&
    (child === parent.body || child === parent.left)
  )
    return parent;
  if (
    (t.isForOfStatement(parent) || t.isForInStatement(parent)) &&
    (child === parent.body || child === parent.left)
  )
    return webSocketCompletedSuspension(parent.right, state);
  if (
    (t.isWhileStatement(parent) || t.isForStatement(parent)) &&
    (child === parent.body ||
      (t.isForStatement(parent) && child === parent.update))
  )
    return (
      (t.isForStatement(parent) &&
      child === parent.update &&
      !webSocketBodyMayJump(parent.body)
        ? webSocketCompletedSuspension(parent.body, state)
        : undefined) ??
      (parent.test == null
        ? undefined
        : webSocketCompletedSuspension(parent.test, state)) ??
      (t.isForStatement(parent) && parent.init != null
        ? webSocketCompletedSuspension(parent.init, state)
        : undefined)
    );
  let byParent = webSocketSuspensionPrefixes.get(state);
  if (byParent === undefined) {
    byParent = new WeakMap();
    webSocketSuspensionPrefixes.set(state, byParent);
  }
  let prefixes = byParent.get(parent);
  if (prefixes === undefined) {
    const indexed = new Map<t.Node, WebSocketSuspension>();
    let awaited: WebSocketSuspension | undefined;
    for (const node of webSocketOrderedEvaluation(parent)) {
      if (awaited !== undefined) indexed.set(node, awaited);
      awaited = webSocketCompletedSuspension(node, state) ?? awaited;
    }
    byParent.set(parent, indexed);
    prefixes = indexed;
  }
  return prefixes.get(child);
};

/** Find a completed suspension on the containing straight-line evaluation path. */
const webSocketContinuation = (
  node: t.Node,
  body: t.Node,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  let current = node;
  while (current !== body) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return undefined;
    const awaited = webSocketPrecedingSuspension(parent, current, state);
    if (awaited !== undefined) return awaited;
    current = parent;
  }
  return undefined;
};

/** Find the literal class whose construction evaluates a field or constructor. */
const webSocketClassConstruction = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.NewExpression | undefined => {
  const body = state.parentsByNode.get(node);
  const declaration =
    body === undefined ? undefined : state.parentsByNode.get(body);
  if (!t.isClassExpression(declaration)) return undefined;
  const invocation = webSocketImmediateInvocation(declaration, state);
  return t.isNewExpression(invocation) ? invocation : undefined;
};

/** Legacy decorator application follows its class's keys and static values. */
const webSocketDecoratedClass = (
  node: t.Decorator,
  state: JavaScriptSemanticAnalysisState,
): t.Class | undefined => {
  let parent = state.parentsByNode.get(node);
  while (parent !== undefined) {
    if (t.isClass(parent)) return parent;
    if (
      t.isProgram(parent) ||
      (t.isFunction(parent) &&
        !t.isClassMethod(parent) &&
        !t.isClassPrivateMethod(parent))
    )
      return undefined;
    parent = state.parentsByNode.get(parent);
  }
  return undefined;
};

/** Resume only a directly produced generator with a literal next call. */
const webSocketGeneratorResume = (
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
): t.CallExpression | t.OptionalCallExpression | undefined => {
  const result = webSocketOuterExpression(invocation, state);
  const member = state.parentsByNode.get(result);
  if (
    (!t.isMemberExpression(member) && !t.isOptionalMemberExpression(member)) ||
    member.object !== result ||
    semanticStaticPropertyName(member.property, member.computed) !== "next"
  )
    return undefined;
  const callee = webSocketOuterExpression(member, state);
  const call = state.parentsByNode.get(callee);
  return (t.isCallExpression(call) || t.isOptionalCallExpression(call)) &&
    call.callee === callee
    ? call
    : undefined;
};

/** The lexical body that actually suspends owns the continuation boundary. */
const webSocketSuspensionOwner = (
  node: WebSocketSuspension,
  state: JavaScriptSemanticAnalysisState,
): t.Node => {
  let current: t.Node = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return current;
    if (
      t.isFunction(parent) &&
      !(
        (t.isClassMethod(parent) || t.isObjectMethod(parent)) &&
        parent.key === current
      )
    )
      return parent;
    current = parent;
  }
};

/** A caller directly awaiting this result cannot initialize later locals yet. */
const webSocketWaitingContexts = (
  invocation: t.Node,
  state: JavaScriptSemanticAnalysisState,
): readonly SemanticExecutionFrame[] => {
  const contexts: SemanticExecutionFrame[] = [];
  const pending = [invocation];
  const seen = new Set<t.Node>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const awaited of semanticAwaitedResultSites(current, state, (node) =>
      webSocketExecutionContexts(node, state, true),
    )) {
      const owner = webSocketSuspensionOwner(awaited, state);
      contexts.push({ owner, point: awaited });
      if (t.isFunction(owner)) {
        const caller = webSocketImmediateInvocation(owner, state);
        if (caller !== undefined) pending.push(caller);
      }
    }
  }
  return contexts;
};

/** A lexical switch initializer is not reached by entering another case. */
export const webSocketInitializerDominatesRead = (
  initializer: t.Node,
  read: t.Node,
  state: JavaScriptSemanticAnalysisState,
  bindingNode?: t.Node,
): boolean => {
  return (
    semanticInitializerPrecedesRead({
      initializer,
      read,
      ...(bindingNode === undefined ? {} : { bindingNode }),
      parents: state.parentsByNode,
      initializerContexts: webSocketExecutionContexts(initializer, state),
      readContexts: webSocketExecutionContexts(read, state),
    }) ?? true
  );
};

const webSocketClassPrefixes = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<
    t.Class,
    {
      readonly keys: ReadonlyMap<t.Node, WebSocketSuspension | null>;
      readonly statics: ReadonlyMap<t.Node, WebSocketSuspension | null>;
    }
  >
>();

/** Index class evaluation once; all keys precede every static initializer. */
const webSocketClassPrefix = (
  member: t.Node,
  computedKey: boolean,
  state: JavaScriptSemanticAnalysisState,
): WebSocketSuspension | undefined => {
  const body = state.parentsByNode.get(member);
  const declaration =
    body === undefined ? undefined : state.parentsByNode.get(body);
  if (!t.isClass(declaration)) return undefined;
  let byClass = webSocketClassPrefixes.get(state);
  if (byClass === undefined) {
    byClass = new WeakMap();
    webSocketClassPrefixes.set(state, byClass);
  }
  let prefixes = byClass.get(declaration);
  if (prefixes === undefined) {
    const keys = new Map<t.Node, WebSocketSuspension | null>();
    const statics = new Map<t.Node, WebSocketSuspension | null>();
    let suspended = t.isNode(declaration.superClass)
      ? webSocketCompletedSuspension(declaration.superClass, state)
      : undefined;
    for (const item of declaration.body.body) {
      keys.set(item, suspended ?? null);
      if ((t.isClassProperty(item) || t.isClassMethod(item)) && item.computed)
        suspended = webSocketCompletedSuspension(item.key, state) ?? suspended;
    }
    for (const item of declaration.body.body) {
      statics.set(item, suspended ?? null);
      for (const initializer of webSocketStaticInitializers(item))
        suspended =
          webSocketCompletedSuspension(initializer, state) ?? suspended;
    }
    prefixes = { keys, statics };
    byClass.set(declaration, prefixes);
  }
  return (
    (computedKey ? prefixes.keys : prefixes.statics).get(member) ?? undefined
  );
};

/**
 * Keep local initialization ordered across suspension phases. A suspension cuts
 * off outer execution frames only after retaining the body that owns it. Calls
 * evaluate callee/arguments before bodies; classes evaluate keys, static values,
 * and construction arguments before instance fields and constructor bodies.
 */
export const webSocketExecutionContexts = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  directOnly = false,
): readonly SemanticExecutionFrame[] => {
  const contexts: SemanticExecutionFrame[] = [];
  let point = node;
  let suspendedOwner: t.Node | undefined;
  const suspendedAt = (suspension: WebSocketSuspension | undefined): void => {
    if (suspension !== undefined)
      suspendedOwner = webSocketSuspensionOwner(suspension, state);
  };
  const suspendedAfter = (evaluated: t.Node): void =>
    suspendedAt(webSocketCompletedSuspension(evaluated, state));
  let current = node;
  for (;;) {
    const parent = state.parentsByNode.get(current);
    if (parent === undefined) return [...contexts, { owner: current, point }];
    if (
      (t.isClassProperty(parent) || t.isClassPrivateProperty(parent)) &&
      parent.value === current
    ) {
      if (parent.static)
        suspendedAt(webSocketClassPrefix(parent, false, state));
      else {
        const construction = webSocketClassConstruction(parent, state);
        if (construction === undefined)
          return [...contexts, { owner: parent, point }];
        suspendedAfter(construction);
      }
    }
    if (
      (t.isClassProperty(parent) || t.isClassMethod(parent)) &&
      parent.computed &&
      parent.key === current
    )
      suspendedAt(webSocketClassPrefix(parent, true, state));
    if (t.isStaticBlock(parent))
      suspendedAt(webSocketClassPrefix(parent, false, state));
    if (t.isFunction(parent)) {
      if (
        (t.isObjectMethod(parent) || t.isClassMethod(parent)) &&
        parent.key === current
      ) {
        current = parent;
        continue;
      }
      let invocation =
        t.isClassMethod(parent) && parent.kind === "constructor"
          ? webSocketClassConstruction(parent, state)
          : webSocketImmediateInvocation(parent, state);
      contexts.push({ owner: parent, point });
      const generatorBody =
        current === parent.body &&
        !t.isArrowFunctionExpression(parent) &&
        parent.generator;
      if (
        generatorBody &&
        invocation !== undefined &&
        !t.isNewExpression(invocation)
      )
        invocation = webSocketGeneratorResume(invocation, state);
      if (invocation === undefined) return contexts;
      const decoratedClass = t.isDecorator(invocation)
        ? webSocketDecoratedClass(invocation, state)
        : undefined;
      suspendedAfter(decoratedClass ?? invocation);
      if ((parent.async || generatorBody) && current === parent.body) {
        const continuation = webSocketContinuation(node, parent.body, state);
        if (continuation !== undefined)
          suspendedOwner = webSocketSuspensionOwner(continuation, state);
      }
      // Direct frames are an earlier invocation bound for alias initialization.
      // They do not consult the waiting index that is currently being built.
      if (suspendedOwner === parent && !directOnly)
        return [...contexts, ...webSocketWaitingContexts(invocation, state)];
      point = invocation;
      // Method/parameter decorator metadata is evaluated with the class, not
      // within the decorated method's runtime activation.
      if (decoratedClass !== undefined) {
        current = decoratedClass;
        continue;
      }
    }
    current = parent;
  }
};
