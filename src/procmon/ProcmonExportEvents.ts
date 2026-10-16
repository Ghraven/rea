import {
  PROCMON_EXPORT_LIMITS,
  type ProcmonCoreColumn,
  type ProcmonEvent,
  type ProcmonExport,
} from "../domain/procmon/procmonExport.js";

/** The export is not a readable Process Monitor XML or CSV document. */
export class ProcmonExportFormatFailure extends Error {
  constructor(
    readonly kind: "format" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProcmonExportFormatFailure";
  }
}

/** The selected events and export metadata do not fit the inline output budget. */
export class ProcmonExportOutputFailure extends Error {
  constructor(
    readonly retainedEvents: number,
    /**
     * What a caller can change: `metadata` (column or field names) and
     * `first-event` (one event alone) cannot be fixed by a smaller page.
     */
    readonly budget: "events" | "metadata" | "first-event" = "events",
    readonly ordinal?: number,
  ) {
    super(
      budget === "metadata"
        ? `The export's column and field names alone exceed the ${PROCMON_EXPORT_LIMITS.output_bytes}-byte inline output budget; no event page fits. Re-export with fewer or shorter columns.`
        : budget === "first-event"
          ? `Event ${ordinal ?? "?"} alone exceeds the ${PROCMON_EXPORT_LIMITS.output_bytes}-byte inline output budget; a smaller event_limit cannot help. Skip it with a larger event_offset or re-export with narrower fields.`
          : `The report exceeds the ${PROCMON_EXPORT_LIMITS.output_bytes}-byte inline output budget after ${retainedEvents} events; choose a smaller event_limit.`,
    );
    this.name = "ProcmonExportOutputFailure";
  }
}

export type ProcmonCoverage = ProcmonExport["coverage"];
export type ProcmonFormat = ProcmonExport["source"]["format"];

/** Format-independent facts one parser reports about the whole export. */
export interface ParsedProcmonExport {
  readonly columns: string[];
  readonly nested: string[];
  readonly coverage: ProcmonCoverage;
}

export const partialCoverage = (
  reason: "truncated" | "malformed",
  message: string,
  line: number | null,
): ProcmonCoverage => ({ status: "partial", reason, message, line });

const CORE_FIELDS: Readonly<
  Record<
    ProcmonCoreColumn,
    Exclude<keyof ProcmonEvent, "ordinal" | "additional">
  >
> = {
  "Time of Day": "time_of_day",
  "Process Name": "process_name",
  PID: "pid",
  Operation: "operation",
  Path: "path",
  Result: "result",
  Detail: "detail",
};

/**
 * The projected column a source name denotes. CSV headers use the names as
 * written; only XML field names spell spaces as underscores.
 */
export const procmonCoreColumn = (
  column: string,
  format: ProcmonFormat,
): ProcmonCoreColumn | undefined => {
  const name = format === "xml" ? column.replaceAll("_", " ") : column;
  return Object.hasOwn(CORE_FIELDS, name)
    ? (name as ProcmonCoreColumn)
    : undefined;
};

/**
 * Exact UTF-8 length of `value` serialized as a JSON string, computed without
 * building the serialized string.
 */
export const jsonStringBytes = (value: string): number => {
  let bytes = 2;
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20)
      bytes += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 2 : 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(at + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        at += 1;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
};

/** `{"column":,"value":}` and its separating comma, around the two strings. */
const ADDITIONAL_ENTRY_BYTES = '{"column":,"value":},'.length;

/** Serialized size of an event with no values, excluding its ordinal digits. */
const EMPTY_EVENT_BYTES =
  Buffer.byteLength(
    JSON.stringify({
      ordinal: 0,
      time_of_day: null,
      process_name: null,
      pid: null,
      operation: null,
      path: null,
      result: null,
      detail: null,
      additional: [],
    }),
  ) - 1;

/**
 * Count every event in source order; build and admit only the selected
 * window. Column names, nested field names and retained events are charged to
 * one output budget before allocation so no source text reaches the report
 * unbounded.
 */
export class ProcmonEventWindow {
  examined = 0;
  readonly events: ProcmonEvent[] = [];
  #bytes = 0;
  #metadataBytes = 0;
  constructor(
    readonly format: ProcmonFormat,
    readonly offset: number,
    readonly limit: number | null,
  ) {}

  /** Charge source text that the report repeats, such as column names. */
  charge(text: string, copies = 1): void {
    if (text.length > PROCMON_EXPORT_LIMITS.output_bytes)
      throw new ProcmonExportOutputFailure(this.events.length, "metadata");
    this.#admit(copies * (jsonStringBytes(text) + 1), "metadata");
  }

  add(fields: ReadonlyMap<string, string>): void {
    this.examined += 1;
    if (
      this.examined <= this.offset ||
      (this.limit !== null && this.events.length >= this.limit)
    )
      return;
    this.#admit(this.#serializedBytes(fields));
    const event: ProcmonEvent = {
      ordinal: this.examined,
      time_of_day: null,
      process_name: null,
      pid: null,
      operation: null,
      path: null,
      result: null,
      detail: null,
      additional: [],
    };
    for (const [column, value] of fields) {
      const core = procmonCoreColumn(column, this.format);
      // Entries, not object keys, so any name (even __proto__) stays data.
      if (core === undefined)
        event.additional.push({
          column: detachString(column),
          value: detachString(value),
        });
      else event[CORE_FIELDS[core]] = detachString(value);
    }
    this.events.push(event);
  }

  /**
   * The event's serialized size plus its array separator: the empty event,
   * each core value replacing its `null`, and each additional entry.
   */
  #serializedBytes(fields: ReadonlyMap<string, string>): number {
    let bytes = EMPTY_EVENT_BYTES + String(this.examined).length + 1;
    for (const [column, value] of fields) {
      if (value.length > PROCMON_EXPORT_LIMITS.output_bytes)
        throw this.#eventOverflow();
      bytes +=
        procmonCoreColumn(column, this.format) === undefined
          ? ADDITIONAL_ENTRY_BYTES +
            jsonStringBytes(column) +
            jsonStringBytes(value)
          : jsonStringBytes(value) - "null".length;
    }
    return bytes;
  }

  #admit(bytes: number, kind: "events" | "metadata" = "events"): void {
    this.#bytes += bytes;
    if (kind === "metadata") this.#metadataBytes += bytes;
    // Metadata is the cause only when it alone exceeds the budget; otherwise
    // a smaller page would fit.
    if (this.#bytes <= PROCMON_EXPORT_LIMITS.output_bytes) return;
    if (this.#metadataBytes > PROCMON_EXPORT_LIMITS.output_bytes)
      throw new ProcmonExportOutputFailure(this.events.length, "metadata");
    throw kind === "events"
      ? this.#eventOverflow()
      : new ProcmonExportOutputFailure(this.events.length);
  }

  /** With no event retained yet, the event being admitted is the whole page. */
  #eventOverflow(): ProcmonExportOutputFailure {
    return this.events.length === 0
      ? new ProcmonExportOutputFailure(0, "first-event", this.examined)
      : new ProcmonExportOutputFailure(this.events.length);
  }
}

/**
 * Copy text that the report keeps. Parsers slice the decoded export, and V8
 * sliced strings keep their parent alive, so a retained cell would otherwise
 * hold the whole decoded file (up to 128 MiB) for as long as the Evidence.
 * Retained text is bounded by the output budget.
 */
export const detachString = (value: string): string =>
  JSON.parse(JSON.stringify(value)) as string;

/** Let cancellation and other work run between bounded parsing slices. */
export const yieldToEventLoop = async (
  signal: AbortSignal | undefined,
): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal?.throwIfAborted();
};
