import { expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { parseEvidence } from "../domain/evidence.js";
import { browserScenarioInputSchema } from "../domain/browserScenario.js";
import { err, ok } from "../domain/result.js";
import { scriptScenarioFixture } from "../../tests/fixtures/webScriptCapture.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "./BrowserScenarioCaptureService.js";

const scenario = browserScenarioInputSchema.parse({
  browser: { mode: "launch", executable_path: "/fixture/chrome" },
  start_url: { url: "https://fixture.test/", query: [] },
  actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 1 }],
});
const capture = scriptScenarioFixture();

it("retains interrupted raw observations without relabeling cancellation", async () => {
  const partial = {
    kind: "browser-scenario-observation" as const,
    capture: {
      browser: capture.browser,
      scenario: capture.scenario,
      duration_ms: capture.duration_ms,
      steps: capture.steps.slice(0, 1),
      events: capture.events,
      limitations: capture.limitations,
    },
  };
  const failure = new AnalysisCancelledError("capture_browser_scenario", {
    partialObservation: partial,
  });
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "scenario-fixture",
      name: "Scenario fixture",
      version: "1",
    }),
    captureScenario: async () => err(failure),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result).toEqual(err(failure));
  expect(failure.partialObservation).toBe(partial);
});

it("still rejects a malformed successful capture before Evidence composition", async () => {
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "scenario-fixture",
      name: "Scenario fixture",
      version: "1",
    }),
    captureScenario: async () => ok({ ...capture, steps: [] }),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
  expect(result.error.partialObservation).toBeUndefined();
});

it("converts a retained raw scenario capture into partial Evidence", async () => {
  const failure = new AnalysisCancelledError("capture_browser_scenario", {
    partialObservation: {
      kind: "browser-scenario-observation",
      capture,
    },
  });
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "scenario-fixture",
      name: "Scenario fixture",
      version: "1",
    }),
    captureScenario: async () => err(failure),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "capture_browser_scenario",
      normalized_result: capture,
    });
  }
});

it("converts a raw scenario capture retained after cleanup failure", async () => {
  const failure = new BrowserObservationError(
    "capture_browser_scenario",
    "cleanup_failed",
    {
      cleanup: {
        reason: "browser close failed",
        resources: ["browser process"],
      },
      partialObservation: {
        kind: "browser-scenario-observation",
        capture,
      },
    },
  );
  const provider: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "scenario-fixture",
      name: "Scenario fixture",
      version: "1",
    }),
    captureScenario: async () => err(failure),
  };
  const result = await captureBrowserScenario(provider, scenario);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "capture_browser_scenario",
      normalized_result: capture,
    });
  }
});
