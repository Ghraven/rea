import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { immutableEvidence } from "../../domain/evidence.js";
import { clusterArtifactFamilies } from "../../domain/artifactFamilyClustering.js";
import { readJsonFile } from "../JsonFiles.js";

/**
 * Cluster artifact inventories supplied as Evidence JSON files. The CLI has no
 * session, so each member is one complete Evidence document read from disk;
 * retained references and summaries stay MCP-only.
 */
export const clusterArtifactEvidenceCommand = async (input: {
  readonly memberPaths: readonly string[];
  readonly sharedMemberMinimum?: number;
  readonly offset: number;
  readonly limit: number;
}): Promise<Result<JsonValue, AnalysisError>> => {
  const documents: unknown[] = [];
  // Read in the caller's order so the reported labels match the supplied paths.
  for (const path of input.memberPaths) {
    const document = await readJsonFile(path);
    if (!document.ok) return document;
    documents.push(document.value);
  }
  try {
    const members = documents.map((document, index) => ({
      // The path is the caller's own label; it is never parsed as identity.
      label: input.memberPaths[index]!,
      // Sealing on admission makes the domain's own authentication pass a
      // snapshot hit instead of a second full re-hash of the inventory.
      evidence: immutableEvidence(document),
    }));
    return ok(
      jsonValueSchema.parse(
        clusterArtifactFamilies(members, {
          ...(input.sharedMemberMinimum === undefined
            ? {}
            : { sharedMemberMinimum: input.sharedMemberMinimum }),
          offset: input.offset,
          limit: input.limit,
        }),
      ),
    );
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError("Artifact family clustering failed", {
        cause,
      }),
    );
  }
};
