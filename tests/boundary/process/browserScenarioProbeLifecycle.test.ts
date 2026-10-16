import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

import type { OptionalProviderLoadResult } from "../../../src/application/OptionalObservationProviders.js";
import { silentLogger } from "../../../src/logger.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

it("keeps shared observation providers open when the SDK discards its discovery probe", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const { providers, closes } = createOptionalProvidersFixture();
  const factories: Parameters<RuntimeDependencies["serve"]>[0][] = [];
  const runtime: RuntimeDependencies = {
    env: {},
    serve: (factory) => {
      factories.push(factory);
      return { close: async () => undefined };
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  const transport = await startMcpTransport(runtime, session, {
    logger: silentLogger,
    serverLogger: silentLogger,
    environment: runtime.env,
    delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    loadOptionalProviders: async () => providers,
  });
  if (!transport.ok) throw new Error("Transport failed");
  const factory = factories[0];
  if (factory === undefined) throw new Error("Missing SDK server factory");
  try {
    const probe = await factory({ era: "modern" });
    await probe.close();
    const replacement = await factory({ era: "legacy" });
    await replacement.close();
    for (const close of Object.values(closes))
      expect(close).not.toHaveBeenCalled();

    await transport.closeOptionalProviders();
    await transport.closeOptionalProviders();
    for (const close of Object.values(closes))
      expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await transport.handle.close();
    await transport.closeOptionalProviders();
    await transport.closeAndroid();
    await session.close();
  }
});

it("closes optional providers when MCP server startup throws", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const { providers, closes } = createOptionalProvidersFixture();
  const runtime: RuntimeDependencies = {
    env: {},
    serve: () => {
      throw new Error("Server startup failed");
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  try {
    const transport = await startMcpTransport(runtime, session, {
      logger: silentLogger,
      serverLogger: silentLogger,
      environment: runtime.env,
      delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
      loadOptionalProviders: async () => providers,
    });

    expect(transport).toEqual({ ok: false });
    for (const close of Object.values(closes))
      expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
  }
});

it("shares optional-provider cleanup and retries only failed owners", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const { providers, closes } = createOptionalProvidersFixture();
  const release = createDeferred<void>();
  const failure = new Error("Scenario cleanup refused");
  closes.scenario.mockImplementationOnce(async () => {
    await release.promise;
    throw failure;
  });
  const runtime: RuntimeDependencies = {
    env: {},
    serve: () => ({ close: async () => undefined }),
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
  };
  const transport = await startMcpTransport(runtime, session, {
    logger: silentLogger,
    serverLogger: silentLogger,
    environment: runtime.env,
    delivery: new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
    loadOptionalProviders: async () => providers,
  });
  if (!transport.ok) throw new Error("Transport failed");
  try {
    const first = transport.closeOptionalProviders();
    const concurrent = transport.closeOptionalProviders();
    release.resolve();
    const outcomes = await Promise.allSettled([first, concurrent]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    for (const close of Object.values(closes))
      expect(close).toHaveBeenCalledTimes(1);

    await transport.closeOptionalProviders();
    await transport.closeOptionalProviders();
    expect(closes.browser).toHaveBeenCalledTimes(1);
    expect(closes.scenario).toHaveBeenCalledTimes(2);
    expect(closes.electron).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    await transport.handle.close();
    await transport.closeOptionalProviders();
    await transport.closeAndroid();
    await session.close();
  }
});

it("retains observation-provider ownership for directly constructed servers", async () => {
  const { providers, closes } = createOptionalProvidersFixture();
  const server = createServer(
    {
      kind: "fixed",
      analysis: {
        execute: async () => {
          throw new Error("Unexpected analysis");
        },
      },
    },
    providers,
  );
  try {
    await server.close();
    await server.close();
    for (const close of Object.values(closes))
      expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
  }
});

const createOptionalProvidersFixture = () => {
  const identity = () => ({
    id: "observation-fixture",
    name: "Observation fixture",
    version: "1",
  });
  const unexpected = async () => {
    throw new Error("Unexpected observation");
  };
  const closes = {
    browser: vi.fn(async () => undefined),
    scenario: vi.fn(async () => undefined),
    electron: vi.fn(async () => undefined),
  };
  const providers = {
    browserObservation: {
      identity,
      close: closes.browser,
      listTargets: unexpected,
      inspectPage: unexpected,
      analyzeBundle: unexpected,
      observeSession: unexpected,
      discoverWebMcpTools: unexpected,
      compareCaptures: unexpected,
      captureScreenshot: unexpected,
      compareScreenshots: unexpected,
    },
    browserScenarioCapture: {
      identity,
      close: closes.scenario,
      captureScenario: unexpected,
    },
    electronObservation: {
      identity,
      close: closes.electron,
      listTargets: unexpected,
      inspectPage: unexpected,
    },
  } satisfies OptionalProviderLoadResult;
  return { providers, closes };
};
