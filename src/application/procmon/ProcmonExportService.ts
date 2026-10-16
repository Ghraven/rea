import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { ProcmonExportPort } from "./ProcmonExportPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  inspectProcmonExportInputSchema,
  procmonExportSchema,
  type InspectProcmonExportInput,
  type ProcmonExport,
} from "../../domain/procmon/procmonExport.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_procmon_export";

/** Shared exact input validation and export-bound Evidence for CLI and MCP. */
export class ProcmonExportService {
  constructor(readonly provider: ProcmonExportPort) {}

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectProcmonExportInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await this.provider.inspect(input.data, options);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const report = procmonExportSchema.safeParse(inspected.value);
    if (
      !report.success ||
      report.data.artifact.path !== input.data.path ||
      JSON.stringify(report.data.selection) !== JSON.stringify(input.data)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Process Monitor reader returned malformed events or changed the selected export identity/options.",
        ),
      );
    return ok(evidenceFor(this.provider.identity, input.data, report.data));
  }
}

const evidenceFor = (
  provider: ProcmonExportPort["identity"],
  parameters: InspectProcmonExportInput,
  value: ProcmonExport,
): Evidence =>
  createEvidence(
    {
      path: value.artifact.path,
      sha256: value.artifact.sha256,
      format: "file",
    },
    provider,
    {
      operation: OPERATION,
      parameters,
      result: value,
      confidence: "observed",
      limitations: value.limitations,
      locations: [{ kind: "artifact-path", path: value.artifact.path }],
    },
  );
