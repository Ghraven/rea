import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply, resolveReaLauncher } from "../launcher.mjs";

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rea-dsh-"));
  const launcher = join(dir, "rea.mjs");
  writeFileSync(launcher, "#!/usr/bin/env node\n");
  try {
    return fn(launcher);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("launches a packaged REA using the active Node without shell or network install", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: {},
      execPath: "/usr/local/bin/node",
      resolvePackage: (specifier) => {
        assert.equal(specifier, "rea-agents/scripts/rea.mjs");
        return launcher;
      },
    });
    assert.deepEqual(result, {
      command: "/usr/local/bin/node",
      args: [launcher, "mcp"],
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
      toolCallTimeoutMs: 2147483647,
    });
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.args));
  }));

test("explicit local fork launcher takes precedence without npm resolution", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: { REA_DSH_ENTRYPOINT: launcher, REA_DSH_SCHEMA_PROFILE: "full" },
      resolvePackage: () => {
        throw new Error("should never resolve npm");
      },
    });
    assert.deepEqual(result.args, [launcher, "mcp"]);
    assert.deepEqual(result.env, { REA_MCP_INPUT_SCHEMA_PROFILE: "full" });
  }));

test("preserves symlink-before-parent traversal for an explicitly selected REA", () =>
  withFixture((decoy) => {
    const root = dirname(decoy);
    const selected = join(root, "selected");
    mkdirSync(join(selected, "child"), { recursive: true });
    const entry = join(selected, "rea.mjs");
    writeFileSync(entry, "console.log('selected runtime');\n");
    symlinkSync(join(selected, "child"), join(root, "linked"));
    const requested = join(root, "linked") + "/../rea.mjs";
    const env = { REA_DSH_ENTRYPOINT: requested };
    const result = resolveReaLauncher({ env });
    assert.equal(
      execFileSync(result.command, result.args, { encoding: "utf8" }),
      "selected runtime\n",
    );
    assert.equal(realpathSync(result.args[0]), entry);
    assert.equal(env.REA_DSH_ENTRYPOINT, requested);
  }));

test("an alias of the Electron executable cannot become the standalone Node", () =>
  withFixture((entry) => {
    const host = join(dirname(entry), "electron");
    const alias = join(dirname(entry), "node-alias");
    writeFileSync(host, "// application executable fixture\n");
    symlinkSync(host, alias);
    assert.throws(
      () =>
        resolveReaLauncher({
          env: { REA_DSH_ENTRYPOINT: entry, REA_DSH_NODE_PATH: alias },
          execPath: host,
          electronVersion: "fixture",
        }),
      /standalone Node/,
    );
  }));

test("a caller-selected standalone Node alias retains its lookup path", () =>
  withFixture((entry) => {
    const host = join(dirname(entry), "electron");
    const alias = join(dirname(entry), "node-alias");
    writeFileSync(host, "// application executable fixture\n");
    symlinkSync(process.execPath, alias);
    const result = resolveReaLauncher({
      env: { REA_DSH_ENTRYPOINT: entry, REA_DSH_NODE_PATH: alias },
      execPath: host,
      electronVersion: "fixture",
    });
    assert.equal(result.command, alias);
  }));

test("rejects absent/relative overrides, bad schemas, and missing npm runtime", () => {
  assert.throws(
    () =>
      resolveReaLauncher({ env: { REA_DSH_ENTRYPOINT: "scripts/rea.mjs" } }),
    /absolute path/,
  );
  assert.throws(
    () =>
      resolveReaLauncher({ env: { REA_DSH_ENTRYPOINT: "/missing/no.mjs" } }),
    /not a regular file/,
  );
  assert.throws(
    () =>
      resolveReaLauncher({
        env: {},
        resolvePackage: () => {
          throw Error("not found");
        },
      }),
    /runtime is unavailable/,
  );
  withFixture((launcher) => {
    assert.throws(
      () =>
        resolveReaLauncher({
          env: {
            REA_DSH_ENTRYPOINT: launcher,
            REA_DSH_SCHEMA_PROFILE: "random",
          },
        }),
      /either compact or full/,
    );
  });
});

test("does not pass ambient credentials into the generated MCP env", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: {
        REA_DSH_ENTRYPOINT: launcher,
        AWS_SECRET_ACCESS_KEY: "sentinel",
        OPENAI_API_KEY: "sentinel",
      },
    });
    assert.deepEqual(Object.keys(result.env), ["REA_MCP_INPUT_SCHEMA_PROFILE"]);
  }));

test("forwards the caller's supported Ghidra heap controls", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: {
        REA_DSH_ENTRYPOINT: launcher,
        GHIDRA_HEADLESS_MAXMEM: "4G",
        GHIDRA_MAXMEM: "2G",
      },
    });
    assert.deepEqual(result.env, {
      GHIDRA_HEADLESS_MAXMEM: "4G",
      GHIDRA_MAXMEM: "2G",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    });
  }));

test("preserves documented JADX JVM overrides without unrelated ambient values", () =>
  withFixture((launcher) => {
    const controls = {
      JAVA_TOOL_OPTIONS: "-Xmx512m -Duser.timezone=UTC",
      JDK_JAVA_OPTIONS: "-Dfile.encoding=UTF-8",
      _JAVA_OPTIONS: "-Xms64m",
    };
    const result = resolveReaLauncher({
      env: {
        REA_DSH_ENTRYPOINT: launcher,
        ...controls,
        UNRELATED_CONFIG: "sentinel",
      },
    });
    assert.deepEqual(result.env, {
      ...controls,
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    });
  }));

test("forwards the caller's pwntools input-size limit", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: {
        REA_DSH_ENTRYPOINT: launcher,
        REA_PWNTOOLS_MAX_INPUT_BYTES: "67108864",
      },
    });
    assert.deepEqual(result.env, {
      REA_PWNTOOLS_MAX_INPUT_BYTES: "67108864",
      REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    });
  }));

test("the Cordis adapter provides its owned service", () =>
  withFixture((launcher) => {
    const previous = process.env.REA_DSH_ENTRYPOINT;
    process.env.REA_DSH_ENTRYPOINT = launcher;
    try {
      const calls = [];
      apply({ provide: (name, value) => calls.push([name, value]) });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "reaLauncher");
      assert.deepEqual(calls[0][1].args, [launcher, "mcp"]);
    } finally {
      if (previous === undefined) delete process.env.REA_DSH_ENTRYPOINT;
      else process.env.REA_DSH_ENTRYPOINT = previous;
    }
  }));

test("preserves an explicitly selected client deadline and rejects invalid timer values", () => {
  const options = {
    env: { REA_DSH_TOOL_CALL_TIMEOUT_MS: "300001" },
    execPath: "/usr/local/bin/node",
    resolvePackage: () => "/installed/rea/scripts/rea.mjs",
    fileExists: () => true,
  };
  assert.equal(resolveReaLauncher(options).toolCallTimeoutMs, 300001);
  for (const value of ["0", "-1", "1.5", "2147483648", "invalid"])
    assert.throws(
      () =>
        resolveReaLauncher({
          ...options,
          env: { REA_DSH_TOOL_CALL_TIMEOUT_MS: value },
        }),
      /REA_DSH_TOOL_CALL_TIMEOUT_MS/,
    );
});
