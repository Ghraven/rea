import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/** Bounds that follow memory for one decoded export and the inline transport budget. */
export const PROCMON_EXPORT_LIMITS = {
  input_bytes: 128 * 1024 * 1024,
  output_bytes: 8 * 1024 * 1024,
  columns: 1024,
} as const;

/**
 * Columns projected as named event fields. CSV exports name them as written
 * here; XML exports replace each space with an underscore.
 */
export const PROCMON_CORE_COLUMNS = [
  "Time of Day",
  "Process Name",
  "PID",
  "Operation",
  "Path",
  "Result",
  "Detail",
] as const;
export type ProcmonCoreColumn = (typeof PROCMON_CORE_COLUMNS)[number];

export const inspectProcmonExportInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute local path to an existing Process Monitor XML or CSV export",
  ),
  format: z
    .enum(["auto", "xml", "csv"])
    .default("auto")
    .describe(
      "Export format; auto selects XML when the first non-whitespace character is <, otherwise CSV",
    ),
  event_offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe("Skip this many events in source order; default 0"),
  event_limit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .default(50)
    .describe(
      "Return at most this many events; default 50. Null returns all remaining events within the output budget.",
    ),
});
export type InspectProcmonExportInput = z.infer<
  typeof inspectProcmonExportInputSchema
>;

/** Absent columns are null; an empty cell stays an observed empty string. */
const cell = z.string().nullable();
export const procmonEventSchema = z.strictObject({
  ordinal: z
    .number()
    .int()
    .positive()
    .describe("1-based position of the event in the export"),
  time_of_day: cell,
  process_name: cell,
  pid: cell.describe("PID text exactly as exported"),
  operation: cell,
  path: cell,
  result: cell,
  detail: cell,
  additional: z
    .array(z.strictObject({ column: z.string(), value: z.string() }))
    .describe(
      "Other exported columns or simple XML fields, in source order, by source name",
    ),
});
export type ProcmonEvent = z.infer<typeof procmonEventSchema>;

const coverageSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("complete") }),
  z.strictObject({
    status: z.literal("partial"),
    reason: z.enum(["truncated", "malformed"]),
    message: z.string().min(1),
    line: z
      .number()
      .int()
      .positive()
      .nullable()
      .describe("1-based source line where reading stopped, when known"),
  }),
]);

export const procmonExportSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string(),
      sha256: digestSchema,
      bytes: z.number().int().nonnegative(),
    }),
    selection: inspectProcmonExportInputSchema,
    source: z.strictObject({
      format: z.enum(["xml", "csv"]),
      encoding: z.enum(["utf-8", "utf-16le", "utf-16be"]),
      byte_order_mark: z.boolean(),
      columns: z
        .array(z.string())
        .describe(
          "CSV header order, or XML event field names in first-seen order",
        ),
    }),
    missing_columns: z
      .array(z.enum(PROCMON_CORE_COLUMNS))
      .describe("Projected columns that never appear in the export"),
    omitted_nested_fields: z
      .array(z.string())
      .describe(
        "XML event fields with child elements, such as stacks, that are not projected",
      ),
    events: z.array(procmonEventSchema),
    output_window: z.strictObject({
      examined_events: z
        .number()
        .int()
        .nonnegative()
        .describe("Events read before the end of input or the stopping point"),
      returned_events: z.number().int().nonnegative(),
      has_more: z.boolean(),
    }),
    coverage: coverageSchema,
    limitations: z.array(z.string()),
    live_capture: z.literal("not-performed"),
  })
  .superRefine((report, context) => {
    const remaining = Math.max(
      report.output_window.examined_events - report.selection.event_offset,
      0,
    );
    const expected =
      report.selection.event_limit === null
        ? remaining
        : Math.min(remaining, report.selection.event_limit);
    if (
      report.events.length !== expected ||
      report.output_window.returned_events !== expected ||
      report.output_window.has_more !== remaining > expected
    )
      context.addIssue({
        code: "custom",
        path: ["output_window"],
        message:
          "Returned event window must match examined events and the caller-selected offset/limit",
      });
  });
export type ProcmonExport = z.infer<typeof procmonExportSchema>;
