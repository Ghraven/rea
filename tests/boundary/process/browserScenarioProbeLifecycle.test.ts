import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import type { OptionalObservationProviders } from "../../../src/application/OptionalObservationProviders.js";
import { silentLogger } from "../../../src/logger.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it.each([false, true])(
  "keeps shared providers open across SDK probes and retries only failed cleanup: %s",
  async (failClose) => {
    const session = createTestBinarySession(() => {
      throw new Error("Unexpected deep provider");
    });
    const close = vi.fn(async () => undefined);
    if (failClose)
      close.mockRejectedValueOnce(new Error("browser close failed"));
    const browserScenarioCapture: BrowserScenarioCapturePort = {
      identity: () => ({
        id: "fake-browser",
        name: "Fake browser",
        version: "1",
      }),
      captureScenario: async () => {
        throw new Error("Unexpected scenario capture");
      },
      close,
    };
    const browserClose = vi.fn(async () => undefined);
    const electronClose = vi.fn(async () => undefined);
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected observation");
    };
    const providers: OptionalObservationProviders = {
      browserScenarioCapture,
      browserObservation: {
        identity: browserScenarioCapture.identity,
        close: browserClose,
        listTargets: unexpected,
        inspectPage: unexpected,
        analyzeBundle: unexpected,
        observeSession: unexpected,
        discoverWebMcpTools: unexpected,
        compareCaptures: unexpected,
        captureScreenshot: unexpected,
        compareScreenshots: unexpected,
      },
      electronObservation: {
        identity: browserScenarioCapture.identity,
        close: electronClose,
        listTargets: unexpected,
        inspectPage: unexpected,
      },
    };
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
      expect(close).not.toHaveBeenCalled();
      expect(browserClose).not.toHaveBeenCalled();
      expect(electronClose).not.toHaveBeenCalled();

      const closing = transport.closeOptionalProviders();
      expect(transport.closeOptionalProviders()).toBe(closing);
      if (failClose)
        await expect(closing).rejects.toThrow(
          "Optional provider cleanup failed",
        );
      else await closing;
      await transport.closeOptionalProviders();
      expect(close).toHaveBeenCalledTimes(failClose ? 2 : 1);
      expect(browserClose).toHaveBeenCalledTimes(1);
      expect(electronClose).toHaveBeenCalledTimes(1);
    } finally {
      await transport.closeAndroid();
      await session.close();
    }
  },
);

it("lets a standalone server own optional provider cleanup by default", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const close = vi.fn(async () => undefined);
  const server = createServer(
    { kind: "session", session },
    {
      browserScenarioCapture: {
        identity: () => ({
          id: "fake-browser",
          name: "Fake browser",
          version: "1",
        }),
        captureScenario: async () => {
          throw new Error("Unexpected scenario capture");
        },
        close,
      },
    },
  );
  try {
    await server.close();
    await server.close();
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
  }
});

it("closes optional providers when MCP server startup throws", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Unexpected deep provider");
  });
  const close = vi.fn(async () => undefined);
  const browserScenarioCapture: BrowserScenarioCapturePort = {
    identity: () => ({
      id: "fake-browser",
      name: "Fake browser",
      version: "1",
    }),
    captureScenario: async () => {
      throw new Error("Unexpected scenario capture");
    },
    close,
  };
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
      loadOptionalProviders: async () => ({ browserScenarioCapture }),
    });

    expect(transport).toEqual({ ok: false });
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await session.close();
  }
});
