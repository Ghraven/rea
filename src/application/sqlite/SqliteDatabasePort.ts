import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectSqliteDatabaseInput,
  SqliteRowSelection,
} from "../../domain/sqlite/sqliteDatabase.js";
import type { Result } from "../../domain/result.js";

export interface SqliteDatabaseExecution extends AnalysisExecution {
  readonly rowSelection?: SqliteRowSelection | null;
}

/** Offline database inspection boundary shared by CLI and MCP. */
export interface SqliteDatabasePort {
  /** Await and retry provider-owned snapshot cleanup. */
  close?(): Promise<void>;
  inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<SqliteDatabaseExecution, AnalysisError>>;
}
