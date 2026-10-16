import { describe, expect, it } from "vitest";
import { readProcmonExport } from "./ProcmonExportReader.js";

const selection = { format: "auto", event_offset: 0, event_limit: 1 } as const;
const header = '"Process Name","Operation"\n';

describe("readProcmonExport cancellation", () => {
  it("stops between parsing slices once the caller aborts", async () => {
    const bytes = Buffer.from(header + '"a.exe","Read"\n'.repeat(20_000));
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(
      readProcmonExport(bytes, selection, controller.signal),
    ).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports cancellation instead of partial coverage for XML", async () => {
    const event = "<event><Process_Name>a.exe</Process_Name></event>";
    const bytes = Buffer.from(
      `<procmon><eventlist>${event.repeat(60_000)}</eventlist></procmon>`,
    );
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(
      readProcmonExport(bytes, selection, controller.signal),
    ).rejects.toThrow();
  });
});

describe("readProcmonExport damaged and large exports", () => {
  it("does not return a final row whose last character was cut off", async () => {
    const bytes = Buffer.concat([
      Buffer.from(`${header}"a.exe","Read"\n"b.exe",caf`),
      Buffer.from([0xc3]),
    ]);
    const reading = await readProcmonExport(bytes, {
      ...selection,
      event_limit: null,
    });
    expect(reading.events.map((event) => event.process_name)).toEqual([
      "a.exe",
    ]);
    expect(reading.coverage).toMatchObject({
      status: "partial",
      reason: "truncated",
      line: 3,
    });
  });

  it("admits a page whose serialized events fit the output budget", async () => {
    const columns =
      '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"\n';
    const row = `"9:41:07.1234567 AM","sample.exe","4120","ReadFile","C:\\\\data\\\\file.bin","SUCCESS","${"d".repeat(90)}"\n`;
    const bytes = Buffer.from(columns + row.repeat(28_000));
    const reading = await readProcmonExport(bytes, {
      ...selection,
      event_limit: null,
    });
    const serialized = Buffer.byteLength(JSON.stringify(reading.events));
    expect(reading.events).toHaveLength(28_000);
    expect(serialized).toBeGreaterThan(7 * 1024 * 1024);
    expect(serialized).toBeLessThan(8 * 1024 * 1024);
  });
});

describe("readProcmonExport Codex review cases", () => {
  const all = { ...selection, event_limit: null };

  it("detects XML after more than 1 KiB of leading whitespace", async () => {
    const xml = `${" ".repeat(4096)}<procmon><eventlist><event><Operation>Read</Operation></event></eventlist></procmon>`;
    const reading = await readProcmonExport(Buffer.from(xml), all);
    expect(reading.source.format).toBe("xml");
    expect(reading.events).toHaveLength(1);
  });

  it("rejects a stopped XML document that never reached an eventlist", async () => {
    await expect(
      readProcmonExport(Buffer.from("<procmon><catalog"), all),
    ).rejects.toThrow("before any eventlist");
  });

  it("rejects an empty export as a format failure", async () => {
    await expect(readProcmonExport(Buffer.alloc(0), all)).rejects.toThrow(
      "CSV export is empty",
    );
    await expect(
      readProcmonExport(Buffer.alloc(0), { ...all, format: "xml" }),
    ).rejects.toThrow("procmon");
  });

  it("rejects invalid bytes before a valid final character", async () => {
    const bytes = Buffer.concat([
      Buffer.from(`${header}"a.exe","Read"\n`),
      Buffer.from([0xff, 0x0a]),
    ]);
    await expect(readProcmonExport(bytes, all)).rejects.toThrow(
      "not valid utf-8",
    );
  });

  it("keeps a column named __proto__ as data", async () => {
    const bytes = Buffer.from('"Process Name","__proto__"\n"a.exe","kept"\n');
    const reading = await readProcmonExport(bytes, all);
    expect(reading.events[0]?.additional).toEqual([
      { column: "__proto__", value: "kept" },
    ]);
  });

  it("explains that oversized column names cannot be paged away", async () => {
    const bytes = Buffer.from(
      `"Process Name","${"x".repeat(9 * 1024 * 1024)}"\n`,
    );
    await expect(readProcmonExport(bytes, all)).rejects.toThrow(
      "no event page fits",
    );
  });
});

describe("readProcmonExport review of e014743", () => {
  const all = { ...selection, event_limit: null };

  it("does not claim columns are missing from a partial XML export", async () => {
    const xml =
      "<procmon><eventlist><event><Operation>Read</Operation></event><event><Path>C:";
    const reading = await readProcmonExport(Buffer.from(xml), all);
    expect(reading.coverage.status).toBe("partial");
    expect(reading.missing_columns).toEqual([]);
  });

  it("rejects an impossible UTF-8 prefix at the end", async () => {
    const bytes = Buffer.concat([
      Buffer.from(`${header}"a.exe","Read"\n`),
      Buffer.from([0xe0, 0x80]),
    ]);
    await expect(readProcmonExport(bytes, all)).rejects.toThrow(
      "not valid utf-8",
    );
  });

  it("rejects a header that ends inside a character", async () => {
    const bytes = Buffer.concat([
      Buffer.from('"Process Name",Operation'),
      Buffer.from([0xc3]),
    ]);
    await expect(readProcmonExport(bytes, all)).rejects.toThrow(
      "header row ends inside a character",
    );
  });

  it("blames events, not metadata, when a smaller page would fit", async () => {
    // Events nearly fill the budget; a later event then names a new field.
    const xml = `<procmon><eventlist><event><Path>${"p".repeat(8 * 1024 * 1024 - 150)}</Path></event><event><Extra_Field>x</Extra_Field></event></eventlist></procmon>`;
    await expect(readProcmonExport(Buffer.from(xml), all)).rejects.toThrow(
      "choose a smaller event_limit",
    );
  });
});

describe("readProcmonExport review of 6e44894", () => {
  it("uses the final coverage for missing columns after a cut character", async () => {
    const bytes = Buffer.concat([
      Buffer.from(
        "<procmon><eventlist><event><Operation>Read</Operation></event></eventlist></procmon>\n",
      ),
      Buffer.from([0xc3]),
    ]);
    const reading = await readProcmonExport(bytes, {
      ...selection,
      event_limit: null,
    });
    expect(reading.coverage).toMatchObject({
      status: "partial",
      reason: "truncated",
    });
    expect(reading.missing_columns).toEqual([]);
  });
});

describe("readProcmonExport review of e3aaded", () => {
  const all = { ...selection, event_limit: null };
  const xml = (event: string) =>
    Buffer.from(
      `<procmon><eventlist><event><Operation>Read</Operation>${event}</event></eventlist></procmon>`,
    );
  const nestedPath = "<Path><frame>0x1</frame></Path>";

  it.each([
    ["simple then nested", `<Path>C:\\a</Path>${nestedPath}`],
    ["nested then simple", `${nestedPath}<Path>C:\\a</Path>`],
    ["nested twice", `${nestedPath}${nestedPath}`],
  ])("stops at a field repeated %s", async (_order, event) => {
    const reading = await readProcmonExport(xml(event), all);
    expect(reading.events).toEqual([]);
    expect(reading.coverage).toMatchObject({
      status: "partial",
      reason: "malformed",
    });
  });

  it("counts a nested projected field as present", async () => {
    const reading = await readProcmonExport(
      xml("<Detail><frame>0x1</frame></Detail>"),
      all,
    );
    expect(reading.omitted_nested_fields).toEqual(["Detail"]);
    expect(reading.missing_columns).not.toContain("Detail");
    expect(reading.events[0]?.detail).toBeNull();
  });

  it("bounds a long non-procmon root name in the error", async () => {
    const name = `r${"x".repeat(1_000_000)}`;
    const error = await readProcmonExport(Buffer.from(`<${name}/>`), all).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(300);
  });

  it("rejects a UTF-16BE high surrogate followed by a non-low-surrogate byte", async () => {
    const body = Buffer.from(header + '"a.exe","Read"\n', "utf16le").swap16();
    const bytes = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      body,
      Buffer.from([0xd8, 0x00, 0x00]),
    ]);
    await expect(readProcmonExport(bytes, all)).rejects.toThrow(
      "not valid utf-16be",
    );
  });

  it("does not suggest a smaller page when the first event alone is too big", async () => {
    const big = Buffer.from(
      `${header}"a.exe","${"v".repeat(9 * 1024 * 1024)}"\n"b.exe","Read"\n`,
    );
    await expect(
      readProcmonExport(big, { ...all, event_limit: 1 }),
    ).rejects.toThrow("Event 1 alone exceeds");
  });
});

describe("readProcmonExport review of 46cba65", () => {
  it("bounds a long declared XML encoding in the error", async () => {
    const declared = "x".repeat(1_000_000);
    const error = await readProcmonExport(
      Buffer.from(
        `<?xml version="1.0" encoding="${declared}"?><procmon><eventlist/></procmon>`,
      ),
      { ...selection, event_limit: null },
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(200);
  });
});

describe("readProcmonExport review of 8d3d950", () => {
  it("bounds parser diagnostics kept in partial coverage", async () => {
    const name = `a${"x".repeat(1_000_000)}`;
    const reading = await readProcmonExport(
      Buffer.from(
        `<procmon><eventlist><event><Operation>Read</Operation></event><event ${name}="1" ${name}="2"/></eventlist></procmon>`,
      ),
      { ...selection, event_limit: null },
    );
    expect(reading.coverage.status).toBe("partial");
    expect(
      reading.coverage.status === "partial"
        ? reading.coverage.message.length
        : 0,
    ).toBeLessThan(400);
  });
});

describe("readProcmonExport review of f171915", () => {
  const all = { ...selection, event_limit: null };

  it.each([
    ["UTF-32LE", [0xff, 0xfe, 0x00, 0x00]],
    ["UTF-32BE", [0x00, 0x00, 0xfe, 0xff]],
  ])("rejects a %s BOM as an unsupported encoding", async (_name, bom) => {
    await expect(
      readProcmonExport(Buffer.from([...bom, 0x3c, 0, 0, 0]), all),
    ).rejects.toThrow("BOM-marked UTF-32");
  });

  it("stops at a blank line between rows but ignores trailing blank lines", async () => {
    const between = await readProcmonExport(
      Buffer.from(`${header}"a.exe","Read"\n\n"b.exe","Write"\n`),
      all,
    );
    expect(between.events).toHaveLength(1);
    expect(between.coverage).toMatchObject({
      status: "partial",
      reason: "malformed",
      line: 3,
    });
    const trailing = await readProcmonExport(
      Buffer.from(`${header}"a.exe","Read"\n\n\r\n`),
      all,
    );
    expect(trailing.events).toHaveLength(1);
    expect(trailing.coverage).toEqual({ status: "complete" });
  });

  it("counts nested field names against the distinct-field cap", async () => {
    const nested = Array.from(
      { length: 1025 },
      (_, at) => `<n${at}><x/></n${at}>`,
    ).join("");
    const reading = await readProcmonExport(
      Buffer.from(
        `<procmon><eventlist><event><Operation>Read</Operation>${nested}</event></eventlist></procmon>`,
      ),
      all,
    );
    expect(reading.coverage).toMatchObject({
      status: "partial",
      reason: "malformed",
    });
  });
});

describe("readProcmonExport review of 75016b0", () => {
  it("reads many blank rows in linear time", async () => {
    // One column makes each blank line a valid empty row, so none stops reading.
    const blankRows = 300_000;
    const started = performance.now();
    const reading = await readProcmonExport(
      Buffer.from(`Operation\n${"\n".repeat(blankRows)}Read\n`),
      selection,
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(reading.output_window.examined_events).toBe(blankRows + 1);
    expect(reading.coverage).toEqual({ status: "complete" });
  });
});

describe("readProcmonExport review of 262a1da", () => {
  const all = { ...selection, event_limit: null };

  it("detects CSV when the first character only starts like a UTF-8 BOM", async () => {
    // U+FF30 encodes as EF BC B0, which is not a byte order mark.
    const reading = await readProcmonExport(
      Buffer.from("\uFF30<x,Operation\nfoo,Read\n"),
      all,
    );
    expect(reading.source).toMatchObject({
      format: "csv",
      byte_order_mark: false,
    });
    expect(reading.events).toHaveLength(1);
  });

  it("counts a bare CR inside a quoted field as a line break", async () => {
    const reading = await readProcmonExport(
      Buffer.from(`${header.trimEnd()}\r"a.exe","Re\rad"\r"b.exe"\r`),
      all,
    );
    expect(reading.coverage).toMatchObject({ status: "partial", line: 4 });
  });
});
