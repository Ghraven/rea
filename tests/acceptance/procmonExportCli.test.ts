import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/procmon/${name}`, import.meta.url));
const parse = (json: unknown) =>
  toolContract("inspect_procmon_export").outputSchema.parse(json)
    .normalized_result;
const header =
  '"Time of Day","Process Name","PID","Operation","Path","Result","Detail"';
const row = (n: number) =>
  `"9:41:0${n}.0000000 AM","sample.exe","4120","ReadFile","C:\\data\\${n}.bin","SUCCESS","Offset: ${n}"`;

cliTest(
  "reads a CSV export with quoting, CRLF rows and a BOM",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["inspect-procmon-export", fixture("events.csv"), "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parse(result.json);
    expect(report.source).toEqual({
      format: "csv",
      encoding: "utf-8",
      byte_order_mark: true,
      columns: [
        "Time of Day",
        "Process Name",
        "PID",
        "Operation",
        "Path",
        "Result",
        "Detail",
      ],
    });
    expect(report.coverage).toEqual({ status: "complete" });
    expect(report.missing_columns).toEqual([]);
    expect(report.events.map((event) => event.operation)).toEqual([
      "RegOpenKey",
      "CreateFile",
      "WriteFile",
    ]);
    expect(report.events[1]?.detail).toBe(
      "Desired Access: Generic Read, Disposition: Open, Options: Synchronous IO Non-Alert",
    );
    expect(report.events[2]).toEqual({
      ordinal: 3,
      time_of_day: "9:41:07.1311111 AM",
      process_name: "sample.exe",
      pid: "4120",
      operation: "WriteFile",
      path: 'C:\\Temp\\note "draft".txt',
      result: "SUCCESS",
      detail: "",
      additional: [],
    });
    const bytes = await readFile(fixture("events.csv"));
    expect(report.artifact.bytes).toBe(bytes.length);
  },
);

cliTest(
  "reads an XML export and reports fields that are absent or nested",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["inspect-procmon-export", fixture("events.xml"), "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parse(result.json);
    expect(report.source.format).toBe("xml");
    expect(report.source.columns).toEqual([
      "ProcessIndex",
      "Time_of_Day",
      "Process_Name",
      "PID",
      "Operation",
      "Path",
      "Result",
      "Detail",
    ]);
    expect(report.omitted_nested_fields).toEqual(["stack"]);
    expect(report.events[0]).toMatchObject({
      ordinal: 1,
      process_name: "sample.exe",
      operation: "RegOpenKey",
      additional: [{ column: "ProcessIndex", value: "1" }],
    });
    // The third event has no Detail element: unknown, not empty.
    expect(report.events[2]).toMatchObject({
      path: 'C:\\Temp\\note & "draft".txt',
      detail: null,
    });
    expect(report.coverage).toEqual({ status: "complete" });
    expect(report.limitations.join("\n")).toContain("stack");
  },
);

cliTest("pages events in source order", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-procmon-page-");
  const path = join(root, "many.csv");
  await writeFile(path, [header, ...[1, 2, 3, 4, 5].map(row), ""].join("\r\n"));
  const page = await cli.run({
    arguments: [
      "inspect-procmon-export",
      path,
      "--event_offset",
      "1",
      "--event_limit",
      "2",
      "--json",
    ],
  });
  expect(page.exitCode, page.stderr).toBe(0);
  const report = parse(page.json);
  expect(report.events.map((event) => event.ordinal)).toEqual([2, 3]);
  expect(report.output_window).toEqual({
    examined_events: 5,
    returned_events: 2,
    has_more: true,
  });
  const rest = await cli.run({
    arguments: [
      "inspect-procmon-export",
      path,
      "--event_offset",
      "3",
      "--all_events",
      "--json",
    ],
  });
  expect(rest.exitCode, rest.stderr).toBe(0);
  const remaining = parse(rest.json);
  expect(remaining.events.map((event) => event.ordinal)).toEqual([4, 5]);
  expect(remaining.output_window.has_more).toBe(false);
});

cliTest(
  "reports missing columns as null and keeps other columns",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-columns-");
    const path = join(root, "narrow.csv");
    await writeFile(
      path,
      '"Process Name","Operation","TID"\n"sample.exe","Process Exit","88"\n',
    );
    const result = await cli.run({
      arguments: ["inspect-procmon-export", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parse(result.json);
    expect(report.missing_columns).toEqual([
      "Time of Day",
      "PID",
      "Path",
      "Result",
      "Detail",
    ]);
    expect(report.events).toEqual([
      {
        ordinal: 1,
        time_of_day: null,
        process_name: "sample.exe",
        pid: null,
        operation: "Process Exit",
        path: null,
        result: null,
        detail: null,
        additional: [{ column: "TID", value: "88" }],
      },
    ]);
  },
);

cliTest(
  "keeps events read before a truncation or malformed row",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-partial-");
    const cut = join(root, "cut.csv");
    await writeFile(cut, `${header}\r\n${row(1)}\r\n${row(2).slice(0, 30)}`);
    const truncated = await cli.run({
      arguments: ["inspect-procmon-export", cut, "--json"],
    });
    expect(truncated.exitCode, truncated.stderr).toBe(0);
    const cutReport = parse(truncated.json);
    expect(cutReport.events.map((event) => event.ordinal)).toEqual([1]);
    expect(cutReport.coverage).toMatchObject({
      status: "partial",
      reason: "truncated",
      line: 3,
    });

    const bad = join(root, "bad.csv");
    await writeFile(bad, `${header}\n${row(1)}\n"only","two"\n${row(3)}\n`);
    const malformed = await cli.run({
      arguments: ["inspect-procmon-export", bad, "--json"],
    });
    expect(malformed.exitCode, malformed.stderr).toBe(0);
    const badReport = parse(malformed.json);
    expect(badReport.events).toHaveLength(1);
    expect(badReport.output_window.examined_events).toBe(1);
    expect(badReport.coverage).toMatchObject({
      status: "partial",
      reason: "malformed",
      line: 3,
    });

    const xml = await readFile(fixture("events.xml"), "utf8");
    const cutXml = join(root, "cut.xml");
    await writeFile(cutXml, xml.slice(0, xml.lastIndexOf("<event>") + 40));
    const xmlResult = await cli.run({
      arguments: ["inspect-procmon-export", cutXml, "--json"],
    });
    expect(xmlResult.exitCode, xmlResult.stderr).toBe(0);
    const xmlReport = parse(xmlResult.json);
    expect(xmlReport.events.map((event) => event.ordinal)).toEqual([1, 2]);
    expect(xmlReport.coverage).toMatchObject({
      status: "partial",
      reason: "truncated",
    });
    expect(xmlReport.limitations.join("\n")).toContain(
      "their absence is not established",
    );
  },
);

cliTest(
  "rejects files that are not Process Monitor exports",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-invalid-");
    const csv = join(root, "other.csv");
    await writeFile(csv, "name,size\nreadme.txt,12\n");
    const notCsv = await cli.run({
      arguments: ["inspect-procmon-export", csv, "--json"],
    });
    expect(notCsv.exitCode).toBe(1);
    expect(notCsv.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_procmon_export" },
    });
    const xml = join(root, "other.xml");
    await writeFile(xml, '<?xml version="1.0"?><catalog><item/></catalog>');
    const notXml = await cli.run({
      arguments: ["inspect-procmon-export", xml, "--json"],
    });
    expect(notXml.exitCode).toBe(1);
    expect(notXml.json).toMatchObject({ code: "invalid_request" });
  },
);

cliTest(
  "selects the export format with --export_format, leaving --format for output",
  async ({ cli }) => {
    const xml = await cli.run({
      arguments: [
        "inspect-procmon-export",
        fixture("events.xml"),
        "--export_format",
        "xml",
        "--format",
        "json",
      ],
    });
    expect(xml.exitCode, xml.stderr).toBe(0);
    expect(parse(xml.json).source.format).toBe("xml");
    const forcedCsv = await cli.run({
      arguments: [
        "inspect-procmon-export",
        fixture("events.xml"),
        "--export_format",
        "csv",
        "--json",
      ],
    });
    expect(forcedCsv.exitCode).toBe(1);
    expect(forcedCsv.json).toMatchObject({ code: "invalid_request" });
  },
);

cliTest(
  "maps underscore names only in XML, not in CSV headers",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-underscore-");
    const path = join(root, "underscore.csv");
    await writeFile(path, '"Process_Name","Operation"\n"a.exe","Load Image"\n');
    const result = await cli.run({
      arguments: ["inspect-procmon-export", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parse(result.json);
    expect(report.missing_columns).toContain("Process Name");
    expect(report.events[0]).toMatchObject({
      process_name: null,
      operation: "Load Image",
      additional: [{ column: "Process_Name", value: "a.exe" }],
    });
  },
);

cliTest(
  "keeps earlier events when the export ends inside a character",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-cut-char-");
    const path = join(root, "cut.csv");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(`${header}\r\n${row(1)}\r\n"9:41:02 AM","caf`),
        Buffer.from([0xc3]),
      ]),
    );
    const result = await cli.run({
      arguments: ["inspect-procmon-export", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parse(result.json);
    expect(report.events.map((event) => event.ordinal)).toEqual([1]);
    expect(report.coverage).toMatchObject({
      status: "partial",
      reason: "truncated",
    });
  },
);

cliTest("stops a comma-filled row at the header width", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-procmon-commas-");
  const path = join(root, "commas.csv");
  await writeFile(
    path,
    `${header}\n${row(1)}\n${",".repeat(5_000_000)}\n${row(3)}\n`,
  );
  const result = await cli.run({
    arguments: ["inspect-procmon-export", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const report = parse(result.json);
  expect(report.output_window.examined_events).toBe(1);
  expect(report.coverage).toMatchObject({
    status: "partial",
    reason: "malformed",
    line: 3,
    message: "Row has more than 7 fields.",
  });
});

cliTest(
  "charges column names and escaped text to the output budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-budget-");
    const wideHeader = join(root, "header.csv");
    await writeFile(
      wideHeader,
      `"Process Name","${"x".repeat(9 * 1024 * 1024)}"\n`,
    );
    const header = await cli.run({
      arguments: ["inspect-procmon-export", wideHeader, "--json"],
    });
    expect(header.exitCode).toBe(1);
    expect(header.json).toMatchObject({
      code: "resource_constraint",
      details: {
        operation: "inspect_procmon_export",
        reported_limits: { maximum_output_bytes: 8 * 1024 * 1024 },
      },
    });
    // Two MiB of control characters serialize to twelve MiB of JSON escapes.
    const escaped = join(root, "escaped.csv");
    await writeFile(
      escaped,
      `"Process Name","Detail"\n"a.exe","${"\u0001".repeat(2 * 1024 * 1024)}"\n`,
    );
    const event = await cli.run({
      arguments: ["inspect-procmon-export", escaped, "--json"],
    });
    expect(event.exitCode).toBe(1);
    expect(event.json).toMatchObject({ code: "resource_constraint" });
  },
);

cliTest(
  "keeps a __proto__ column and rejects an empty export as invalid input",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-proto-");
    const proto = join(root, "proto.csv");
    await writeFile(proto, '"Process Name","__proto__"\n"a.exe","kept"\n');
    const kept = await cli.run({
      arguments: ["inspect-procmon-export", proto, "--json"],
    });
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(parse(kept.json).events[0]?.additional).toEqual([
      { column: "__proto__", value: "kept" },
    ]);
    const empty = join(root, "empty.csv");
    await writeFile(empty, "");
    const rejected = await cli.run({
      arguments: ["inspect-procmon-export", empty, "--json"],
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_procmon_export" },
    });
  },
);

cliTest(
  "does not call a nested field unseen in a partial XML export",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-procmon-nested-seen-");
    const path = join(root, "cut.xml");
    await writeFile(
      path,
      "<procmon><eventlist><event><Operation>Read</Operation><Detail><frame>1</frame></Detail></event><event><Path>C:",
    );
    const result = await cli.run({
      arguments: ["inspect-procmon-export", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = parse(result.json);
    expect(report.coverage.status).toBe("partial");
    const unseen = report.limitations.find((note) =>
      note.includes("did not appear before reading stopped"),
    );
    expect(unseen).toBeDefined();
    expect(unseen).not.toContain("Detail");
  },
);
