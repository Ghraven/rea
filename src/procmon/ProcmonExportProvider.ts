import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { ProcmonExportPort } from "../application/procmon/ProcmonExportPort.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import {
  PROCMON_CORE_COLUMNS,
  PROCMON_EXPORT_LIMITS,
  procmonExportSchema,
  type InspectProcmonExportInput,
  type ProcmonExport,
} from "../domain/procmon/procmonExport.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  procmonCoreColumn,
  ProcmonExportFormatFailure,
  ProcmonExportOutputFailure,
} from "./ProcmonExportEvents.js";
import {
  readProcmonExport,
  type ProcmonExportReading,
} from "./ProcmonExportReader.js";

/** Bundled reader identity; it never launches Process Monitor or loads a driver. */
export const PROCMON_EXPORT_PROVIDER_IDENTITY = {
  id: "procmon-export",
  name: "REA Process Monitor export reader",
  version: "1",
} as const;
const OPERATION = "inspect_procmon_export";

/** In-process parsing of one recorded export without subprocesses or temporary files. */
export class ProcmonExportProvider implements ProcmonExportPort {
  readonly identity = PROCMON_EXPORT_PROVIDER_IDENTITY;

  async inspect(
    input: InspectProcmonExportInput,
    options?: ExecutionOptions,
  ): Promise<Result<ProcmonExport, AnalysisError>> {
    try {
      const snapshot = await readStableArtifact(
        input.path,
        PROCMON_EXPORT_LIMITS.input_bytes,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      const reading = await readProcmonExport(
        snapshot.bytes,
        input,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      const parsed = procmonExportSchema.safeParse({
        artifact: {
          path: input.path,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes.length,
        },
        selection: input,
        ...reading,
        limitations: limitationsFor(reading),
        live_capture: "not-performed",
      });
      if (
        parsed.success &&
        Buffer.byteLength(JSON.stringify(parsed.data), "utf8") >
          PROCMON_EXPORT_LIMITS.output_bytes
      )
        throw new ProcmonExportOutputFailure(parsed.data.events.length);
      if (!parsed.success)
        throw new AnalysisOutputError(
          OPERATION,
          "Process Monitor reader produced an invalid event report.",
          { cause: parsed.error },
        );
      return ok(parsed.data);
    } catch (cause: unknown) {
      return err(failureFor(cause, input.path, options?.signal));
    }
  }
}

const limitationsFor = (reading: ProcmonExportReading): string[] => [
  "Events are text recorded by whoever exported the capture. They are not authenticated and do not show what the events mean.",
  "Process Monitor's native PML format and live capture are not supported. Only events present in the selected XML or CSV export are read.",
  ...(reading.missing_columns.length > 0
    ? [
        `The export has no ${reading.missing_columns.join(", ")} column; those event fields are null, not empty.`,
      ]
    : []),
  ...unseenColumnLimitation(reading),
  ...(reading.omitted_nested_fields.length > 0
    ? [
        `Nested event fields (${reading.omitted_nested_fields.join(", ")}) are not projected.`,
      ]
    : []),
  ...(reading.source.format === "xml"
    ? [
        "The XML process list is not read; process names, PIDs and other fields come from each event.",
      ]
    : []),
  ...(reading.coverage.status === "partial"
    ? [
        "Reading stopped before the end of the export. Events after the stopping point were not examined, so their absence is not established.",
      ]
    : []),
];

/** Partial XML cannot show that a column is absent from the whole export. */
const unseenColumnLimitation = (reading: ProcmonExportReading): string[] => {
  if (reading.source.format !== "xml" || reading.coverage.status !== "partial")
    return [];
  // A projected field with child elements was seen, though not projected.
  const seen = new Set(
    [...reading.source.columns, ...reading.omitted_nested_fields].map(
      (column) => procmonCoreColumn(column, "xml"),
    ),
  );
  const unseen = PROCMON_CORE_COLUMNS.filter((column) => !seen.has(column));
  return unseen.length === 0
    ? []
    : [
        `${unseen.join(", ")} did not appear before reading stopped; later events may contain them, so missing_columns is empty rather than claiming they are absent.`,
      ];
};

const failureFor = (
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION);
  if (cause instanceof ProcmonExportOutputFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "transport",
      `Selected export ${path}: ${cause.message}`,
      { maximum_output_bytes: PROCMON_EXPORT_LIMITS.output_bytes },
      { cause },
    );
  if (cause instanceof ProcmonExportFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(OPERATION, path, cause.message, {
          cause,
        })
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected export ${path}: ${cause.message}`,
          },
        ]);
  if (cause instanceof ArtifactReaderFailure)
    return artifactReaderFailure(cause, path);
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected export could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(
    PROCMON_EXPORT_PROVIDER_IDENTITY.id,
    OPERATION,
    {
      cause,
      diagnostics: {
        path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    },
  );
};

const artifactReaderFailure = (
  cause: ArtifactReaderFailure,
  path: string,
): AnalysisError => {
  if (cause.reason === "integrity")
    return new AnalysisArtifactChangedError(OPERATION, path, cause.message, {
      cause,
    });
  if (cause.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION);
  if (cause.reason === "limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      cause.message,
      { maximum_input_bytes: PROCMON_EXPORT_LIMITS.input_bytes },
      { cause },
    );
  if (cause.reason === "path")
    return new AnalysisInputError(OPERATION, { cause }, [
      { path: ["path"], reason: "invalid_format", message: cause.message },
    ]);
  return new ProviderAdapterError(
    PROCMON_EXPORT_PROVIDER_IDENTITY.id,
    OPERATION,
    { cause, diagnostics: { path, reason: cause.message } },
  );
};
