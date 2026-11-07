import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("direct browser module entry has no Node-only loader dependency", async () => {
  const html = await readFile(new URL("../viewer/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../viewer/app.js", import.meta.url), "utf8");
  assert.match(html, /<script\b[^>]*type=["']module["'][^>]*src=["']\.\/app\.js["'][^>]*>/);
  const staticImports = [...app.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/g)];
  const dynamicImports = [...app.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)];
  const bareImports = [...staticImports, ...dynamicImports]
    .map((match) => match[1])
    .filter((specifier) => !/^(?:\.{1,2}\/|\/|https?:\/\/)/.test(specifier));
  assert.deepEqual(bareImports, [], "a browser entry cannot resolve Node or other bare package imports without an import map");
  assert.doesNotMatch(app, /\b(?:require|createRequire)\s*\(/);
});
