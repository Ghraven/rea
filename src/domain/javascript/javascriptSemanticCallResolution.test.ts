import * as t from "@babel/types";
import { expect, it, vi } from "vitest";

import { indexJavaScriptBindingsSteps } from "./javascriptSemanticAnalysis.js";
import {
  resolveLocalCallables,
  type LocalCallableResolution,
} from "./javascriptSemanticCallResolution.js";
import { parseJavaScriptSource } from "./javascriptSourceParser.js";
import { createSemanticReturnedReferences } from "./javascriptSemanticReturnedReferences.js";
import { semanticBindingAtRead } from "./javascriptSemanticMutationInitializers.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";

const indexed = (source: string) => {
  const parsed = parseJavaScriptSource(source, "callback.js");
  if (parsed === null) throw new Error("Expected valid callback fixture");
  const steps = indexJavaScriptBindingsSteps(parsed.program);
  let step = steps.next();
  while (step.done !== true) step = steps.next();
  const state = step.value;
  const callableById = new Map(
    state.callables.map((callable) => [callable.callableId, callable]),
  );
  const bindingCache = new WeakMap<t.Identifier, LocalCallableResolution>();
  return {
    state,
    callableById,
    bindingCache,
    resolve: (node: t.Node) =>
      resolveLocalCallables({
        node,
        state,
        callableById,
        bindingCache,
        seenInitializers: new Set(),
      }),
  };
};

it("bounds shared partial callback alias expansion by AST size", () => {
  const measure = (depth: number) => {
    const context =
      indexed(`function fallback(){return {member:1};} function choose(cb,flag){
      if(flag)cb=fallback;
      const a0=cb;
      ${Array.from({ length: depth }, (_, i) => `const a${i + 1}=flag?a${i}:a${i};`).join("")}
      return a${depth}();
    }`);
    const choose = context.state.program.body[1];
    if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
    const last = choose.body.body.at(-1);
    if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
      throw new Error("Missing call");
    const reads = vi.spyOn(context.bindingCache, "get");
    const result = context.resolve(last.argument.callee);
    expect(result).toMatchObject({ complete: false });
    expect(result.callableIds).toHaveLength(1);
    const callReads = reads.mock.calls.length;
    const lookups = context.state.scopes.map((scope) =>
      vi.spyOn(scope.bindings, "get"),
    );
    try {
      expect(
        createSemanticReturnedReferences(context.state)(last.argument.callee),
      ).toHaveLength(1);
      return {
        callReads,
        referenceReads: lookups.reduce(
          (total, lookup) => total + lookup.mock.calls.length,
          0,
        ),
      };
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  };
  const small = measure(8);
  const large = measure(12);
  expect(small.callReads).toBeGreaterThan(0);
  expect(large.callReads).toBeLessThan(3 * small.callReads);
  expect(small.referenceReads).toBeGreaterThan(0);
  expect(large.referenceReads).toBeLessThan(3 * small.referenceReads);
});

it.each([
  ["if(flag){cb=fallback;cb();}", true],
  ["if(flag)cb=fallback;cb();", false],
  ["cb ||= fallback;cb();", false],
] as const)(
  "reports initializer coverage at the read: %s",
  (body, expected) => {
    const { state } = indexed(`function choose(cb,flag){${body}}`);
    const binding = [...state.bindingsById.values()].find(
      (binding) => binding.name === "cb",
    );
    if (binding === undefined) throw new Error("Missing cb binding");
    let reads = 0;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "cb" })
        ) {
          reads++;
          expect(
            semanticBindingAtRead(binding, node.callee, state.parentsByNode)
              .hasDefiniteInitializer,
          ).toBe(expected);
        }
      },
    });
    expect(reads).toBe(1);
  },
);

it("does not reuse a later resolved callback at an earlier read", () => {
  const context = indexed(
    `function fallback(){} function choose(cb){cb();cb=fallback;cb();}`,
  );
  const choose = context.state.program.body[1];
  if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
  const calls = choose.body.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const [before, after] = calls;
  if (before === undefined || after === undefined)
    throw new Error("Missing callback reads");
  expect(context.resolve(after)).toMatchObject({ complete: true });
  expect(context.resolve(before)).toMatchObject({
    complete: false,
    callableIds: [],
  });
  expect(context.resolve(after)).toMatchObject({ complete: true });
});

it.each([false, true])(
  "bounds separate branch assignments with intrinsic cycle=%s",
  (cyclic) => {
    const measure = (depth: number) => {
      const context = indexed(`function fallback(){return {};}
function choose(flag){let a0=${cyclic ? "flag?a0:{make:fallback}" : "{make:fallback}"};
${Array.from({ length: depth }, (_, i) => `let a${i + 1};if(flag)a${i + 1}=a${i};else a${i + 1}=a${i};`).join("")}
return a${depth}.make();}`);
      const choose = context.state.program.body[1];
      if (!t.isFunctionDeclaration(choose)) throw new Error("Missing choose");
      const last = choose.body.body.at(-1);
      if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
        throw new Error("Missing call");
      const lookups = context.state.scopes.map((scope) =>
        vi.spyOn(scope.bindings, "get"),
      );
      try {
        expect(
          createSemanticReturnedReferences(context.state)(last.argument.callee),
        ).toHaveLength(1);
        return lookups.reduce(
          (total, lookup) => total + lookup.mock.calls.length,
          0,
        );
      } finally {
        for (const lookup of lookups) lookup.mockRestore();
      }
    };
    const small = measure(8),
      large = measure(12);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThan(3 * small);
  },
);

it("bounds self-walking writes of one binding by their count", () => {
  // A React-style local reassigned from its own members in many branches
  // (t = t.child, t = t.return, ...) used to be expanded in every order of
  // those writes, each order producing a distinct projection.
  const measure = (writes: number) => {
    const context = indexed(`function fallback(){return {};}
function walk(root, flag){ let t = root; switch (flag) {
${Array.from({ length: writes }, (_, i) => `case ${i}: t = t.key${i}; break;`).join("\n")}
} return t.make(); }`);
    const walk = context.state.program.body.at(-1);
    if (!t.isFunctionDeclaration(walk)) throw new Error("Missing walk");
    const last = walk.body.body.at(-1);
    if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
      throw new Error("Missing call");
    const lookups = context.state.scopes.map((scope) =>
      vi.spyOn(scope.bindings, "get"),
    );
    try {
      expect(
        createSemanticReturnedReferences(context.state)(last.argument.callee),
      ).toHaveLength(0);
      return lookups.reduce(
        (total, lookup) => total + lookup.mock.calls.length,
        0,
      );
    } finally {
      for (const lookup of lookups) lookup.mockRestore();
    }
  };
  const small = measure(8);
  const large = measure(12);
  expect(small).toBeGreaterThan(0);
  // 8 -> 12 writes grew lookups 328,802 -> millions before the bound.
  expect(large).toBeLessThan(3 * small);
});

it("grows a binding's projection once per chain through its own writes", () => {
  const references = (source: string) => {
    const context = indexed(source);
    const run = context.state.program.body.at(-1);
    if (!t.isFunctionDeclaration(run)) throw new Error("Missing run");
    const last = run.body.body.at(-1);
    if (!t.isReturnStatement(last) || !t.isCallExpression(last.argument))
      throw new Error("Missing call");
    return createSemanticReturnedReferences(context.state)(
      last.argument.callee,
    );
  };
  // One self-walk resolves through the literal, as before.
  expect(
    references(`function make(){ return {v:1}; } const root = {next:{make}};
function run(){ let x = root; x = x.next; return x.make(); }`),
  ).toHaveLength(1);
  // Alias cycles at the same depth keep every write.
  expect(
    references(`function make(){ return {v:1}; } const root = {next:{make}};
function run(flag){ let x = root, y = x; if (flag) { x = y; y = x; } x = y.next; return x.make(); }`),
  ).toHaveLength(1);
  // A second self-walk on the same binding is the bound: the chain leaves
  // through writes that do not read its own bindings (x = root) and stops.
  expect(
    references(`function make(){ return {v:1}; } const root = {next:{next:{make}}};
function run(){ let x = root; x = x.next; x = x.next; return x.make(); }`),
  ).toHaveLength(0);
});

it.each(["||=", "??="])(
  "retains definite assignment to an empty local: %s",
  (operator) => {
    const { state } = indexed(
      `function choose(){let cb;cb ${operator} fallback;cb();}`,
    );
    const binding = [...state.bindingsById.values()].find(
      (binding) => binding.name === "cb",
    );
    if (binding === undefined) throw new Error("Missing cb binding");
    let reads = 0;
    traverseJavaScriptAst(state.program, {
      enter(node) {
        if (
          t.isCallExpression(node) &&
          t.isIdentifier(node.callee, { name: "cb" })
        ) {
          reads++;
          expect(
            semanticBindingAtRead(binding, node.callee, state.parentsByNode)
              .hasDefiniteInitializer,
          ).toBe(true);
        }
      },
    });
    expect(reads).toBe(1);
  },
);

it("does not memoize alias cycle cuts across entry paths", () => {
  const context = indexed(
    `function fallback(){} let a,b; function setA(){a=flag?b:fallback;} function setB(){b=a;} a(); b();`,
  );
  const callees = context.state.program.body.flatMap((statement) =>
    t.isExpressionStatement(statement) &&
    t.isCallExpression(statement.expression)
      ? [statement.expression.callee]
      : [],
  );
  const fallback = context.state.callables.find(
    (callable) => callable.name === "fallback",
  );
  if (fallback === undefined) throw new Error("Missing fallback");
  for (const node of [...callees, ...callees].reverse()) {
    const warm = context.resolve(node);
    const cold = resolveLocalCallables({
      node,
      state: context.state,
      callableById: context.callableById,
      bindingCache: new WeakMap(),
      seenInitializers: new Set(),
    });
    expect(warm).toEqual(cold);
    expect(warm).toMatchObject({
      complete: false,
      cycleDependent: true,
      callableIds: [fallback.callableId],
    });
  }
});
