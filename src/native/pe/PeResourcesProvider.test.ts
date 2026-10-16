import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { inspectPeResourcesInputSchema } from "../../domain/native/peResources.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PeResourcesProvider } from "./PeResourcesProvider.js";
import { peResourceFixture } from "./PeResources.fixture.js";

const inspect = async (
  path: string,
  input: {
    readonly max_file_bytes?: number;
    readonly max_entries?: number;
  } = {},
) => {
  const provider = new PeResourcesProvider();
  try {
    return await provider.inspect(
      inspectPeResourcesInputSchema.parse({ path, ...input }),
    );
  } finally {
    await provider.close();
  }
};

describe("PE resource provider budget reporting", () => {
  it("reports an input byte budget as a file-size bound", async () => {
    const root = await createTestTempDirectory("rea-pe-input-budget-");
    const path = join(root, "resource.exe");
    await writeFile(path, peResourceFixture().bytes);
    const result = await inspect(path, { max_file_bytes: 64 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a refusal");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "file-size",
    });
    expect(result.error.message).toContain(
      "Selected artifact exceeds 64 bytes",
    );
    expect(
      (result.error as AnalysisResourceConstraintError).reportedLimits,
    ).toMatchObject({ max_file_bytes: 64 });
  });

  it("reports an entry budget as a capacity bound", async () => {
    const root = await createTestTempDirectory("rea-pe-entry-budget-");
    const path = join(root, "resource.exe");
    await writeFile(path, peResourceFixture().bytes);
    const result = await inspect(path, { max_entries: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "capacity",
    });
    expect(result.error.message).toContain("entry budget exceeded");
  });

  it("reports a file-size budget without memory remediation advice", async () => {
    const root = await createTestTempDirectory("rea-pe-budget-advice-");
    const path = join(root, "resource.exe");
    await writeFile(path, peResourceFixture().bytes);
    const result = await inspect(path, { max_file_bytes: 64 });
    if (result.ok) throw new Error("Expected a refusal");
    const error = result.error as AnalysisResourceConstraintError;
    expect(error.resource).toBe("file-size");
    expect(JSON.stringify(error)).not.toContain("memory");
  });
});
