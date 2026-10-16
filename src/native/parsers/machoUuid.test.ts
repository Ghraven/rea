import { describe, expect, it } from "vitest";
import { withOtoolMachHeader } from "../../../tests/fixtures/nativeCommands.js";
import { parseOtoolLoadCommands } from "./otool.js";
import { reconcileMachoUuid } from "./machoUuid.js";

const validUuid = "01234567-89AB-CDEF-0123-456789ABCDEF";
const path = "/fixture/app";

const commandsWithUuid = (uuid: string) =>
  parseOtoolLoadCommands(
    withOtoolMachHeader(
      `Load command 0\n      cmd LC_UUID\n  cmdsize 24\n     uuid ${uuid}`,
    ),
  ).commands;

/**
 * The inspection owner maps lipo's slice name to dwarfdump's spelling
 * (`arm64e.v1` to `arm64e`); this parser matches the mapped name exactly.
 */
const toolNames: Readonly<Record<string, string>> = { "arm64e.v1": "arm64e" };

const reconcile = (
  dwarfdump: string,
  selectedArchitecture: string | null,
  uuid = validUuid,
) =>
  reconcileMachoUuid(
    commandsWithUuid(uuid),
    dwarfdump,
    path,
    selectedArchitecture === null
      ? null
      : {
          name: selectedArchitecture,
          dwarfdumpName:
            toolNames[selectedArchitecture] ?? selectedArchitecture,
        },
  );

describe("Mach-O UUID row selection", () => {
  it("matches a dwarfdump row to an arm64e.v1 selection", () => {
    // lipo names the slice arm64e.v1; dwarfdump reports the CPU-family name.
    expect(
      reconcile(`UUID: ${validUuid} (arm64e) ${path}\n`, "arm64e.v1"),
    ).toEqual({
      value: validUuid,
      limitations: [],
    });
  });

  it("still matches an exact architecture name", () => {
    expect(reconcile(`UUID: ${validUuid} (arm64) ${path}\n`, "arm64")).toEqual({
      value: validUuid,
      limitations: [],
    });
  });

  it("keeps a distinct arm64e.x1 selection unmatched rather than guessing", () => {
    const result = reconcile(
      `UUID: ${validUuid} (arm64e) ${path}\n`,
      "arm64e.x1",
    );
    expect(result.limitations).toContain(
      "dwarfdump --uuid returned no row for selected architecture arm64e.x1; using the unambiguous otool LC_UUID.",
    );
  });

  it("keeps a genuinely absent row reported as absent", () => {
    expect(
      reconcile(`UUID: ${validUuid} (x86_64) ${path}\n`, "arm64e.v1"),
    ).toEqual({
      value: validUuid,
      limitations: [
        "dwarfdump --uuid returned no row for selected architecture arm64e.v1; using the unambiguous otool LC_UUID.",
      ],
    });
  });

  it("reports a conflict between two rows of the same family", () => {
    const other = "FEDCBA98-7654-3210-FEDC-BA9876543210";
    const result = reconcile(
      `UUID: ${validUuid} (arm64e) ${path}\nUUID: ${other} (arm64e) ${path}\n`,
      "arm64e.v1",
    );
    expect(result.limitations).toContain(
      "dwarfdump --uuid returned conflicting UUIDs for selected architecture arm64e.v1",
    );
  });
});
