import { constants } from "node:buffer";

import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { expect, it } from "vitest";

import { logCliCommand } from "../../../src/cliLogging.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import { err, ok } from "../../../src/domain/result.js";
import { GhidraRequestQueue } from "../../../src/ghidra/GhidraRequestQueue.js";
import {
  bindGhidraSessionFailure,
  GhidraSessionError,
} from "../../../src/ghidra/GhidraSessionError.js";
import { silentLogger } from "../../../src/logger.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

it("preserves queue failure diagnostics through the provider, CLI adapter and SDK MCP transport", async () => {
  const token = "fixture-authentication-token";
  const cause = Object.assign(
    new TypeError(
      `Decode failed ${token}: /tmp/password-fixture http://localhost/secret?token=public-value`,
    ),
    { code: "EDECODE" },
  );
  const failure = bindGhidraSessionFailure(
    () => ({
      target_path: "/tmp/public-fixture",
      target_sha256: "a".repeat(64),
    }),
    (value) => value.replaceAll(token, "[REDACTED]"),
  );
  const queue = new GhidraRequestQueue(
    async () => {
      throw cause;
    },
    failure,
    () => Promise.resolve(),
  );
  const harness = await connectGhidraMcp(
    "ghidra-failure-diagnostics",
    (operation, input, options) => queue.run(operation, input, options ?? {}),
  );
  const previousExitCode = process.exitCode;
  try {
    const cli = await logCliCommand(silentLogger, "inspect", async () => {
      const result = await harness.session.execute("list_procedures", {});
      if (!result.ok) throw result.error;
      return result.value.result;
    });
    expect(process.exitCode).toBe(1);
    const parsed = analysisErrorProjectionSchema.parse(cli);
    expect(parsed).toMatchObject({
      code: "execution_failure",
      details: {
        diagnostics: {
          target_path: "/tmp/public-fixture",
          failure_kind: "protocol",
          failure_message:
            "Ghidra serial request execution rejected unexpectedly",
          failure_cause: {
            name: "TypeError",
            code: "EDECODE",
            message:
              "Decode failed [REDACTED]: /tmp/password-fixture http://localhost/secret?token=public-value",
          },
        },
      },
    });
    const mcp = await harness.mcp.callTool({
      name: "list_procedures",
      arguments: {},
    });
    expect(mcp.isError).toBe(true);
    expect(parseMcpToolError(mcp)).toMatchObject({ error: parsed });
    expect(mcp.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("EDECODE"),
      }),
    );
    expect(JSON.stringify(mcp)).not.toContain(token);
    expect(JSON.stringify(mcp)).not.toContain(cause.stack);
  } finally {
    process.exitCode = previousExitCode;
    await harness.close();
  }
}, 30_000);

it("projects an oversized bridge reply as a transport constraint and keeps the session", async () => {
  let replies = 0;
  const harness = await connectGhidraMcp("ghidra-oversized-reply", () =>
    Promise.resolve(
      replies++ === 0
        ? err(
            new GhidraSessionError(
              "resource",
              "Ghidra response line exceeds the runtime string length limit",
            ),
          )
        : ok([]),
    ),
  );
  try {
    const oversized = await harness.mcp.callTool({
      name: "list_strings",
      arguments: {},
    });
    expect(parseMcpToolError(oversized)).toMatchObject({
      error: {
        code: "resource_constraint",
        retryable: false,
        remediation: {
          action: expect.stringContaining(
            "The analysis session remains available.",
          ),
        },
        details: {
          operation: "list_strings",
          resource: "transport",
          reported_limits: {
            maximum_line_length: constants.MAX_STRING_LENGTH,
          },
        },
      },
    });

    const next = await harness.mcp.callTool({
      name: "list_strings",
      arguments: {},
    });
    expect(next.isError).not.toBe(true);
    expect(harness.calls).toEqual(["list_strings", "list_strings"]);
  } finally {
    await harness.close();
  }
}, 30_000);
