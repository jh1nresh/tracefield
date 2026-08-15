import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "../src/scanner.mjs";

test("scanner resolves local TypeScript imports without executing source", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");
  const graph = await scanRepository(root);
  assert.equal(graph.meta.sourceFiles, 3);
  assert.deepEqual(graph.edges.map(({ source, target }) => ({ source, target })), [
    { source: "src/feature.ts", target: "src/core.ts" },
    { source: "tests/feature.test.ts", target: "src/feature.ts" },
  ]);
});
