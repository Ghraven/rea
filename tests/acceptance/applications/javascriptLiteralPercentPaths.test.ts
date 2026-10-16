import { expect } from "vitest";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const cases = [
  {
    directory: "literal",
    expression: 'path.join(__dirname, "preload%2F%5C%2E.cjs")',
    target: "preload%2F%5C%2E.cjs",
    status: "resolved",
  },
  {
    directory: "converted",
    expression:
      'fileURLToPath(new URL("./preload%252Fname.cjs", import.meta.url))',
    target: "preload%2Fname.cjs",
    status: "resolved",
  },
  {
    directory: "escaped",
    expression: 'path.join(__dirname, "../../outside%2Fname.cjs")',
    target: null,
    status: "rejected",
  },
  {
    directory: "ignored-prefix",
    expression:
      'path.resolve(new URL("./", import.meta.url), path.dirname(fileURLToPath(import.meta.url)), "preload%2Fname.cjs")',
    target: "preload%2Fname.cjs",
    status: "resolved",
  },
] as const;

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves literal-percent runtime paths through %s without executing source",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-runtime-percent-");
    const inert = 'throw new Error("fixture source must never execute");';
    const loadFileSource = `const { BrowserWindow } = require("electron");
      const win = new BrowserWindow();
      win.loadFile("dist%2Findex.html");
      win.loadFile("plain.html");
      win.loadFile("absent.html");`;
    await writeFixtureFiles(root, {
      ...Object.fromEntries(
        cases.map(({ directory, expression }) => [
          `${directory}/main.mjs`,
          `import { BrowserWindow, utilityProcess } from "electron";
         import path from "node:path";
         import { fileURLToPath } from "node:url";
         new BrowserWindow({ webPreferences: { preload: ${expression} } });
         utilityProcess.fork(${expression});`,
        ]),
      ),
      "literal/preload%2F%5C%2E.cjs": inert,
      "converted/preload%2Fname.cjs": inert,
      "converted/preload%252Fname.cjs": inert,
      "converted/preload/name.cjs": inert,
      "outside%2Fname.cjs": inert,
      "ignored-prefix/preload%2Fname.cjs": inert,
      "sub/main.cjs": loadFileSource,
      "dist%2Findex.html": "application target",
      "plain.html": "application target",
      "sub/dist%2Findex.html": "nested decoy",
      "sub/plain.html": "nested decoy",
      "sub/absent.html": "nested-only decoy",
    });
    const archiveSource = await createTestTempDirectory("rea-loadfile-asar-");
    await writeFixtureFiles(archiveSource, {
      "sub/main.cjs": loadFileSource,
      "dist%2Findex.html": "application target",
      "plain.html": "application target",
      "sub/dist%2Findex.html": "nested decoy",
      "sub/plain.html": "nested decoy",
      "sub/absent.html": "nested-only decoy",
    });
    await createPackageWithOptions(archiveSource, join(root, "a.asar"), {});
    // Equal container digests must not select the other archive occurrence.
    await copyFile(join(root, "a.asar"), join(root, "b.asar"));

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const [prefix, declared] of ["", "a.asar/", "b.asar/"].flatMap(
      (prefix) =>
        ["dist%2Findex.html", "plain.html", "absent.html"].map(
          (declared) => [prefix, declared] as const,
        ),
    )) {
      const role = graph.nodes.find(
        ({ kind, observations }) =>
          kind === "electron-renderer" &&
          observations.some(
            ({ properties, evidence }) =>
              properties.declared_path === declared &&
              evidence.location.available &&
              evidence.location.value.kind === "source-range" &&
              evidence.location.value.source === `${prefix}sub/main.cjs`,
          ),
      );
      expect(role).toBeDefined();
      if (role === undefined) throw new Error(`Missing loadFile ${declared}`);
      const expected =
        declared === "absent.html" ? null : `${prefix}${declared}`;
      expect(role.observations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              declared_path: declared,
              runtime_path_base: "application-root",
              resolved_path: expected,
              resolution_status: expected === null ? "not-found" : "resolved",
            }),
          }),
        ]),
      );
      expect(
        graph.edges
          .filter(
            ({ relation, source_node_id }) =>
              relation === "maps_to" && source_node_id === role.node_id,
          )
          .map(({ properties }) => properties.resolved_path),
      ).toEqual(expected === null ? [] : [expected]);
    }
    for (const { directory, target, status } of cases) {
      for (const kind of ["electron-preload", "electron-utility"] as const) {
        const nodes = graph.nodes.filter(
          ({ kind: nodeKind, observations }) =>
            nodeKind === kind &&
            observations.some(
              ({ evidence }) =>
                evidence.location.available &&
                evidence.location.value.kind === "source-range" &&
                evidence.location.value.source === `${directory}/main.mjs`,
            ),
        );
        expect(nodes).toHaveLength(1);
        const node = nodes[0];
        if (node === undefined) throw new Error(`Missing ${directory} ${kind}`);
        const resolutions = node.observations.filter(
          ({ properties }) => "resolution_status" in properties,
        );
        expect(resolutions).not.toHaveLength(0);
        for (const { properties } of resolutions) {
          expect(properties).toMatchObject({
            resolved_path: target === null ? null : `${directory}/${target}`,
            resolution_status: status,
          });
        }
        const mappedPaths = graph.edges
          .filter(
            ({ relation, source_node_id }) =>
              relation === "maps_to" && source_node_id === node.node_id,
          )
          .map(({ properties }) => properties.resolved_path);
        expect([...new Set(mappedPaths)]).toEqual(
          target === null ? [] : [`${directory}/${target}`],
        );
      }
    }
  },
);
