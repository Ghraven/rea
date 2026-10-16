import { z } from "incur";
import { resolve } from "node:path";
import { createProcmonExportService } from "../composition/procmon.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { inspectProcmonExportInputSchema } from "../domain/procmon/procmonExport.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve the caller path and read a Process Monitor export through the shared workflow. */
export const registerProcmonCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = createProcmonExportService();
  cli.command(CLI_COMMANDS.inspectProcmonExport, {
    description:
      "Read events from a Process Monitor XML or CSV export without live capture",
    args: z.object({
      path: z.string().describe("Local Process Monitor XML or CSV export"),
    }),
    options: z
      .object({
        // --format is the CLI-wide output format, so the export format has its own name.
        export_format: inspectProcmonExportInputSchema.shape.format,
        event_offset: inspectProcmonExportInputSchema.shape.event_offset,
        event_limit: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe("Returned events per page; default 50"),
        all_events: z
          .boolean()
          .default(false)
          .describe("Return all remaining events instead of a bounded page"),
      })
      .superRefine((options, context) => {
        if (options.all_events && options.event_limit !== undefined)
          context.addIssue({
            code: "custom",
            path: ["all_events"],
            message: "all_events and event_limit are mutually exclusive",
          });
      }),
    run: ({ args, options: { all_events, export_format, ...options } }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectProcmonExport, async () => {
          const result = await service.inspect(
            {
              ...options,
              format: export_format,
              ...(all_events ? { event_limit: null } : {}),
              path: resolve(args.path),
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
