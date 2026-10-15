import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  await readFile(
    new URL("../../../.github/workflows/dsh-bundle.yml", import.meta.url),
    "utf8",
  ),
);
const publication = Object.values(workflow.jobs)
  .flatMap((job) => job.steps ?? [])
  .find((step) => step.name === "Create versioned plugin GitHub release");
assert.equal(typeof publication?.run, "string");

for (const existingDraft of [false, true]) {
  test(
    `plugin ${existingDraft ? "draft publication" : "release creation"} stays out of core Latest selection`,
    { skip: process.platform === "win32" },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "rea-dsh-publication-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const bin = join(root, "bin");
      const record = join(root, "commands.jsonl");
      await mkdir(bin);
      await mkdir(join(root, "release-artifacts"));
      await writeFile(join(root, "release-artifacts/plugin.tgz"), "candidate");
      await writeFile(join(root, "dsh-release.json"), '[{"assets":[]}]');
      await writeFile(
        join(bin, "gh"),
        '#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.REA_TEST_RELEASE_COMMANDS, JSON.stringify(process.argv.slice(2)) + "\\n");\n',
        { mode: 0o700 },
      );
      // Existing-draft fixture has no assets, so both jq membership checks fail.
      await writeFile(join(bin, "jq"), "#!/bin/sh\nexit 1\n", {
        mode: 0o700,
      });
      const result = spawnSync("bash", ["-e", "-c", publication.run], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          RUNNER_TEMP: root,
          GITHUB_REPOSITORY: "morluto/rea",
          GITHUB_SHA: "a".repeat(40),
          RELEASE_TAG: "dsh-v0.2.1",
          RELEASE_PRESENT: String(existingDraft),
          REA_TEST_RELEASE_COMMANDS: record,
        },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const commands = (await readFile(record, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const requests = commands.filter(
        (args) => args[0] === "release" && ["create", "edit"].includes(args[1]),
      );
      assert.equal(requests.length, 1);
      assert.equal(requests[0][1], existingDraft ? "edit" : "create");
      assert.equal(requests[0][2], "dsh-v0.2.1");
      assert.ok(requests[0].includes("--latest=false"), requests[0].join(" "));
      if (existingDraft) assert.ok(requests[0].includes("--draft=false"));
    },
  );
}
