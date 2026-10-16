import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest, type TestMcp } from "../../support/mcp/mcpFixture.js";

const connect = async (mcp: TestMcp) => {
  const session = createTestBinarySession(() => {
    throw new Error("Process Monitor exports must not start a deep provider");
  });
  const client = await mcp.connect(createServer({ kind: "session", session }));
  return { client, session };
};
const parse = (content: unknown) =>
  toolContract("inspect_procmon_export").outputSchema.parse(content)
    .normalized_result;

mcpTest(
  "advertises inspect_procmon_export and pages an XML export",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const advertised = (await client.listTools()).tools.find(
        (tool) => tool.name === "inspect_procmon_export",
      );
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      const path = fileURLToPath(
        new URL("../../fixtures/procmon/events.xml", import.meta.url),
      );
      const response = await client.callTool({
        name: "inspect_procmon_export",
        arguments: { path, event_offset: 1, event_limit: 1 },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      const report = parse(response.structuredContent);
      expect(report.events).toEqual([
        expect.objectContaining({ ordinal: 2, operation: "CreateFile" }),
      ]);
      expect(report.output_window).toEqual({
        examined_events: 3,
        returned_events: 1,
        has_more: true,
      });
      expect(report.live_capture).toBe("not-performed");
    } finally {
      await session.close();
    }
  },
);

mcpTest("reads a BOM-marked UTF-16 CSV export", async ({ mcp }) => {
  const { client, session } = await connect(mcp);
  try {
    const root = await createTestTempDirectory("rea-procmon-mcp-");
    const path = join(root, "wide.csv");
    const text =
      '"Process Name","PID","Operation"\r\n"Привет.exe","7","Load Image"\r\n';
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
    );
    const response = await client.callTool({
      name: "inspect_procmon_export",
      arguments: { path },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const report = parse(response.structuredContent);
    expect(report.source).toMatchObject({
      format: "csv",
      encoding: "utf-16le",
      byte_order_mark: true,
    });
    expect(report.events[0]?.process_name).toBe("Привет.exe");
  } finally {
    await session.close();
  }
});

mcpTest(
  "rejects relative paths and XML document type declarations",
  async ({ mcp }) => {
    const { client, session } = await connect(mcp);
    try {
      const relative = await client.callTool({
        name: "inspect_procmon_export",
        arguments: { path: "procmon.csv" },
      });
      expect(relative.isError).toBe(true);
      expect(parseMcpToolError(relative).error).toMatchObject({
        code: "invalid_request",
        details: { operation: "inspect_procmon_export" },
      });
      const root = await createTestTempDirectory("rea-procmon-mcp-dtd-");
      const path = join(root, "entity.xml");
      await writeFile(
        path,
        '<?xml version="1.0"?><!DOCTYPE procmon [<!ENTITY x "y">]><procmon><eventlist/></procmon>',
      );
      const dtd = await client.callTool({
        name: "inspect_procmon_export",
        arguments: { path },
      });
      expect(dtd.isError).toBe(true);
      expect(parseMcpToolError(dtd).error.details).toMatchObject({
        operation: "inspect_procmon_export",
      });
    } finally {
      await session.close();
    }
  },
);
