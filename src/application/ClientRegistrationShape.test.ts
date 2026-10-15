import { describe, expect, it } from "vitest";
import { registrationSchemaFor } from "./ClientRegistrationShape.js";

describe("Codex registration shape", () => {
  const parse = registrationSchemaFor("toml");

  it("accepts the tool policy map that Codex stores", () => {
    expect(
      parse.safeParse({
        command: "rea",
        tools: { inspect: { approval_mode: "prompt", custom: true } },
      }).success,
    ).toBe(true);
  });

  it("rejects invalid tool timeouts and approval modes", () => {
    for (const value of [
      { command: "rea", tool_timeout_sec: -1 },
      {
        command: "rea",
        tools: { inspect: { approval_mode: "bogus" } },
      },
      { command: "rea", tools: { inspect: { approval_mode: 1 } } },
    ])
      expect(parse.safeParse(value).success).toBe(false);
  });
});
