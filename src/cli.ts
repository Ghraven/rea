import { registerCaptureCommands } from "./cli/captureCommands.js";
import { registerSignalCommands } from "./cli/signalCommands.js";
import { registerWasmCommands } from "./cli/wasmCommands.js";
import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { createDirectAnalysis } from "./composition/directAnalysis.js";
import { registerEvmCommands } from "./cli/evmCommands.js";
import { registerGoCommands } from "./cli/goCommands.js";
import { registerRustCommands } from "./cli/rustCommands.js";
import { registerSqliteCommands } from "./cli/sqliteCommands.js";
import { registerAnalysisViewCommands } from "./cli/analysisViewCommands.js";
import { registerBinaryDiagnosticsCommands } from "./cli/binaryDiagnosticsCommands.js";
import { registerFridaCommands } from "./cli/fridaCommands.js";
import type { FridaInstrumentationPort } from "./application/frida/FridaInstrumentationPort.js";
import { createLogger, parseLogLevel } from "./logger.js";
import { createCliBase } from "./cliBase.js";
import { registerSetupCommands } from "./cli/setupCommands.js";
import { registerCoreAnalysisCommands } from "./cli/coreAnalysisCommands.js";
import { registerUtilityCommands } from "./cli/utilityCommands.js";
import { registerArtifactCommands } from "./cli/artifactCommands.js";
import { registerManagedCommands } from "./cli/managedCommands.js";
import { registerFirmwareCommands } from "./cli/firmwareCommands.js";
import { registerAndroidCommands } from "./cli/androidCommands.js";
import { registerApktoolCommands } from "./cli/apktoolCommands.js";
import { registerPcapCommands } from "./cli/pcapCommands.js";
import { registerFlutterCommands } from "./cli/flutterCommands.js";
import { registerJebCommands } from "./cli/jebCommands.js";
import { registerAdbCommands } from "./cli/adbCommands.js";
import { registerEvidenceCommands } from "./cliEvidenceCommands.js";
import { registerProcessCommands } from "./cli/processCommands.js";
import { registerBrowserCommands } from "./cli/browserCommands.js";
import { registerWebScriptCommands } from "./cli/webScriptCommands.js";
import { registerWebModuleCommands } from "./cli/webModuleCommands.js";
import { registerWebSourceLocationCommands } from "./cli/webSourceLocationCommands.js";
import { registerWebRuntimeCommands } from "./cli/webRuntimeCommands.js";
import { registerWebNetworkCaptureCommands } from "./cli/webNetworkCaptureCommands.js";
import { registerJavaScriptRecoveryCommands } from "./cli/javascriptRecoveryCommands.js";
import { registerAdvancedBrowserCommands } from "./cli/browserAdvancedCommands.js";
import { registerBrowserScenarioCommands } from "./cliBrowserScenarioCommands.js";
import { registerElectronCommands } from "./cli/electronCommands.js";
import { registerJavaScriptRuntimeObservationCommands } from "./cliJavaScriptRuntimeCommands.js";
import { registerApplicationCommands } from "./cli/applicationCommands.js";
import { presentOmittableDefaults } from "./cli/omittableDefaults.js";
import type { CliInstance } from "./cli/types.js";
import {
  streamCliCommandResults,
  type CliResultOutput,
} from "./cli/cliResultOutput.js";
import { registerReverseEngineeringCommands } from "./cli/reverseEngineeringCommands.js";
import { registerCutterCommands } from "./cli/cutterCommands.js";

export { cliConfigurationError } from "./cliBase.js";

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 */
export const createCli = (
  selectedEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
  resultOutput?: CliResultOutput,
  fridaInstrumentation?: FridaInstrumentationPort,
): CliInstance => {
  const environment = snapshotEnvironment(selectedEnvironment);
  const analysis = createDirectAnalysis(environment);
  // The executable reports an invalid level through cliConfigurationError.
  const level =
    environment.REA_LOG_LEVEL === undefined
      ? undefined
      : parseLogLevel(environment.REA_LOG_LEVEL);
  const logger = createLogger(
    "cli",
    level?.ok === true ? level.value : "silent",
  );
  const cli = createCliBase();

  registerSetupCommands(cli, logger, environment);
  registerReverseEngineeringCommands(cli, logger, environment);
  registerCutterCommands(cli, logger, environment);
  registerCoreAnalysisCommands(cli, logger, analysis.runDirectAnalysis);
  registerUtilityCommands(cli, logger, environment, analysis);
  registerWasmCommands(cli, logger, environment);
  registerCaptureCommands(cli, logger, environment);
  registerSignalCommands(cli, logger, environment);
  registerEvmCommands(cli, logger, environment);
  registerGoCommands(cli, logger);
  registerRustCommands(cli, logger);
  registerSqliteCommands(cli, logger, environment);
  registerArtifactCommands(cli, logger, analysis.runProviderAnalysis);
  registerManagedCommands(cli, logger, analysis.runProviderAnalysis);
  registerAndroidCommands(cli, logger, environment);
  registerApktoolCommands(cli, logger, environment);
  registerPcapCommands(cli, logger, environment);
  registerFlutterCommands(cli, logger);
  registerJebCommands(cli, logger, environment);
  registerAdbCommands(cli, logger, environment);
  registerFirmwareCommands(cli, logger, environment);
  registerBinaryDiagnosticsCommands(cli, logger, environment);
  registerAnalysisViewCommands(cli, logger);
  registerFridaCommands(cli, logger, fridaInstrumentation);
  registerEvidenceCommands(cli, logger);
  registerProcessCommands(cli, logger, environment);
  registerBrowserCommands(cli, logger);
  registerWebScriptCommands(cli, logger);
  registerWebModuleCommands(cli, logger, environment);
  registerWebSourceLocationCommands(cli, logger, environment);
  registerWebRuntimeCommands(cli, logger);
  registerWebNetworkCaptureCommands(cli, logger, environment);
  registerJavaScriptRecoveryCommands(cli, logger, environment);
  registerAdvancedBrowserCommands(cli, logger);
  registerBrowserScenarioCommands(cli, logger, environment);
  registerElectronCommands(cli, logger, environment);
  registerJavaScriptRuntimeObservationCommands(cli, logger);
  registerApplicationCommands(cli, logger);
  presentOmittableDefaults(cli);
  if (resultOutput !== undefined) streamCliCommandResults(cli, resultOutput);
  return cli;
};
