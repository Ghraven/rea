import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { inspectPlistSchema } from "../../../../src/domain/native/nativeInspection.js";
import { ok } from "../../../../src/domain/result.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const VALUE = { Name: "Example", Items: ["a", "b"] };
const XML =
  "<plist><dict><key>Name</key><string>Example</string><key>Items</key><array><string>a</string><string>b</string></array><key>Blob</key><data>3q2+7w==</data></dict></plist>";

class PlistSourceRunner extends NativeFixtureRunner {
  constructor(
    description: string,
    private readonly xmlFallback: boolean,
  ) {
    super({ file: description, plutil: JSON.stringify(VALUE) });
  }

  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "plutil" || !this.xmlFallback) return result;
    const json = arguments_.includes("json");
    const stdout = json ? "" : XML;
    return ok({
      ...result.value,
      stdout,
      stdoutBytes: Buffer.byteLength(stdout),
      exitCode: json ? 1 : 0,
    });
  }
}

const OPENSTEP = "{ Name = Example; Items = (a, b); }\n";

it.for([
  { description: "ASCII text\n", expected: "unknown", xmlFallback: false },
  // `file` reports XML without a declaration as plain text.
  {
    description: "ASCII text, with no line terminators\n",
    contents: `﻿ \n${XML}`,
    expected: "xml",
    xmlFallback: true,
  },
  { description: "ASCII text\n", expected: "unknown", xmlFallback: true },
  {
    description: "Unicode text, UTF-8 text\n",
    expected: "unknown",
    xmlFallback: false,
  },
  {
    description: "XML 1.0 document text, ASCII text\n",
    expected: "xml",
    xmlFallback: false,
  },
  {
    description:
      "XML 1.0 document text, Unicode text, UTF-16, big-endian text\n",
    expected: "xml",
    xmlFallback: true,
  },
  {
    description: "Apple binary property list\n",
    expected: "binary",
    xmlFallback: true,
  },
])(
  "keeps source format $expected for $description (XML fallback: $xmlFallback)",
  async (
    { description, contents = OPENSTEP, expected, xmlFallback },
    { onTestFinished },
  ) => {
    const root = await createTestTempDirectory("rea-plist-source-format-");
    const path = join(root, "selected.plist");
    await writeFile(path, contents);
    const client = new NativeMacOSProvider(
      {},
      new PlistSourceRunner(description, xmlFallback),
      "darwin",
    ).createClient(nativeMachoTarget(join(root, "target")));
    onTestFinished(async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    });

    const inspected = await client.execute("inspect_plist", { path });
    if (!inspected.ok) throw inspected.error;
    const result = inspectPlistSchema.parse(inspected.value.result);
    expect(result.format).toBe(expected);
    expect(result.source_path).toBe(path);
    expect(result.value).toEqual({
      ...VALUE,
      ...(xmlFallback
        ? { Blob: { $plist_type: "data", base64: "3q2+7w==" } }
        : {}),
    });
    expect(result.provenance.map(({ tool }) => tool)).toEqual(
      xmlFallback ? ["file", "plutil", "plutil"] : ["file", "plutil"],
    );
    expect(result.limitations).toEqual(
      xmlFallback ? [expect.stringContaining("XML conversion")] : [],
    );
  },
);
