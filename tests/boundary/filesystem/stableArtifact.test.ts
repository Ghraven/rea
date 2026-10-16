import {
  lstat,
  open,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  readStableArtifact,
  readStableArtifactRanges,
} from "../../../src/artifacts/readStableArtifact.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("reads exact binary and empty bytes and rejects symlink/size/cancellation boundaries", async () => {
  const root = await createTestTempDirectory("rea-stable-artifact-");
  const path = join(root, "source.bin");
  await writeFile(path, Buffer.from([0, 255, 254]));
  expect((await readStableArtifact(path, 3)).bytes).toEqual(
    Buffer.from([0, 255, 254]),
  );
  await expect(readStableArtifact(path, 2)).rejects.toMatchObject({
    reason: "limit",
  });
  await writeFile(path, "");
  expect((await readStableArtifact(path, 0)).bytes.length).toBe(0);
  const real = join(root, "original.bin");
  await rename(path, real);
  await symlink(real, path);
  await expect(readStableArtifact(path, 3)).rejects.toMatchObject({
    reason: "path",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    readStableArtifact(real, 3, controller.signal),
  ).rejects.toMatchObject({
    reason: "cancelled",
    cause: controller.signal.reason,
  });
});

const checkChange = async (
  stage: "before-open" | "after-read" | "symlink-replacement",
): Promise<void> => {
  const root = await createTestTempDirectory("rea-stable-read-");
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  const reading = readStableArtifact(path, 1024, undefined, {
    async lstat(selected) {
      inspected++;
      if (stage === "after-read" && inspected === 2) await unlink(selected);
      const metadata = await lstat(selected, { bigint: true });
      if (inspected === 1 && stage !== "after-read") {
        await unlink(selected);
        if (stage === "symlink-replacement") await symlink("missing", selected);
      }
      return metadata;
    },
    open,
  });
  await expect(reading).rejects.toMatchObject({ reason: "integrity" });
};

it.each(["before-open", "after-read"] as const)(
  "retains an actual post-validation %s change as integrity failure",
  checkChange,
);

it.skipIf(process.platform === "win32")(
  "retains a post-validation symlink replacement as an integrity failure",
  () => checkChange("symlink-replacement"),
);

it("keeps initially missing inputs distinguishable from later changes", async () => {
  const root = await createTestTempDirectory("rea-stable-missing-");
  await expect(
    readStableArtifact(join(root, "missing"), 1024),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("decodes ranges and hashes the whole file through one admitted descriptor", async () => {
  const root = await createTestTempDirectory("rea-stable-ranges-");
  const path = join(root, "source.bin");
  const bytes = Buffer.from("0123456789abcdef");
  await writeFile(path, bytes);
  const {
    result,
    sha256,
    bytes: size,
  } = await readStableArtifactRanges(path, async (source) =>
    Buffer.concat([await source.read(14, 2), await source.read(0, 3)]),
  );
  expect(result.toString()).toBe("ef012");
  expect(size).toBe(16);
  expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  await expect(
    readStableArtifactRanges(path, (source) => source.read(10, 7)),
  ).rejects.toBeInstanceOf(RangeError);
  const link = join(root, "link.bin");
  await symlink(path, link);
  await expect(
    readStableArtifactRanges(link, (source) => source.read(0, 1)),
  ).rejects.toMatchObject({ reason: "path" });
});

it("rejects a file changed after its ranges were decoded", async () => {
  const root = await createTestTempDirectory("rea-stable-ranges-change-");
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  const reading = readStableArtifactRanges(
    path,
    (source) => source.read(0, 4),
    undefined,
    undefined,
    {
      async lstat(selected) {
        inspected++;
        if (inspected === 2) await unlink(selected);
        return lstat(selected, { bigint: true });
      },
      open,
    },
  );
  await expect(reading).rejects.toMatchObject({ reason: "integrity" });
});
