import { SaxesParser } from "saxes";
import { PROCMON_EXPORT_LIMITS } from "../domain/procmon/procmonExport.js";
import {
  partialCoverage,
  ProcmonExportFormatFailure,
  ProcmonExportOutputFailure,
  yieldToEventLoop,
  type ParsedProcmonExport,
  type ProcmonCoverage,
  type ProcmonEventWindow,
} from "./ProcmonExportEvents.js";

/** A handler stops the parser; the reason becomes partial coverage. */
class XmlStop {
  constructor(readonly message: string) {}
}

/**
 * Track procmon > eventlist > event > field. Simple fields become event
 * values; fields with child elements are named but not projected.
 */
class ProcmonXmlEvents {
  readonly columns: string[] = [];
  readonly nested = new Set<string>();
  rootSeen = false;
  eventLists = 0;
  #known = new Set<string>();
  #columnSet = new Set<string>();
  #depth = 0;
  #inEventList = false;
  #event: Map<string, string> | undefined;
  #eventFields = new Set<string>();
  #field: { name: string; text: string; nested: boolean } | undefined;

  constructor(readonly window: ProcmonEventWindow) {}

  open(tag: { readonly name: string }): void {
    this.#depth += 1;
    if (this.#depth === 1) {
      if (tag.name !== "procmon")
        throw new ProcmonExportFormatFailure(
          "format",
          `XML root element is ${JSON.stringify(tag.name.slice(0, 100))}${tag.name.length > 100 ? " (truncated)" : ""}; a Process Monitor export uses procmon.`,
        );
      this.rootSeen = true;
    } else if (this.#depth === 2 && tag.name === "eventlist") {
      this.#inEventList = true;
      this.eventLists += 1;
    } else if (this.#depth === 3 && this.#inEventList && tag.name === "event") {
      this.#event = new Map();
      this.#eventFields = new Set();
    } else if (this.#depth === 4 && this.#event !== undefined)
      this.#field = { name: tag.name, text: "", nested: false };
    else if (this.#depth === 5 && this.#field !== undefined)
      this.#field.nested = true;
  }

  text(text: string): void {
    if (this.#depth === 4 && this.#field?.nested === false)
      this.#field.text += text;
  }

  close(): void {
    if (this.#depth === 4 && this.#field !== undefined) this.#closeField();
    else if (this.#depth === 3 && this.#event !== undefined) {
      this.window.add(this.#event);
      this.#event = undefined;
    } else if (this.#depth === 2) this.#inEventList = false;
    this.#depth -= 1;
  }

  #closeField(): void {
    const field = this.#field;
    const event = this.#event;
    this.#field = undefined;
    if (field === undefined || event === undefined) return;
    // Names repeat whether simple or nested; either way the value is ambiguous.
    if (this.#eventFields.has(field.name))
      throw new XmlStop(
        `Event ${this.window.examined + 1} repeats field ${field.name.slice(0, 100)}.`,
      );
    this.#eventFields.add(field.name);
    // Simple and nested names share one distinct-field cap.
    if (!this.#known.has(field.name)) {
      if (this.#known.size >= PROCMON_EXPORT_LIMITS.columns)
        throw new XmlStop(
          `Events name more than ${PROCMON_EXPORT_LIMITS.columns} distinct fields.`,
        );
      this.#known.add(field.name);
    }
    if (field.nested) {
      // Reported in omitted_nested_fields and repeated in a limitation.
      if (!this.nested.has(field.name)) this.window.charge(field.name, 2);
      this.nested.add(field.name);
      return;
    }
    event.set(field.name, field.text);
    if (this.#columnSet.has(field.name)) return;
    this.window.charge(field.name);
    this.#columnSet.add(field.name);
    this.columns.push(field.name);
  }
}

/** UTF-16 code units written to the parser between event-loop yields. */
const CHARACTERS_PER_SLICE = 1024 * 1024;

/** Stream one XML export; well-formedness failures after the root keep earlier events. */
export const readProcmonXml = async (
  xml: string,
  window: ProcmonEventWindow,
  signal?: AbortSignal,
): Promise<ParsedProcmonExport> => {
  const parser = new SaxesParser({
    defaultXMLVersion: "1.0",
    forceXMLVersion: true,
  });
  const events = new ProcmonXmlEvents(window);
  parser.on("doctype", () => {
    throw new ProcmonExportFormatFailure(
      "unsupported",
      "XML exports with a DTD are unsupported.",
    );
  });
  parser.on("opentag", (tag) => events.open(tag));
  parser.on("text", (text) => events.text(text));
  parser.on("cdata", (text) => events.text(text));
  parser.on("closetag", () => events.close());
  const parsed = (coverage: ProcmonCoverage): ParsedProcmonExport => ({
    columns: events.columns,
    nested: [...events.nested],
    coverage,
  });
  let stage: "write" | "close" = "write";
  try {
    for (let at = 0; at < xml.length; at += CHARACTERS_PER_SLICE) {
      parser.write(xml.slice(at, at + CHARACTERS_PER_SLICE));
      if (at + CHARACTERS_PER_SLICE < xml.length)
        await yieldToEventLoop(signal);
    }
    stage = "close";
    parser.close();
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    return parsed(stoppedCoverage(cause, events, stage, parser.line));
  }
  if (events.eventLists === 0)
    throw new ProcmonExportFormatFailure(
      "format",
      "XML export has no eventlist element under procmon.",
    );
  return parsed({ status: "complete" });
};

const stoppedCoverage = (
  cause: unknown,
  events: ProcmonXmlEvents,
  stage: "write" | "close",
  line: number,
): ProcmonCoverage => {
  if (
    cause instanceof ProcmonExportFormatFailure ||
    cause instanceof ProcmonExportOutputFailure
  )
    throw cause;
  if (!events.rootSeen)
    throw new ProcmonExportFormatFailure(
      "format",
      "XML export is not well-formed before its procmon root element.",
      { cause },
    );
  if (events.eventLists === 0)
    throw new ProcmonExportFormatFailure(
      "format",
      "XML export stops before any eventlist element under procmon.",
      { cause },
    );
  if (cause instanceof XmlStop)
    return partialCoverage("malformed", cause.message, line);
  // Parser diagnostics can quote source tokens of any length; keep a bounded prefix.
  const message = cause instanceof Error ? cause.message : String(cause);
  const detail =
    message.length > 300 ? `${message.slice(0, 300)}… (truncated)` : message;
  return stage === "close"
    ? partialCoverage("truncated", `XML export ends early: ${detail}`, line)
    : partialCoverage(
        "malformed",
        `XML export is not well-formed: ${detail}`,
        line,
      );
};
