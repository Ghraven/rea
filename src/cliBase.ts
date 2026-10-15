import { Cli } from "incur";

import { npxRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { parseLogLevel } from "./logger.js";

/** Describe CLI settings that are invalid before any command runs, as MCP does. */
export const cliConfigurationError = (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const value = selectedEnvironment.REA_LOG_LEVEL;
  if (value === undefined) return undefined;
  const level = parseLogLevel(value);
  return level.ok ? undefined : projectAnalysisError(level.error).message;
};

/** Shared CLI identity and builtins, without command-specific schemas. */
export const createCliBase = () =>
  Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    mcp: {
      command: npxRegistrationCommand().join(" "),
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
  });
