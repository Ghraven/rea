import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each([
  "Object.assign(module, { [key]: replacement });",
  "Object.assign(module, { ...replacement });",
  "Object.assign(module, { require() {} });",
  "Object.defineProperties(module, { [key]: { value: replacement } });",
  "Reflect.set(module, 'require', replacement);",
  "Reflect.set(module, key, replacement);",
  "Reflect.set({}, 'require', replacement, module);",
  "const receiver=module; Reflect.set({}, 'require', replacement, receiver);",
  "Reflect.set(module, 'require', replacement, receiver);",
  "Reflect.set(module, 'require', replacement, ...receivers);",
  "Reflect.apply(Reflect.set, null, [{}, 'require', replacement, module]);",
  "const set=Reflect.set.bind(null, {}, 'require', replacement); set(module);",
  "Object.defineProperty(module, 'require', {value: replacement}, {});",
  "let owner=module; owner.require=replacement; owner={};",
  "Object.create=()=>module; const registry=Object.create(null); Reflect.set(registry, key, replacement);",
  "function Object(){}; Object.create=()=>module; Reflect.set(Object.create(null), key, replacement);",
  "const receiver=require('./local'); Reflect.set(receiver, 'require', replacement);",
  "let receiver=require('fs'); receiver=module; Reflect.set(receiver, 'require', replacement);",
  "Object.create.call=()=>module; const registry=Object.create.call(null,null); Reflect.set(registry,'require',replacement);",
  "Object.create.apply=()=>module; const registry=Object.create.apply(null,[null]); Reflect.set(registry,'require',replacement);",
  "Object.create.bind=()=>()=>module; const make=Object.create.bind(null,null); Reflect.set(make(),'require',replacement);",
])("invalidates the wrapper loader at its write: %s", (write) => {
  const ir = analyzeJavaScriptSemantics(`${write}
    const fs=require('fs'); fs.readFileSync('wrong');`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each([
  "Object.assign(module, { unrelated: replacement });",
  "Object.defineProperties(module, { unrelated: { value: replacement } });",
  "Reflect.set(module, 'unrelated', replacement);",
  "const registry=Object.create(null); Reflect.set(registry, key, replacement);",
  "const registry=Object.create(module); Reflect.set(registry, 'require', replacement);",
  "const fs=require('node:fs'); Reflect.set(fs, 'require', replacement);",
  "const fs=require('fs'); const receiver=fs; Reflect.set(module, 'require', replacement, receiver);",
  "import * as fs from 'node:fs'; Reflect.set(fs, 'require', replacement);",
  "let receiver=module; receiver=require('fs'); Reflect.set(receiver, 'require', replacement);",
  "Reflect.set(module, 0, replacement);",
  "Reflect.set(module, -0, replacement);",
  "Reflect.set(module, true, replacement);",
  "Reflect.set(module, null, replacement);",
  "Reflect.set(module, undefined, replacement);",
  "Reflect.set(module, void 0, replacement);",
  "Reflect.set(module, 1n, replacement);",
  "const key=0; Reflect.set(module, key, replacement);",
  "Reflect.set(module, 'require', replacement, {});",
  "const receiver={}; Reflect.set(module, 'require', replacement, receiver);",
  "Reflect.set(module, 'require', replacement, null);",
  "Reflect.set(module, 'require', replacement, undefined);",
  "Reflect.set(module, 'require', replacement, -1);",
  "Reflect.set(module, 'require', replacement, +value);",
  "Reflect.set(module, 'require', replacement, !value);",
  "Reflect.set(module, 'require', replacement, ~value);",
  "Reflect.set(module, 'require', replacement, typeof value);",
  "Reflect.apply(Reflect.set, null, [module, 'require', replacement, {}]);",
  "const set=Reflect.set.bind(null, module, 'require', replacement); set({});",
  "let owner=module; owner={}; owner.require=replacement;",
])("preserves the wrapper loader across unrelated writes: %s", (write) => {
  const ir = analyzeJavaScriptSemantics(`${write}
    require('fs').readFileSync('kept');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each(["globalThis", "global", "self", "window"])(
  "recognizes an unchanged qualified process receiver: %s",
  (global) => {
    const ir = analyzeJavaScriptSemantics(`${global}.process.cwd();
      const proc=require('process'); const mode=proc.env.MODE;`);
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["MODE"]);
  },
);

it.each([
  "let fs=require('fs'); fs.readFileSync('kept'); fs={};",
  "let read=require('fs').readFileSync; read('kept'); read=custom;",
  "let proc=require('process'); const mode=proc.env.kept; proc={};",
  "const fs=require('fs'); fs.readFileSync('kept'); if(flag) { fs.readFileSync=custom; }",
  "const fs=require('fs'); if(flag) { fs.readFileSync('kept'); } fs.readFileSync=custom;",
  "const fs=require('fs'); { fs.readFileSync('kept'); } if(flag) { fs.readFileSync=custom; }",
])("retains a builtin read before a later effect: %s", (source) => {
  const ir = analyzeJavaScriptSemantics(source);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each([
  "const fs=require('fs'); if(flag) { fs.readFileSync=custom; } fs.readFileSync('wrong');",
  "const fs=require('fs'); function later() { fs.readFileSync('wrong'); } fs.readFileSync=custom;",
  "const fs=require('fs'); for(;;) { fs.readFileSync('wrong'); fs.readFileSync=custom; }",
  "const fs=require('fs'); class C { value=fs.readFileSync('wrong'); } fs.readFileSync=custom;",
])("keeps conditional and delayed writes conservative: %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
    [],
  );
});

it.each([
  "statSync",
  "readdirSync",
  "mkdirSync",
  "accessSync",
  "lstatSync",
  "realpathSync",
])("does not escape the namespace through native fs.%s", (method) => {
  const ir =
    analyzeJavaScriptSemantics(`const fs=require('fs'); fs.${method}('probe');
      fs.readFileSync('kept');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(["kept"]);
});

it.each(["stat", "readdir", "mkdir"])(
  "does not escape the namespace through native promises.%s",
  (method) => {
    const ir =
      analyzeJavaScriptSemantics(`const fs=require('fs/promises'); fs.${method}('probe');
      fs.open('kept');`);
    expect(ir.resourceOperations.map(({ method }) => method)).toEqual(["open"]);
  },
);

// Public filesystem functions outside the original synchronous subset.
// Constructors and private exports are deliberately not receiver guarantees.
it.each([
  "exists",
  "glob",
  "globSync",
  "mkdtempDisposableSync",
  "openAsBlob",
  "watch",
  "watchFile",
  "unwatchFile",
  "createReadStream",
  "createWriteStream",
])("retains native fs reads after public fs.%s calls", (method) => {
  for (const specifier of ["fs", "node:fs"]) {
    const ir = analyzeJavaScriptSemantics(`const fs=require('${specifier}');
      fs.${method}('probe'); fs.readFileSync('kept');`);
    expect(ir.configurationOperations.map(({ key }) => key)).toContain("kept");
    const replaced =
      analyzeJavaScriptSemantics(`const fs=require('${specifier}');
      fs.${method}=custom; fs.${method}('probe'); fs.readFileSync('wrong');`);
    expect(replaced.configurationOperations).toEqual([]);
  }
});

it.each(["glob", "mkdtempDisposable", "lchmod", "watch"])(
  "retains native promises reads after public promises.%s calls",
  (method) => {
    for (const imported of [
      "const fs=require('node:fs/promises');",
      "const fs=require('fs').promises;",
      "import * as fs from 'node:fs/promises';",
    ]) {
      const ir = analyzeJavaScriptSemantics(
        `${imported} fs.${method}('probe'); fs.open('kept');`,
      );
      expect(ir.resourceOperations.map(({ method }) => method)).toContain(
        "open",
      );
    }
  },
);

it.each([";", ","])(
  "orders repeated writes and reads with %s separators",
  (separator) => {
    const keys = Array.from({ length: 64 }, (_, i) => `kept-${i}`);
    const operations = keys.map(
      (key) => `fs=require('fs'),fs.readFileSync('${key}'),fs={}`,
    );
    const ir = analyzeJavaScriptSemantics(
      `let fs; ${operations.join(separator)};`,
    );
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual(keys);
  },
);

it.each([
  "let fs=require('fs'); fs=(fs.readFileSync('kept'),{}),fs.readFileSync('wrong');",
  "let fs; fs=require('fs'),fs={},fs.readFileSync('wrong');",
  "let fs=require('fs'); {fs={}; fs.readFileSync('wrong');}",
  "let fs=require('fs'); function later(){fs.readFileSync('wrong');} fs={};",
])("retains assignment completion and activation boundaries: %s", (source) => {
  expect(
    analyzeJavaScriptSemantics(source).configurationOperations.map(
      ({ key }) => key,
    ),
  ).toEqual(source.includes("'kept'") ? ["kept"] : []);
});

it("keeps a replaced native receiver uncertain", () => {
  const ir = analyzeJavaScriptSemantics(`const fs=require('fs');
    fs.statSync=custom; fs.statSync('probe'); fs.readFileSync('wrong');`);
  expect(ir.configurationOperations).toEqual([]);
});

it.each([
  "Reflect.set(fs, 'readFileSync', custom);",
  "Reflect.set(fs, key, custom);",
  "Reflect.set = custom; Reflect.set(fs, 'require', replacement);",
  "Object.defineProperty(fs, 'require', {set(value) {fs.readFileSync=custom;}}); Reflect.set(fs, 'require', replacement);",
  "Reflect.set.call=()=>{fs.readFileSync=custom}; Reflect.set.call(null, fs, 'require', replacement);",
  "Reflect.set.apply=()=>{fs.readFileSync=custom}; Reflect.set.apply(null, [fs, 'require', replacement]);",
  "const target={fs,set hook(value){this.fs.readFileSync=custom;}}; Reflect.set(target, 'hook', 1);",
  "const target={fs,set hook(value){this.fs.readFileSync=custom;}}; Reflect.set(target, key, 1);",
  "const target={set hook(value){this.fs.readFileSync=custom;}}; Reflect.set(target, 'hook', 1, {fs});",
])("keeps builtin mutations through Reflect.set conservative: %s", (write) => {
  expect(
    analyzeJavaScriptSemantics(
      `const fs=require('fs'); ${write} require('fs').readFileSync('wrong');`,
    ).configurationOperations,
  ).toEqual([]);
});

it.each(["process", "proc"])(
  "retains scalar process reads passed to calls: %s",
  (receiver) => {
    const ir = analyzeJavaScriptSemantics(`const proc=require('process');
    const port=Number(${receiver}.env.PORT); consume(${receiver}.argv[2]);`);
    expect(ir.configurationOperations.map(({ key }) => key)).toEqual([
      "PORT",
      "2",
    ]);
  },
);

it("tracks process writes through self-reassigned global aliases", () => {
  const ir =
    analyzeJavaScriptSemantics(`let host=globalThis; host=host.globalThis;
    host.process.env={}; const proc=require('process'); const value=proc.env.MODE;`);
  expect(ir.configurationOperations).toEqual([]);
});

it("retains each builtin read across repeated assignments and later writes", () => {
  const keys = Array.from({ length: 32 }, (_, index) => `kept-${index}`);
  const ir = analyzeJavaScriptSemantics(`let fs;
    ${keys.map((key) => `fs=require('fs'); fs.readFileSync('${key}'); fs={};`).join("\n")}
    fs=require('fs'); fs.readFileSync=custom; fs.readFileSync('wrong');`);
  expect(ir.configurationOperations.map(({ key }) => key)).toEqual(keys);
});

it.each([
  "import fs = require('fs'); fs={}; fs={}; fs.readFileSync('wrong');",
  "import fs = require('fs'); fs={},fs={}; fs.readFileSync('wrong');",
])("drops entry origins after definite replacement: %s", (source) => {
  expect(analyzeJavaScriptSemantics(source).configurationOperations).toEqual(
    [],
  );
});

it.each([
  "const fs=require('fs'); Reflect.set(fs,'readFileSync',custom,{}); fs.readFileSync('kept');",
  "const fs=require('fs'); const receiver={}; Reflect.set(fs,'readFileSync',custom,receiver); fs.readFileSync('kept');",
  "let fs=require('fs'); { fs.readFileSync('kept'); } fs={};",
  "let fs=require('fs'); { { fs.readFileSync('kept'); } } fs={};",
  "let fs=require('fs'); if(flag) { fs.readFileSync('kept'); } fs={};",
  "let fs; fs=require('fs'),fs.readFileSync('kept'); fs={};",
])(
  "retains ordered reads across receiver and statement boundaries: %s",
  (source) => {
    expect(
      analyzeJavaScriptSemantics(source).configurationOperations.map(
        ({ key }) => key,
      ),
    ).toEqual(["kept"]);
  },
);

it.each(["key", "'__proto__'"])(
  "retains uncertainty when a required argv object escapes through %s",
  (key) => {
    const ir = analyzeJavaScriptSemantics(`const proc=require('node:process');
      function run() { patch(proc.argv[${key}]); return proc.argv[3]; }`);
    expect(ir.configurationOperations.map(({ key }) => key)).not.toContain("3");
  },
);

it("retains a nested builtin read before receiver reassignment", () => {
  const ir = analyzeJavaScriptSemantics(`let fs=require('fs');
    fs.promises.open('kept'); fs={};`);
  expect(ir.resourceOperations.map(({ method }) => method)).toEqual(["open"]);
});

it("checks the parent promises slot for fresh require chains", () => {
  const ir =
    analyzeJavaScriptSemantics(`const fs=require('fs'); delete fs.promises;
    require('fs').promises.open('wrong');`);
  expect(ir.resourceOperations).toEqual([]);
});

it.each([
  "const tls=require('tls'); const net=require('net');",
  "const tls=require('node:tls'); const net=require('node:net');",
  "import * as tls from 'node:tls'; import * as net from 'node:net';",
])("distinguishes TLS and net acquisition methods: %s", (imports) => {
  const ir = analyzeJavaScriptSemantics(`${imports}
    tls.connect(443); tls.createConnection(443);
    net.connect(80); net.createConnection(80);`);
  expect(ir.resourceOperations.map(({ method }) => method)).toEqual([
    "connect",
    "connect",
    "createConnection",
  ]);
});

it.each(["spawnSync", "execSync", "execFileSync"])(
  "retains asynchronous child effects alongside native %s",
  (method) => {
    const ir = analyzeJavaScriptSemantics(`const cp=require('child_process');
      function asyncRun() { return cp.spawn('tool'); }
      function syncRun() { return cp.${method}('tool'); }`);
    expect(ir.childProcessSpawns.map(({ method }) => method)).toEqual([
      "spawn",
    ]);
  },
);
