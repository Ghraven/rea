import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/prepare-desktop-install.sh",
);

test("Desktop installer validates as Bash and documents the Git-root failure", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /build-required rea-agents CLI/);
  assert.match(help.stdout, /Desktop > Plugins > Add plugin/);
});

test("Desktop installer rejects an invalid checksum manifest without changing profile", () => {
  const home = mkdtempSync(join(tmpdir(), "rea-desktop-install-"));
  const bin = join(home, "bin");
  const profile = join(home, "profiles", "desktop");
  try {
    mkdirSync(bin);
    mkdirSync(profile, { recursive: true });
    const manifest = '{"dependencies":{"another-plugin":"1.2.3"}}';
    writeFileSync(join(profile, "package.json"), manifest);
    const mockCurl = join(bin, "curl");
    writeFileSync(
      mockCurl,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--output" ]; then\n shift\n printf "%s" bad-archive > "$1"\n exit 0\n fi\n shift\ndone\nexit 9\n',
    );
    chmodSync(mockCurl, 0o755);
    const run = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DSH_HOME: home,
        PATH: [bin, process.env.PATH].join(":"),
      },
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /SHA-256 mismatch/);
    assert.equal(
      existsSync(join(home, "plugin-packages", "dsh-rea-bundle-0.2.1.tgz")),
      false,
    );
    assert.deepEqual(readdirSync(join(home, "plugin-packages")), []);
    assert.equal(readFileSync(join(profile, "package.json"), "utf8"), manifest);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const dshHome of ["~/.dsh", " \t ", "  plugin home  "]) {
  test(`download uses Harness home semantics for ${JSON.stringify(dshHome)}`, () => {
    const root = mkdtempSync(join(tmpdir(), "rea-desktop-path-"));
    const bin = join(root, "bin");
    const home = join(
      root,
      dshHome.trim() && !dshHome.startsWith("~") ? dshHome : ".dsh",
    );
    const archive = Buffer.from("fixture bundle bytes");
    const name = "dsh-rea-bundle-0.2.1.tgz";
    try {
      mkdirSync(bin);
      writeFileSync(join(root, "archive"), archive);
      writeFileSync(
        join(root, "checksums"),
        `${createHash("sha256").update(archive).digest("hex")}  ${name}\n`,
      );
      const curl = join(bin, "curl");
      writeFileSync(
        curl,
        '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--output" ]; then shift; output="$1"; fi\n url="$1"; shift\ndone\ncase "$url" in */SHA256SUMS) cp "$REA_TEST_DOWNLOAD/checksums" "$output";; *) cp "$REA_TEST_DOWNLOAD/archive" "$output";; esac\n',
      );
      chmodSync(curl, 0o755);
      const environment = {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        DSH_HOME: dshHome,
        REA_TEST_DOWNLOAD: root,
        PATH: [bin, process.env.PATH].join(":"),
      };
      const result = spawnSync("bash", [script], {
        cwd: root,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, 0, result.stderr);
      const target = join(home, "plugin-packages", name);
      assert(result.stdout.includes(`Verified REA plugin: ${target}`));
      assert.deepEqual(readFileSync(target), archive);
      assert.deepEqual(readdirSync(join(home, "plugin-packages")), [name]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a valid checksum manifest cannot admit a corrupt archive", () => {
  const root = mkdtempSync(join(tmpdir(), "rea-desktop-corrupt-"));
  const bin = join(root, "bin");
  try {
    mkdirSync(bin);
    const curl = join(bin, "curl");
    writeFileSync(
      curl,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--output" ]; then shift; output="$1"; fi\n url="$1"; shift\ndone\nprintf "%s\\n" "$url" >> "$REA_TEST_DOWNLOAD/calls"\ncase "$url" in */SHA256SUMS) printf "%s  dsh-rea-bundle-0.2.1.tgz\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$output";; *) printf bad-archive > "$output";; esac\n',
    );
    chmodSync(curl, 0o755);
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DSH_HOME: root,
        REA_TEST_DOWNLOAD: root,
        PATH: [bin, process.env.PATH].join(":"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 mismatch; refusing installation/);
    assert.equal(
      readFileSync(join(root, "calls"), "utf8").trim().split("\n").length,
      2,
    );
    assert.deepEqual(readdirSync(join(root, "plugin-packages")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
