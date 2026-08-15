import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compareRefs } from "../src/compare.mjs";
import { writeReport } from "../src/report.mjs";

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("compare reports changed module consumers, edge delta, and static artifact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tracefield-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/core.ts"), "export const core = 'base';\n");
  await fs.writeFile(path.join(root, "src/a.ts"), "import { core } from './core';\nexport const a = core;\n");
  await fs.writeFile(path.join(root, "src/b.ts"), "import { core } from './core';\nexport const b = core;\n");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Tracefield Test");
  git(root, "config", "user.email", "tracefield@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  await fs.writeFile(path.join(root, "src/core.ts"), "export const core = 'head';\nexport const added = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "head");

  const graph = await compareRefs(root, base, "HEAD");
  const item = graph.review.queue[0];
  assert.equal(graph.review.summary.changedFiles, 1);
  assert.equal(item.file, "src/core.ts");
  assert.deepEqual(item.directDependents, ["src/a.ts", "src/b.ts"]);
  assert.equal(item.impacted.length, 2);
  assert.equal(graph.review.summary.missingNearbyTests, 1);

  const output = path.join(root, "report");
  await writeReport(graph, output);
  await fs.access(path.join(output, "index.html"));
  await fs.access(path.join(output, "data/graph.js"));
  assert.match(await fs.readFile(path.join(output, "summary.md"), "utf8"), /Blast radius: \*\*2 dependent modules\*\*/);
});
