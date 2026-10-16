import { canonicalJson } from "../domain/comparisonSemantics.js";
import type { JsonValue } from "../domain/jsonValue.js";

/**
 * Signing facts codesign reports for one slice of a universal Mach-O, read
 * with `codesign -d -a <architecture>`.
 */
export interface SliceSignature {
  readonly architecture: string;
  readonly identifier: string | null;
  readonly team_identifier: string | null;
  readonly cdhashes: readonly string[];
  readonly authorities: readonly string[];
  readonly hardened_runtime: boolean | null;
  /** Parsed entitlements; undefined when the slice was not asked for them. */
  readonly entitlements?: JsonValue | null;
}

/**
 * The aggregate signing facts, read without `-a`. codesign then describes one
 * slice (its default for the host), while `codesign -d -r-` on an ad hoc
 * signature prints a requirement covering every slice.
 */
export interface AggregateSignature {
  readonly identifier: string | null;
  readonly team_identifier: string | null;
  readonly cdhashes: readonly string[];
  readonly authorities: readonly string[];
  readonly hardened_runtime: boolean | null;
  readonly entitlements: JsonValue | null;
  readonly designated_requirement: string | null;
}

/**
 * Explain which slice the aggregate signature fields describe, and name the
 * slices whose signing differs from it. Each architecture is signed
 * independently, so a universal file can carry different identifiers,
 * hardened-runtime flags and entitlements per slice while the aggregate
 * fields show only one of them.
 *
 * Returns limitation sentences for the result; nothing when no signed slice
 * was queried.
 */
export const describeSignatureSlices = (
  aggregate: AggregateSignature,
  slices: readonly SliceSignature[],
): string[] => {
  if (slices.length === 0) return [];
  const described = slices.find((slice) =>
    sameCdhashes(slice.cdhashes, aggregate.cdhashes),
  );
  const others = slices.filter((slice) => slice !== described);
  const limitations: string[] = [];
  const otherHashes = others
    .map(
      (slice) => `${slice.architecture} (CDHash ${listOrNone(slice.cdhashes)})`,
    )
    .join(", ");
  if (described === undefined)
    limitations.push(
      `Signature fields describe the slice codesign displayed by default, which did not match any queried slice by CDHash; queried signed slices: ${otherHashes}.`,
    );
  else
    limitations.push(
      others.length === 0
        ? `Signature fields describe the ${described.architecture} slice that codesign displayed by default.`
        : `Signature fields describe the ${described.architecture} slice that codesign displayed by default; other signed slices: ${otherHashes}.`,
    );
  const differing = others
    .map((slice) => describeDifferences(aggregate, slice))
    .filter((text): text is string => text !== null);
  if (differing.length > 0)
    limitations.push(
      `Mach-O slices signed differently from the ${described?.architecture ?? "described"} slice: ${differing.join(", ")}.`,
    );
  limitations.push(
    ...describeRequirementHashes(aggregate.designated_requirement, {
      own: aggregate.cdhashes,
      slices: others,
    }),
  );
  return limitations;
};

/**
 * Name the signed slices of a universal file whose default slice is unsigned.
 * codesign then reports the whole file as unsigned, so the result's `signed`
 * field describes that default slice and these facts live in limitations.
 */
export const describeSignedSlicesOfUnsignedDefault = (
  slices: readonly SliceSignature[],
): string[] =>
  slices.length === 0
    ? []
    : [
        `Mach-O slices signed although codesign's default slice is unsigned: ${slices
          .map(
            (slice) =>
              `${slice.architecture} (identifier ${slice.identifier ?? "unavailable"}; CDHash ${listOrNone(slice.cdhashes)}; hardened runtime ${runtimeState(slice.hardened_runtime)})`,
          )
          .join(
            ", ",
          )}; signed is false for the default slice and their entitlements were not reported.`,
      ];

/**
 * A requirement from `codesign -d -r-` covers the whole file. Say which of
 * its CDHashes belong to other queried slices, and which match no slice at
 * all (a custom requirement can name a previous build), without guessing.
 */
const describeRequirementHashes = (
  requirement: string | null,
  known: {
    readonly own: readonly string[];
    readonly slices: readonly SliceSignature[];
  },
): string[] => {
  const own = new Set(known.own.map((hash) => hash.toLowerCase()));
  const foreign = requirementCdhashes(requirement).filter(
    (hash) => !own.has(hash),
  );
  if (foreign.length === 0) return [];
  const sliceOf = (hash: string) =>
    known.slices.find((slice) =>
      slice.cdhashes.some((candidate) => candidate.toLowerCase() === hash),
    );
  const bySlice = foreign.flatMap((hash) => {
    const slice = sliceOf(hash);
    return slice === undefined ? [] : [`${slice.architecture} ${hash}`];
  });
  const unmatched = foreign.filter((hash) => sliceOf(hash) === undefined);
  const parts: string[] = [];
  if (bySlice.length > 0)
    parts.push(`names CDHashes of other slices (${bySlice.join(", ")})`);
  if (unmatched.length > 0)
    parts.push(
      `names CDHashes matching no queried slice (${unmatched.join(", ")})`,
    );
  return [
    `designated_requirement covers the whole file and ${parts.join(" and ")}; cdhashes lists only the described slice.`,
  ];
};

/** Name the fields of one slice that differ from the aggregate, or null. */
const describeDifferences = (
  aggregate: AggregateSignature,
  slice: SliceSignature,
): string | null => {
  const differences: string[] = [];
  if (slice.identifier !== aggregate.identifier)
    differences.push(`identifier ${slice.identifier ?? "unavailable"}`);
  if (slice.team_identifier !== aggregate.team_identifier)
    differences.push(`team identifier ${slice.team_identifier ?? "not set"}`);
  if (!sameSequence(slice.authorities, aggregate.authorities))
    differences.push(`authorities ${listOrNone(slice.authorities)}`);
  if (slice.hardened_runtime !== aggregate.hardened_runtime)
    differences.push(
      `hardened runtime ${runtimeState(slice.hardened_runtime)}`,
    );
  if (
    slice.entitlements !== undefined &&
    canonicalJson(withoutEmptyDictionary(slice.entitlements)) !==
      canonicalJson(withoutEmptyDictionary(aggregate.entitlements))
  )
    differences.push(`entitlements ${entitlementKeys(slice.entitlements)}`);
  return differences.length === 0
    ? null
    : `${slice.architecture} (${differences.join("; ")})`;
};

const requirementCdhashes = (requirement: string | null): string[] => [
  ...new Set(
    [...(requirement ?? "").matchAll(/cdhash H"([0-9A-Fa-f]+)"/gu)].map(
      ([, hash]) => (hash ?? "").toLowerCase(),
    ),
  ),
];

/** Whether two CDHash lists name the same code directories. */
export const sameCdhashes = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const normalize = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.toLowerCase()))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length > 0 && sameSequence(a, b);
};

const sameSequence = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const listOrNone = (values: readonly string[]): string =>
  values.length === 0 ? "none" : values.join(", ");

const runtimeState = (value: boolean | null): string =>
  value === null ? "unknown" : value ? "on" : "off";

/** codesign prints nothing for no entitlements; an empty dictionary means the same. */
const withoutEmptyDictionary = (value: JsonValue | null): JsonValue | null =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 0
    ? null
    : value;

/** Entitlement keys, so the limitation stays short for large dictionaries. */
const entitlementKeys = (value: JsonValue | null | undefined): string => {
  if (value === null || value === undefined) return "none";
  if (typeof value !== "object" || Array.isArray(value))
    return "not a dictionary";
  const keys = Object.keys(value).sort();
  return keys.length === 0 ? "none" : keys.join(", ");
};
