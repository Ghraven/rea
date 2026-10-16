import {
  inspectProcmonExportInputSchema,
  procmonExportSchema,
} from "../../domain/procmon/procmonExport.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** Recorded Process Monitor exports are read independently of live tracing. */
export const PROCMON_TOOL_CONTRACTS = [
  {
    name: "inspect_procmon_export",
    ...toolContractMetadata("inspect_procmon_export"),
    kind: "artifact-provider",
    description:
      "Read events from an existing local Process Monitor XML or CSV export. format auto picks XML when the first non-whitespace character is <. Return 50 events by default with event_offset/event_limit paging; event_limit:null requests all remaining events within the 8 MiB report budget (the Evidence envelope adds its own metadata). Each event keeps its 1-based ordinal and the Time of Day, Process Name, PID, Operation, Path, Result and Detail text exactly as exported; other columns stay under additional as {column, value} entries in source order. A column missing from the export is listed in missing_columns and is null in every event, not an empty string. Reports source path, SHA-256, byte length, detected format and encoding, and header or field order. A truncated or malformed export keeps the events read before the problem with partial coverage and the stopping line. Reads only the selected file (at most 128 MiB): no Process Monitor process, driver, live tracing or PML decoding. Missing events do not prove the activity did not happen.",
    inputSchema: inspectProcmonExportInputSchema,
    outputSchema: evidenceResultOf(procmonExportSchema),
    examples: [
      {
        title: "Read the first events of a CSV export",
        input: { path: "/artifacts/procmon.csv" },
      },
      {
        title: "Page through an XML export",
        input: {
          path: "/artifacts/procmon.xml",
          format: "xml",
          event_offset: 100,
          event_limit: 100,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
