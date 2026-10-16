import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectProcmonExportInput,
  ProcmonExport,
} from "../../domain/procmon/procmonExport.js";
import type { Result } from "../../domain/result.js";

/** Replaceable reader for recorded exports with no capture or execution authority. */
export interface ProcmonExportPort {
  readonly identity: ProviderIdentity;
  inspect(
    input: InspectProcmonExportInput,
    options?: ExecutionOptions,
  ): Promise<Result<ProcmonExport, AnalysisError>>;
}
