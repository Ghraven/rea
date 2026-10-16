import { resolve } from "node:path";
import { expect } from "vitest";

import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  analysisCliErrorEnvelopeSchema,
  analysisErrorProjectionSchema,
} from "../../../src/contracts/errorSchemas.js";
import { processTest } from "../../support/process/processFixture.js";

// Actual CLI subprocess and OS signals with a controlled browser session.
// This verifies adapter wiring and awaited cleanup, without launching Chromium.
processTest
  .skipIf(process.platform === "win32")
  .for(["SIGINT", "SIGTERM"] as const)(
  "awaits browser scenario cleanup and retains observations after %s",
  async (signal, { processes }) => {
    const child = processes.spawn(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/browserScenarioCancellation.mjs"),
        resolve("scripts/rea.mjs"),
        "capture-browser-scenario",
        JSON.stringify({
          browser: { mode: "launch", executable_path: "/controlled/chromium" },
          start_url: { url: "https://app.example.test/" },
          actions: [
            {
              step_id: "wait",
              action: "wait_for_timeout",
              duration_ms: 60_000,
            },
          ],
          storage: {},
          capture: { after_each_step: ["url"], at_end: [], events: [] },
        }),
        "--json",
      ],
      { env: { PATH: process.env.PATH ?? "" } },
    );
    child.stdin.end();
    let stdout = "",
      stderr = "",
      requested = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (!requested && stderr.includes("REA_CONTROLLED_BROWSER_READY"))
        requested = child.kill(signal);
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const exited = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code, exitSignal) =>
          resolveExit({ code, signal: exitSignal }),
        );
      });
      expect(requested, stderr).toBe(true);
      expect(exited, stderr).toEqual({
        code: signal === "SIGINT" ? 130 : 143,
        signal: null,
      });
      expect(stderr).toContain("signal_present=1");
      expect(stderr).toContain("REA_CONTROLLED_CLOSE_CALLBACK");
      expect(stderr).toContain("REA_CONTROLLED_PROFILE_CALLBACK");
      const document: unknown = JSON.parse(stdout);
      const { error: label, ...projection } =
        analysisCliErrorEnvelopeSchema.parse(document);
      expect(label).toBe("Browser scenario capture failed");
      const error = analysisErrorProjectionSchema.parse(projection);
      expect(error).toMatchObject({
        code: "cancelled",
        category: "cancelled",
      });
      if (error.code !== "cancelled")
        throw new Error(`Expected cancellation, received ${error.code}`);
      const evidence = parseEvidence(error.details?.partial_observation);
      expect(evidence).toMatchObject({
        operation: "capture_browser_scenario",
        authority: "controlled-replay",
        confidence: "observed",
      });
      const capture = browserScenarioCaptureSchema.parse(
        evidence.normalized_result,
      );
      expect(capture.browser.cleanup).toBe("terminated-owned-process");
      expect(capture.steps.map(({ status }) => status)).toEqual([
        "completed",
        "cancelled",
      ]);
      expect(capture.completeness.status).toBe("incomplete");
    } finally {
      clearTimeout(deadline);
    }
  },
);
