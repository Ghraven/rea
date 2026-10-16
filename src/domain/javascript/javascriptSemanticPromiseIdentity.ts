import * as t from "@babel/types";

import {
  unwrapJavaScriptExpression,
  javaScriptExactResultOperand,
} from "./javascriptAstValues.js";
import {
  semanticInitializerPrecedesRead,
  type SemanticExecutionFrame,
} from "./javascriptSemanticEvaluationOrder.js";
import {
  resolveSemanticBindingState,
  semanticStableInitializer,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import { createUnconditionalEvaluationProof } from "./javascriptSymbolicControlFlow.js";

/** Exact local promise-result identity; aliases do not prove execution order. */
export const semanticPromiseResultIdentity = (
  rawNode: t.Node,
  state: JavaScriptSemanticAnalysisState,
):
  | {
      readonly node: t.Node;
      readonly aliases: readonly {
        readonly read: t.Identifier;
        readonly initializer: t.Node;
      }[];
    }
  | undefined => {
  const seen = new Set<string>();
  const aliases: { read: t.Identifier; initializer: t.Node }[] = [];
  let node = rawNode;
  for (;;) {
    node = unwrapJavaScriptExpression(node).node;
    const result = javaScriptExactResultOperand(node);
    if (result !== undefined) {
      node = result;
      continue;
    }
    if (!t.isIdentifier(node)) return { node, aliases };
    const binding = resolveSemanticBindingState(state, node, node.name);
    const initializer = semanticStableInitializer(binding, state);
    if (
      binding === undefined ||
      binding.mutable ||
      initializer === undefined ||
      initializer.projection.length !== 0 ||
      binding.referenceInitializers.length !== 0 ||
      seen.has(binding.bindingId)
    )
      return undefined;
    seen.add(binding.bindingId);
    aliases.push({ read: node, initializer: initializer.node });
    node = initializer.node;
  }
};

const awaitedResults = new WeakMap<
  JavaScriptSemanticAnalysisState,
  WeakMap<t.Node, t.AwaitExpression[]>
>();

/** Alias identity needs initialization proof through directly owned callers. */
const promiseAliasInitializedBeforeRead = (
  initializer: t.Node,
  read: t.Identifier,
  state: JavaScriptSemanticAnalysisState,
  executionFrames: (node: t.Node) => readonly SemanticExecutionFrame[],
): boolean => {
  const binding = resolveSemanticBindingState(state, read, read.name);
  const bindingNode = semanticStableInitializer(binding, state)?.bindingNode;
  return (
    semanticInitializerPrecedesRead({
      initializer,
      read,
      ...(bindingNode === undefined ? {} : { bindingNode }),
      parents: state.parentsByNode,
      initializerContexts: executionFrames(initializer),
      readContexts: executionFrames(read),
    }) === true
  );
};

/** The shared activation block owns conditional producer/wait coupling. */
const promiseWaitBoundary = (
  producer: t.Node,
  wait: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): t.Program | t.BlockStatement | t.SwitchCase | undefined => {
  const blocks = new Set<t.Node>();
  let current: t.Node | undefined = producer;
  while (current !== undefined && !t.isFunction(current)) {
    if (
      t.isBlockStatement(current) ||
      t.isProgram(current) ||
      t.isSwitchCase(current)
    )
      blocks.add(current);
    current = parents.get(current);
  }
  current = wait;
  while (current !== undefined && !t.isFunction(current)) {
    if (
      (t.isBlockStatement(current) ||
        t.isProgram(current) ||
        t.isSwitchCase(current)) &&
      blocks.has(current)
    )
      return current;
    current = parents.get(current);
  }
  return undefined;
};

/** Every directly invoked activation between a producer and wait must wait. */
const promiseWaitCoupledToProducer = ({
  producer,
  awaited,
  parents,
  executionFrames,
  reached,
}: {
  readonly producer: t.Node;
  readonly awaited: t.AwaitExpression;
  readonly parents: WeakMap<t.Node, t.Node>;
  readonly executionFrames: (node: t.Node) => readonly SemanticExecutionFrame[];
  readonly reached: ReturnType<typeof createUnconditionalEvaluationProof>;
}): boolean => {
  const producerFrames = executionFrames(producer);
  for (const waitFrame of executionFrames(awaited)) {
    const producerFrame = producerFrames.find(
      ({ owner }) => owner === waitFrame.owner,
    );
    if (producerFrame !== undefined) {
      const boundary = promiseWaitBoundary(
        producerFrame.point,
        waitFrame.point,
        parents,
      );
      return boundary !== undefined && reached(waitFrame.point, boundary);
    }
    if (
      !t.isFunction(waitFrame.owner) ||
      !reached(waitFrame.point, waitFrame.owner.body)
    )
      return false;
  }
  return false;
};

/** Index waits using non-recursive direct frames, including initialized aliases. */
export const semanticAwaitedResultSites = (
  node: t.Node,
  state: JavaScriptSemanticAnalysisState,
  executionFrames: (node: t.Node) => readonly SemanticExecutionFrame[],
): readonly t.AwaitExpression[] => {
  let index = awaitedResults.get(state);
  if (index === undefined) {
    index = new WeakMap();
    const reached = createUnconditionalEvaluationProof(state.parentsByNode);
    for (const awaited of state.awaitSites) {
      const result = semanticPromiseResultIdentity(awaited.argument, state);
      if (result === undefined) continue;
      // Aliases retain identity only after their own initialization. Reachability
      // is relative to the block shared with the producer: entering a branch
      // can create and await a promise together without reaching either globally.
      if (result.aliases.length !== 0) {
        if (
          result.aliases.some(
            ({ initializer, read }) =>
              !promiseAliasInitializedBeforeRead(
                initializer,
                read,
                state,
                executionFrames,
              ),
          )
        )
          continue;
        if (
          !promiseWaitCoupledToProducer({
            producer: result.node,
            awaited,
            parents: state.parentsByNode,
            executionFrames,
            reached,
          })
        )
          continue;
      }
      const sites = index.get(result.node) ?? [];
      sites.push(awaited);
      index.set(result.node, sites);
    }
    awaitedResults.set(state, index);
  }
  return index.get(node) ?? [];
};
