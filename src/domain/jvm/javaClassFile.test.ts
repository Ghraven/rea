import { describe, expect, it } from "vitest";

import { CONSTANT_TAG, parseJavaClassFile } from "./javaClassFile.js";

/** Minimal big-endian builder so fixtures read like the class-file layout they encode. */
class Blob {
  private readonly parts: number[] = [];
  u1(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }
  u2(v: number): this {
    this.parts.push((v >> 8) & 0xff, v & 0xff);
    return this;
  }
  u4(v: number): this {
    this.parts.push(
      (v >>> 24) & 0xff,
      (v >> 16) & 0xff,
      (v >> 8) & 0xff,
      v & 0xff,
    );
    return this;
  }
  utf8(text: string): this {
    const bytes = [...text].map((c) => c.charCodeAt(0));
    this.u2(bytes.length);
    this.parts.push(...bytes);
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/**
 * A minimal class with one `<init>` method carrying a `Code` attribute and a
 * class-level `SourceFile`, plus a `long` constant to exercise the two-slot rule.
 * Constant-pool layout (1-based): 1 Utf8 "<init>", 2 Utf8 "()V", 3 Utf8 "Code",
 * 4 Utf8 "SourceFile", 5 Utf8 "Example.java", 6 Long (slots 6-7), 8 Utf8 "Example",
 * 9 Class -> 8.
 */
const minimalClass = (): Uint8Array =>
  new Blob()
    .u4(0xcafebabe)
    .u2(0) // minor
    .u2(52) // major (Java 8)
    .u2(10) // constant_pool_count = 10 (entries 1..9, with 7 unusable)
    .u1(CONSTANT_TAG.utf8)
    .utf8("<init>")
    .u1(CONSTANT_TAG.utf8)
    .utf8("()V")
    .u1(CONSTANT_TAG.utf8)
    .utf8("Code")
    .u1(CONSTANT_TAG.utf8)
    .utf8("SourceFile")
    .u1(CONSTANT_TAG.utf8)
    .utf8("Example.java")
    .u1(CONSTANT_TAG.long)
    .u4(0)
    .u4(42) // entry 6; entry 7 is unusable
    .u1(CONSTANT_TAG.utf8)
    .utf8("Example") // entry 8
    .u1(CONSTANT_TAG.class)
    .u2(8) // entry 9 -> name index 8
    .u2(0x0021) // access_flags (public super)
    .u2(9) // this_class
    .u2(0) // super_class
    .u2(0) // interfaces_count
    .u2(0) // fields_count
    .u2(1) // methods_count
    // method: <init>()V with one Code attribute (empty info)
    .u2(0x0001)
    .u2(1)
    .u2(2)
    .u2(1)
    .u2(3)
    .u4(0)
    // class attributes: SourceFile -> Example.java
    .u2(1)
    .u2(4)
    .u4(2)
    .u2(5)
    .bytes();

describe("parseJavaClassFile framing", () => {
  it("frames version, constant pool, and a method with its attribute name resolved", () => {
    const result = parseJavaClassFile(minimalClass());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cls = result.value;
    expect(cls.majorVersion).toBe(52);
    expect(cls.methods).toHaveLength(1);
    const init = cls.methods[0]!;
    expect(init.name).toBe("<init>");
    expect(init.descriptor).toBe("()V");
    expect(init.attributes[0]!.name).toBe("Code");
  });

  it("marks the slot after a long constant unusable so later indices stay aligned", () => {
    const result = parseJavaClassFile(minimalClass());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.constantPool[7]).toEqual({ kind: "unusable" });
    expect(result.value.constantPool[8]).toEqual({
      tag: 1,
      kind: "utf8",
      value: "Example",
    });
  });

  it("exposes the SourceFile attribute at class level with raw info retained", () => {
    const result = parseJavaClassFile(minimalClass());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sourceFile = result.value.attributes.find(
      (a) => a.name === "SourceFile",
    );
    expect(sourceFile?.info).toEqual(Uint8Array.from([0, 5]));
  });

  it("rejects a buffer whose magic is not 0xCAFEBABE", () => {
    const result = parseJavaClassFile(
      Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "bad-magic", offset: 0 },
    });
  });

  it("reports truncation rather than throwing on a short header", () => {
    const result = parseJavaClassFile(
      Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0x00]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("truncated");
  });

  it("rejects a Utf8 constant whose lead byte is a stray continuation byte", () => {
    // A two-byte modified-UTF8 lead is 110xxxxx (>= 0xc0); 0x80 is a bare
    // continuation byte and must not be decoded as a valid character.
    const blob = new Blob()
      .u4(0xcafebabe)
      .u2(0)
      .u2(52)
      .u2(2) // constant_pool_count = 2 (one entry at index 1)
      .u1(CONSTANT_TAG.utf8)
      .u2(2) // length = 2 bytes
      .u1(0x80) // invalid lead
      .u1(0x80)
      .bytes();
    const result = parseJavaClassFile(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-utf8");
  });

  it("decodes a CESU-8 supplementary pair (U+1F600) to its UTF-16 surrogates", () => {
    // Modified UTF-8 encodes a supplementary character as two 3-byte sequences,
    // one per UTF-16 surrogate (CESU-8): U+1F600 -> D83D DE00.
    const threeByte = (unit: number): number[] => [
      0xe0 | (unit >> 12),
      0x80 | ((unit >> 6) & 0x3f),
      0x80 | (unit & 0x3f),
    ];
    const encoded = [...threeByte(0xd83d), ...threeByte(0xde00)];
    const head = new Blob()
      .u4(0xcafebabe)
      .u2(0)
      .u2(52)
      .u2(2)
      .u1(CONSTANT_TAG.utf8)
      .u2(encoded.length);
    const tail = new Blob()
      .u2(0x0021) // access_flags
      .u2(0) // this_class
      .u2(0) // super_class
      .u2(0) // interfaces
      .u2(0) // fields
      .u2(0) // methods
      .u2(0); // class attributes
    const bytes = Uint8Array.from([
      ...head.bytes(),
      ...encoded,
      ...tail.bytes(),
    ]);
    const result = parseJavaClassFile(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.constantPool[1]).toEqual({
      tag: 1,
      kind: "utf8",
      value: "😀",
    });
  });

  it("accepts the modified-UTF8 0xC0 0x80 encoding of U+0000", () => {
    const blob = new Blob()
      .u4(0xcafebabe)
      .u2(0)
      .u2(52)
      .u2(2)
      .u1(CONSTANT_TAG.utf8)
      .u2(2)
      .u1(0xc0)
      .u1(0x80)
      .u2(0x0021)
      .u2(0)
      .u2(0)
      .u2(0)
      .u2(0)
      .u2(0)
      .u2(0)
      .bytes();
    const result = parseJavaClassFile(blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.constantPool[1]).toEqual({
      tag: 1,
      kind: "utf8",
      value: "\u0000",
    });
  });

  it("refuses an impossible method count instead of allocating", () => {
    const blob = new Blob()
      .u4(0xcafebabe)
      .u2(0)
      .u2(52)
      .u2(1) // empty constant pool
      .u2(0x0021)
      .u2(0)
      .u2(0)
      .u2(0) // interfaces
      .u2(0) // fields
      .u2(0xffff) // methods_count far beyond the buffer
      .bytes();
    const result = parseJavaClassFile(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("budget-exceeded");
  });
});
