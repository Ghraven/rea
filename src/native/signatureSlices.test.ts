import { describe, expect, it } from "vitest";
import {
  describeSignatureSlices,
  describeSignedSlicesOfUnsignedDefault,
  type AggregateSignature,
  type SliceSignature,
} from "./signatureSlices.js";

const ARM = "133d589374281103e27b32ee243781884bc41413";
const X86 = "269615ed3412eb7a8c0945e51c76355412db4b12";

const aggregate: AggregateSignature = {
  identifier: "com.example.armslice",
  team_identifier: null,
  cdhashes: [ARM],
  authorities: [],
  hardened_runtime: true,
  entitlements: { "com.apple.security.cs.disable-library-validation": true },
  designated_requirement: `cdhash H"${ARM}" or cdhash H"${X86}"`,
};

const armSlice: SliceSignature = {
  architecture: "arm64",
  identifier: "com.example.armslice",
  team_identifier: null,
  cdhashes: [ARM],
  authorities: [],
  hardened_runtime: true,
};

const x86Slice: SliceSignature = {
  architecture: "x86_64",
  identifier: "com.example.x86slice",
  team_identifier: null,
  cdhashes: [X86],
  authorities: [],
  hardened_runtime: false,
  entitlements: { "com.apple.security.get-task-allow": true },
};

describe("describeSignatureSlices", () => {
  it("returns nothing when no signed slice was queried", () => {
    expect(describeSignatureSlices(aggregate, [])).toEqual([]);
  });

  it("names the described slice and every differing field of the others", () => {
    expect(describeSignatureSlices(aggregate, [x86Slice, armSlice])).toEqual([
      `Signature fields describe the arm64 slice that codesign displayed by default; other signed slices: x86_64 (CDHash ${X86}).`,
      "Mach-O slices signed differently from the arm64 slice: x86_64 (identifier com.example.x86slice; hardened runtime off; entitlements com.apple.security.get-task-allow).",
      `designated_requirement covers the whole file and names CDHashes of other slices (x86_64 ${X86}); cdhashes lists only the described slice.`,
    ]);
  });

  it("does not attribute a requirement hash that matches no queried slice", () => {
    const stale = "ab".repeat(20);
    const limitations = describeSignatureSlices(
      {
        ...aggregate,
        designated_requirement: `cdhash H"${ARM}" or cdhash H"${X86}" or cdhash H"${stale}"`,
      },
      [x86Slice, armSlice],
    );
    expect(limitations.at(-1)).toBe(
      `designated_requirement covers the whole file and names CDHashes of other slices (x86_64 ${X86}) and names CDHashes matching no queried slice (${stale}); cdhashes lists only the described slice.`,
    );
    const onlyStale = describeSignatureSlices(
      { ...aggregate, designated_requirement: `cdhash H"${stale}"` },
      [armSlice],
    );
    expect(onlyStale.at(-1)).toBe(
      `designated_requirement covers the whole file and names CDHashes matching no queried slice (${stale}); cdhashes lists only the described slice.`,
    );
  });

  it("names signed slices when codesign's default slice is unsigned", () => {
    expect(describeSignedSlicesOfUnsignedDefault([])).toEqual([]);
    expect(describeSignedSlicesOfUnsignedDefault([armSlice])).toEqual([
      `Mach-O slices signed although codesign's default slice is unsigned: arm64 (identifier com.example.armslice; CDHash ${ARM}; hardened runtime on); signed is false for the default slice and their entitlements were not reported.`,
    ]);
  });

  it("reports only the described slice when the other slices are signed alike", () => {
    // An identity requirement names no CDHash, so nothing contradicts cdhashes.
    const alike: AggregateSignature = {
      ...aggregate,
      identifier: "com.apple.true",
      authorities: [
        "Software Signing",
        "Apple Code Signing Certification Authority",
      ],
      hardened_runtime: false,
      entitlements: null,
      designated_requirement: 'identifier "com.apple.true" and anchor apple',
    };
    const slice = (architecture: string, cdhash: string): SliceSignature => ({
      architecture,
      identifier: "com.apple.true",
      team_identifier: null,
      cdhashes: [cdhash],
      authorities: alike.authorities,
      hardened_runtime: false,
      entitlements: null,
    });
    expect(
      describeSignatureSlices(alike, [
        slice("x86_64", X86),
        slice("arm64e", ARM),
        slice("arm64e.x1", "ab".repeat(20)),
      ]),
    ).toEqual([
      `Signature fields describe the arm64e slice that codesign displayed by default; other signed slices: x86_64 (CDHash ${X86}), arm64e.x1 (CDHash ${"ab".repeat(20)}).`,
    ]);
  });

  it("keeps an unmatched default slice visible instead of guessing", () => {
    const limitations = describeSignatureSlices(
      { ...aggregate, cdhashes: ["ff".repeat(20)] },
      [x86Slice, armSlice],
    );
    expect(limitations[0]).toBe(
      `Signature fields describe the slice codesign displayed by default, which did not match any queried slice by CDHash; queried signed slices: x86_64 (CDHash ${X86}), arm64 (CDHash ${ARM}).`,
    );
    expect(limitations[1]).toContain(
      "Mach-O slices signed differently from the described slice: x86_64 (",
    );
  });

  it("does not report entitlements for a slice that was not asked for them", () => {
    const { entitlements: _omitted, ...withoutEntitlements } = x86Slice;
    const limitations = describeSignatureSlices(aggregate, [
      withoutEntitlements,
      armSlice,
    ]);
    expect(limitations[1]).toBe(
      "Mach-O slices signed differently from the arm64 slice: x86_64 (identifier com.example.x86slice; hardened runtime off).",
    );
  });

  it("describes empty and missing entitlements as none", () => {
    const limitations = describeSignatureSlices(
      { ...aggregate, entitlements: null },
      [
        {
          ...x86Slice,
          identifier: aggregate.identifier,
          hardened_runtime: true,
          entitlements: {},
        },
        armSlice,
      ],
    );
    expect(
      limitations.some((text) => text.includes("signed differently")),
    ).toBe(false);
    const differing = describeSignatureSlices(aggregate, [
      {
        ...x86Slice,
        identifier: aggregate.identifier,
        hardened_runtime: true,
        entitlements: null,
      },
      armSlice,
    ]);
    expect(differing[1]).toBe(
      "Mach-O slices signed differently from the arm64 slice: x86_64 (entitlements none).",
    );
  });

  it("compares CDHashes without regard to letter case", () => {
    const limitations = describeSignatureSlices(
      {
        ...aggregate,
        cdhashes: [ARM.toUpperCase()],
        designated_requirement: null,
      },
      [armSlice],
    );
    expect(limitations).toEqual([
      "Signature fields describe the arm64 slice that codesign displayed by default.",
    ]);
  });
});
