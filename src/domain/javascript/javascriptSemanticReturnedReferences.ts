import * as t from "@babel/types";

import {
  semanticStaticPropertyKey,
  unwrapJavaScriptExpression,
} from "./javascriptAstValues.js";
import { semanticCallableResultExpressions } from "./javascriptSemanticCallableResults.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticArrayIndex,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import {
  resolveSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticInitializer,
} from "./javascriptSemanticState.js";

/**
 * How many keys a chain may add to one binding's projection through that
 * binding's own writes before further self-referencing writes count as
 * cycles. One pass keeps `x = root; x = x.next; x.run()` resolvable and
 * bounds a mesh of self-walking writes by their count; two passes cost 10 s
 * on a React bundle that one pass finishes in 2 s, and three did not finish.
 */
const MAX_PROJECTION_GROWTH = 1;

/** A reference potentially handed to a caller or generator consumer. */
export interface SemanticReturnedReference {
  readonly node: t.Node;
  readonly projection: JavaScriptSemanticPropertyPath;
}

/**
 * What one expansion chain has passed through: each initializer it followed
 * (value 0) and each binding it read, with the projection length at that
 * first read. An initializer is followed at most once per chain. A binding
 * re-read with a longer projection has grown it through a self-referencing
 * write (x = x.next); from there only writes that leave the chain's bindings
 * are followed, so the projection grows once per binding per chain.
 */
type ChainEntry =
  | JavaScriptSemanticInitializer
  | JavaScriptSemanticBindingState;
type Chain = ReadonlyMap<ChainEntry, number>;

interface Candidate {
  readonly node: t.Node;
  readonly path: readonly (string | number | null)[];
  readonly chain: Chain;
}

type InitializerContext = Chain;
type CompletedExpansions = WeakMap<
  t.Node,
  Map<string, readonly InitializerContext[]>
>;

interface ExpansionFrame {
  readonly item: Candidate;
  readonly node: t.Node;
  readonly pathKey: string;
  readonly parent: ExpansionFrame | null;
  readonly blockers: Map<ChainEntry, number>;
}

type ExpansionTask =
  | {
      readonly kind: "visit";
      readonly item: Candidate;
      readonly parent: ExpansionFrame | null;
    }
  | { readonly kind: "complete"; readonly frame: ExpansionFrame };

const contextContains = (
  context: InitializerContext,
  required: InitializerContext,
): boolean => {
  for (const [entry, depth] of required)
    if (context.get(entry) !== depth) return false;
  return true;
};

const propagateBlockers = (
  blockers: InitializerContext,
  parent: ExpansionFrame | null,
): void => {
  if (parent === null) return;
  for (const [entry, depth] of blockers)
    if (parent.item.chain.get(entry) === depth)
      parent.blockers.set(entry, depth);
};

const completeExpansion = (
  frame: ExpansionFrame,
  expanded: CompletedExpansions,
): void => {
  const paths =
    expanded.get(frame.node) ??
    new Map<string, readonly InitializerContext[]>();
  const contexts = paths.get(frame.pathKey) ?? [];
  const covered = contexts.find((context) =>
    contextContains(frame.blockers, context),
  );
  if (covered === undefined) {
    paths.set(frame.pathKey, [
      ...contexts.filter(
        (context) => !contextContains(context, frame.blockers),
      ),
      frame.blockers,
    ]);
    expanded.set(frame.node, paths);
  }
  propagateBlockers(covered ?? frame.blockers, frame.parent);
};

interface ObjectTargetIndex {
  readonly propertyByName: ReadonlyMap<
    string,
    t.ObjectMethod | t.ObjectProperty
  >;
  readonly trailingUnknownsByProperty: ReadonlyMap<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >;
}

interface ObjectTargetUnknown {
  readonly node: t.ObjectMethod | t.ObjectProperty | t.SpreadElement;
  readonly previous: ObjectTargetUnknown | undefined;
}

/** Resolve local result references conservatively, without claiming call execution. */
export const createSemanticReturnedReferences = (
  state: JavaScriptSemanticAnalysisState,
): ((callee: t.Node) => readonly SemanticReturnedReference[]) => {
  const results = new WeakMap<t.Node, readonly SemanticReturnedReference[]>();
  const objectTargets = new WeakMap<t.ObjectExpression, ObjectTargetIndex>();
  return (callee) => {
    const existing = results.get(callee);
    if (existing !== undefined) return existing;
    const functions = new Set<t.Node>();
    const work: ExpansionTask[] = [
      {
        kind: "visit",
        item: { node: callee, path: [], chain: new Map() },
        parent: null,
      },
    ];
    // Finish descendants before memoizing an expansion. Only actual external
    // cycle blockers affect reuse; branch history is not a dependency. An
    // acyclic expression/path is consequently expanded once across a diamond.
    const expanded: CompletedExpansions = new WeakMap();
    while (work.length > 0) {
      const task = work.pop();
      if (task === undefined) break;
      if (task.kind === "complete") {
        completeExpansion(task.frame, expanded);
        continue;
      }
      const { item, parent } = task;
      const node = unwrapJavaScriptExpression(item.node).node;
      const pathKey = JSON.stringify(item.path);
      const covered = expanded
        .get(node)
        ?.get(pathKey)
        ?.find((context) => contextContains(item.chain, context));
      if (covered !== undefined) {
        // Cached cycle dependencies must reach the caller's proof too.
        propagateBlockers(covered, parent);
        continue;
      }
      const frame: ExpansionFrame = {
        item,
        node,
        pathKey,
        parent,
        blockers: new Map(),
      };
      work.push({ kind: "complete", frame });
      const pending: Candidate[] = [];
      if (t.isIdentifier(node)) {
        const binding = resolveSemanticBindingState(state, node, node.name);
        if (binding === undefined) continue;
        const selected = semanticBindingAtRead(
          binding,
          node,
          state.parentsByNode,
        ).binding;
        // A write that reads its own binding through a member (x = x.next)
        // grows the projection on every pass. Each such write is followed
        // once per chain, but a binding with several of them (t = t.child,
        // t = t.return, t = t.sibling) is still walked in every order, and
        // the paths of those orders are all distinct, so the work grows
        // exponentially with the writes. Grow a binding's projection once per
        // chain: when the binding is re-read with a longer projection, writes
        // that read a binding already on the chain are cycle blockers at this
        // binding, and only writes that leave the chain (x = root) continue.
        // Re-reads at the same depth keep every write, as alias cycles and
        // position-narrowed reads need.
        const entered = item.chain.get(binding);
        const grown =
          entered !== undefined &&
          item.path.length - entered >= MAX_PROJECTION_GROWTH;
        for (const initializer of [
          ...selected.initializers,
          ...selected.referenceInitializers,
        ]) {
          if (item.chain.has(initializer)) {
            frame.blockers.set(initializer, 0);
            continue;
          }
          if (grown && readsChainBinding(initializer.node, item.chain, state)) {
            frame.blockers.set(binding, entered);
            continue;
          }
          const chain = new Map(item.chain);
          if (entered === undefined) chain.set(binding, item.path.length);
          chain.set(initializer, 0);
          pending.push({
            node: initializer.node,
            path: [...initializer.projection, ...item.path],
            chain,
          });
        }
      } else if (
        t.isMemberExpression(node) ||
        t.isOptionalMemberExpression(node)
      ) {
        const path: (string | number | null)[] = [];
        let receiver: t.Node = node;
        while (
          t.isMemberExpression(receiver) ||
          t.isOptionalMemberExpression(receiver)
        ) {
          path.push(
            semanticStaticPropertyKey(receiver.property, receiver.computed),
          );
          receiver = unwrapJavaScriptExpression(receiver.object).node;
        }
        pending.push({
          ...item,
          node: receiver,
          path: [...path.reverse(), ...item.path],
        });
      } else if (
        t.isConditionalExpression(node) ||
        t.isLogicalExpression(node)
      ) {
        pending.push(
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.consequent : node.left,
          },
          {
            ...item,
            node: t.isConditionalExpression(node) ? node.alternate : node.right,
          },
        );
      } else if (t.isSequenceExpression(node)) {
        const last = node.expressions.at(-1);
        if (last !== undefined) pending.push({ ...item, node: last });
      } else if (t.isFunction(node) && item.path.length === 0)
        functions.add(node);
      else if (t.isObjectExpression(node))
        selectObjectTargets(node, item, pending, objectTargets);
      else if (t.isArrayExpression(node)) {
        const [key, ...path] = item.path;
        const index =
          key === undefined || key === null ? null : semanticArrayIndex(key);
        let uncertainOffset = false;
        node.elements.forEach((element, offset) => {
          if (element === null) return;
          if (t.isSpreadElement(element)) {
            uncertainOffset = true;
            pending.push({
              ...item,
              node: element.argument,
              path: [null, ...path],
            });
          } else if (index === null || uncertainOffset || index === offset)
            pending.push({ ...item, node: element, path });
        });
      } else if (t.isNewExpression(node))
        pending.push({ ...item, node: node.callee });
      else if (t.isClass(node)) {
        const [key, ...path] = item.path;
        for (const member of node.body.body) {
          if (t.isClassMethod(member)) {
            if (
              (item.path.length === 0 && member.kind === "constructor") ||
              (key !== undefined &&
                (key === null ||
                  semanticStaticPropertyKey(member.key, member.computed) ===
                    String(key)))
            )
              pending.push({ ...item, node: member, path });
          } else if (
            t.isClassProperty(member) &&
            member.value !== null &&
            member.value !== undefined &&
            key !== undefined &&
            (key === null ||
              semanticStaticPropertyKey(member.key, member.computed) ===
                String(key))
          )
            pending.push({ ...item, node: member.value, path });
        }
        if (node.superClass !== null && node.superClass !== undefined)
          pending.push({ ...item, node: node.superClass });
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const child = pending[index];
        if (child !== undefined)
          work.push({ kind: "visit", item: child, parent: frame });
      }
    }
    const output = [...functions].flatMap((node) => {
      const callables = t.isClass(node)
        ? node.body.body.filter(
            (member) =>
              t.isClassMethod(member) && member.kind === "constructor",
          )
        : [node];
      return callables.flatMap((callable) =>
        semanticCallableResultExpressions(callable).flatMap(
          ({ node, delegated }) =>
            node === null
              ? []
              : [{ node, projection: delegated ? [null] : [] }],
        ),
      );
    });
    results.set(callee, output);
    return output;
  };
};

/**
 * Whether expanding this write would read a binding the chain already holds:
 * the write's value is that binding, a member chain on it, or a branch of a
 * conditional, logical or sequence expression that is.
 */
const readsChainBinding = (
  node: t.Node,
  chain: Chain,
  state: JavaScriptSemanticAnalysisState,
): boolean => {
  let current = unwrapJavaScriptExpression(node).node;
  while (t.isMemberExpression(current) || t.isOptionalMemberExpression(current))
    current = unwrapJavaScriptExpression(current.object).node;
  if (t.isIdentifier(current)) {
    const binding = resolveSemanticBindingState(state, current, current.name);
    return binding !== undefined && chain.has(binding);
  }
  if (t.isConditionalExpression(current))
    return (
      readsChainBinding(current.consequent, chain, state) ||
      readsChainBinding(current.alternate, chain, state)
    );
  if (t.isLogicalExpression(current))
    return (
      readsChainBinding(current.left, chain, state) ||
      readsChainBinding(current.right, chain, state)
    );
  if (t.isSequenceExpression(current)) {
    const last = current.expressions.at(-1);
    return last !== undefined && readsChainBinding(last, chain, state);
  }
  return false;
};

const selectObjectTargets = (
  node: t.ObjectExpression,
  item: Candidate,
  pending: Candidate[],
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): void => {
  const [key, ...path] = item.path;
  if (key !== null && key !== undefined) {
    const index = objectTargetIndex(node, indexes);
    const property = index.propertyByName.get(String(key));
    if (property !== undefined) {
      const unknowns: ObjectTargetUnknown[] = [];
      for (
        let unknown = index.trailingUnknownsByProperty.get(property);
        unknown !== undefined;
        unknown = unknown.previous
      )
        unknowns.push(unknown);
      for (const { node: unknown } of unknowns.reverse())
        pending.push({
          ...item,
          node: t.isSpreadElement(unknown)
            ? unknown.argument
            : t.isObjectProperty(unknown)
              ? unknown.value
              : unknown,
          ...(t.isSpreadElement(unknown) ? {} : { path }),
        });
      pending.push({
        ...item,
        node: t.isObjectProperty(property) ? property.value : property,
        path,
      });
      return;
    }
  }
  let replaced = false;
  for (const property of [...node.properties].reverse()) {
    if (replaced) break;
    if (t.isSpreadElement(property)) {
      pending.push({ ...item, node: property.argument });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (
      key !== null &&
      key !== undefined &&
      name !== null &&
      name !== String(key)
    )
      continue;
    if (t.isObjectProperty(property))
      pending.push({ ...item, node: property.value, path });
    else pending.push({ ...item, node: property, path });
    if (key !== null && key !== undefined && name === String(key))
      replaced = true;
  }
};

const objectTargetIndex = (
  node: t.ObjectExpression,
  indexes: WeakMap<t.ObjectExpression, ObjectTargetIndex>,
): ObjectTargetIndex => {
  const existing = indexes.get(node);
  if (existing !== undefined) return existing;
  const propertyByName = new Map<string, t.ObjectMethod | t.ObjectProperty>();
  const trailingUnknownsByProperty = new Map<
    t.ObjectMethod | t.ObjectProperty,
    ObjectTargetUnknown
  >();
  let trailingUnknown: ObjectTargetUnknown | undefined;
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name === null) {
      trailingUnknown = { node: property, previous: trailingUnknown };
      continue;
    }
    if (propertyByName.has(name)) continue;
    propertyByName.set(name, property);
    if (trailingUnknown !== undefined)
      trailingUnknownsByProperty.set(property, trailingUnknown);
  }
  const created = { propertyByName, trailingUnknownsByProperty };
  indexes.set(node, created);
  return created;
};
