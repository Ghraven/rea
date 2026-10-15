import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/activate-installed.mjs",
);

function fixture(fn, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "rea-desktop-activation-"));
  const home = options.homeDirectory ? join(root, options.homeDirectory) : root;
  const profile = join(home, "profiles", "desktop");
  const bundleDir = join(profile, "node_modules", "dsh-rea-bundle");
  mkdirSync(bundleDir, { recursive: true });
  const earlier = Array.from({ length: 35 }, (_, n) =>
    n === 34 ? "dsh-prompt-enhancer" : "other-" + n,
  );
  const manifest = join(profile, "package.json");
  const document = {
    dependencies: {
      "another-plugin": "1.0.0",
      ...(options.noDependency
        ? {}
        : {
            "dsh-rea-bundle":
              "https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz",
          }),
    },
    dsh: {
      profile: {
        bundles: options.active ? [...earlier, "dsh-rea-bundle"] : earlier,
      },
    },
    settings: { retain: true },
  };
  writeFileSync(manifest, JSON.stringify(document, null, 2) + "\n");
  if (!options.badPackage) {
    writeFileSync(
      join(bundleDir, "package.json"),
      JSON.stringify({
        name: "dsh-rea-bundle",
        version: "0.2.1",
        exports: options.badLauncherExport
          ? { ".": "./launcher.mjs" }
          : { ".": "./launcher.mjs", "./launcher": "./launcher.mjs" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    if (!options.noLauncher)
      writeFileSync(join(bundleDir, "launcher.mjs"), "export {};\n");
    writeFileSync(
      join(bundleDir, "cordis.patch.yml"),
      options.patch ??
        readFileSync(resolve(dirname(script), "../cordis.patch.yml"), "utf8"),
    );
  }
  const run = (args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DSH_HOME: Object.hasOwn(options, "dshHome") ? options.dshHome : home,
      },
    });
  try {
    fn({ home, manifest, profile, document, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function backups(profile) {
  return readdirSync(profile).filter((item) =>
    item.startsWith("package.json.rea-backup-"),
  );
}

for (const [label, value, directory] of [
  ["unset", undefined, ".dsh"],
  ["empty", "", ".dsh"],
  ["blank", " \t ", ".dsh"],
  ["bare tilde", "~", undefined],
  ["tilde child", "~/.dsh", ".dsh"],
  ["backslash tilde child", "~\\.dsh", ".dsh"],
  ["relative", ".dsh", ".dsh"],
  ["meaningful spaces", "  .dsh  ", "  .dsh  "],
]) {
  test(`recovery uses Harness home semantics for ${label}`, () => {
    fixture(
      ({ manifest, profile, run }) => {
        const original = readFileSync(manifest);
        const status = run(["--status"]);
        assert.equal(status.status, 0, status.stderr);
        assert(status.stdout.includes(`Profile: ${profile}`));
        assert.match(status.stdout, /Installed in dependencies: yes/);
        assert.deepEqual(readFileSync(manifest), original);
        assert.deepEqual(backups(profile), []);
        const first = run(["--activate"]);
        assert.equal(first.status, 0, first.stderr);
        assert.equal(backups(profile).length, 1);
        assert.deepEqual(
          readFileSync(join(profile, backups(profile)[0])),
          original,
        );
        assert.equal(run(["--activate"]).status, 0);
        assert.equal(backups(profile).length, 1);
      },
      { dshHome: value, homeDirectory: directory },
    );
  });
}

test("status reports installed-but-disabled without changing the profile", () => {
  fixture(({ manifest, profile, run }) => {
    const original = readFileSync(manifest);
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Enabled in dsh\.profile\.bundles: NO \(35 bundles\)/,
    );
    assert.deepEqual(readFileSync(manifest), original);
    assert.deepEqual(backups(profile), []);
  });
});

test("activation preserves 35 entries, other dependencies and exact backup; is idempotent", () => {
  fixture(({ manifest, profile, document, run }) => {
    const old = readFileSync(manifest);
    const first = run(["--activate"]);
    assert.equal(first.status, 0, first.stderr);
    const after = JSON.parse(readFileSync(manifest, "utf8"));
    assert.deepEqual(
      after.dsh.profile.bundles.slice(0, 35),
      document.dsh.profile.bundles,
    );
    assert.equal(after.dsh.profile.bundles[35], "dsh-rea-bundle");
    assert.deepEqual(after.dependencies, document.dependencies);
    assert.deepEqual(after.settings, document.settings);
    assert.equal(backups(profile).length, 1);
    assert.deepEqual(readFileSync(join(profile, backups(profile)[0])), old);
    const newer = readFileSync(manifest);
    const second = run(["--activate"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Already enabled/);
    assert.deepEqual(readFileSync(manifest), newer);
    assert.equal(backups(profile).length, 1);
  });
});

test("rejects missing dependency, invalid bundle, and malformed profile without writing", () => {
  for (const options of [
    { noDependency: true },
    { badPackage: true },
    { noLauncher: true },
    { badLauncherExport: true },
  ]) {
    fixture(({ manifest, profile, run }) => {
      const original = readFileSync(manifest);
      const outcome = run(["--activate"]);
      assert.notEqual(outcome.status, 0);
      assert.deepEqual(readFileSync(manifest), original);
      assert.deepEqual(backups(profile), []);
    }, options);
  }
  fixture(({ manifest, profile, run }) => {
    writeFileSync(manifest, "{ corrupt");
    assert.notEqual(run(["--activate"]).status, 0);
    assert.deepEqual(backups(profile), []);
  });
});

test("activation refuses a symlinked profile manifest without replacing its link", () => {
  fixture(({ manifest, profile, home, run }) => {
    const target = join(home, "managed-package.json");
    const original = readFileSync(manifest);
    writeFileSync(target, original);
    rmSync(manifest);
    symlinkSync(target, manifest);
    const outcome = run(["--activate"]);
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /manifest is a symlink/);
    assert.equal(readFileSync(manifest, "utf8"), original.toString("utf8"));
    assert.deepEqual(backups(profile), []);
  });
});

test("verification leaves live composition unknown instead of inventing compiled root rows", () => {
  fixture(
    ({ profile, run }) => {
      writeFileSync(join(profile, "cordis.yml"), "[]\n");
      const outcome = run(["--verify"]);
      assert.notEqual(outcome.status, 0);
      assert.match(
        outcome.stderr,
        /Live Desktop composition remains unverified/,
      );
    },
    { active: true },
  );
});

test("unknown options and malformed bundle array fail closed", () => {
  fixture(({ manifest, profile, run }) => {
    assert.notEqual(run(["--activate", "--verify"]).status, 0);
    const p = JSON.parse(readFileSync(manifest, "utf8"));
    p.dsh.profile.bundles = "invalid";
    writeFileSync(manifest, JSON.stringify(p));
    assert.notEqual(run(["--activate"]).status, 0);
    assert.deepEqual(backups(profile), []);
  });
});

test("duplicate bundle selection is rejected without modifying any file", () => {
  fixture(({ manifest, profile, run }) => {
    const p = JSON.parse(readFileSync(manifest, "utf8"));
    p.dsh.profile.bundles.push("other-2");
    writeFileSync(manifest, JSON.stringify(p) + "\n");
    const before = readFileSync(manifest);
    const outcome = run(["--activate"]);
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /duplicates/);
    assert.deepEqual(readFileSync(manifest), before);
    assert.deepEqual(backups(profile), []);
  });
});

test("activation refuses invalid or incomplete owned patches before profile mutation", () => {
  const valid = readFileSync(
    resolve(dirname(script), "../cordis.patch.yml"),
    "utf8",
  );
  for (const patch of [
    "- insert: [", // malformed YAML
    "- insert:\n    - id: rea-launcher\n      name: dsh-rea-bundle/launcher\n    - id: rea-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n",
    valid.replace("inject: [reaLauncher]", "inject: []"),
    valid.replace(
      "command: !!js ctx.reaLauncher.command",
      "command: ctx.reaLauncher.command",
    ),
    valid.replace(
      "args: !!js ctx.reaLauncher.args",
      "args: !!js ctx.other.args",
    ),
    valid.replace("transport: stdio", "transport: sse"),
    valid.replace("failOnStartupError: true", "failOnStartupError: false"),
    valid.replace(
      "serverName: rea",
      "serverName: rea\n        serverName: other",
    ),
  ])
    fixture(
      ({ manifest, profile, run }) => {
        const original = readFileSync(manifest);
        const result = run(["--activate"]);
        assert.notEqual(result.status, 0);
        assert.deepEqual(readFileSync(manifest), original);
        assert.deepEqual(backups(profile), []);
      },
      { patch },
    );
});
