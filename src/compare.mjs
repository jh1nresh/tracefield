import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanGitRef } from "./scanner.mjs";

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  return result.stdout;
}

function parseChanges(root, base, head) {
  const nameRows = runGit(root, ["diff", "--name-status", "--find-renames", `${base}...${head}`])
    .trim().split(/\r?\n/).filter(Boolean);
  const stats = new Map();
  for (const row of runGit(root, ["diff", "--numstat", `${base}...${head}`]).trim().split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, file] = row.split("\t");
    stats.set(file, { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) });
  }
  return nameRows.map((row) => {
    const [rawStatus, first, second] = row.split("\t");
    const file = second ?? first;
    return { status: rawStatus[0], file, previousFile: second ? first : undefined,
      ...(stats.get(file) ?? { additions: 0, deletions: 0 }) };
  });
}

function edgeKey(edge) { return `${edge.source}→${edge.target}`; }

function impactedNodes(start, nodesById, maxDepth = 4) {
  const visited = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    const depth = visited.get(current);
    if (depth >= maxDepth) continue;
    for (const consumer of nodesById.get(current)?.usedBy ?? []) {
      if (visited.has(consumer)) continue;
      visited.set(consumer, depth + 1);
      queue.push(consumer);
    }
  }
  visited.delete(start);
  return [...visited].map(([id, depth]) => ({ id, depth })).sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

function nearbyTests(node, graph) {
  const stem = path.basename(node.id).replace(/\.[^.]+$/, "").toLowerCase();
  return graph.nodes.filter((candidate) => candidate.kind === "test" && (
    candidate.imports.includes(node.id) || candidate.usedBy.includes(node.id) || candidate.label.toLowerCase().includes(stem)
  )).map((candidate) => candidate.id);
}

export async function compareRefs(root, baseRef, headRef = "HEAD") {
  const absoluteRoot = path.resolve(root);
  const base = runGit(absoluteRoot, ["rev-parse", baseRef]).trim();
  const head = runGit(absoluteRoot, ["rev-parse", headRef]).trim();
  const [baseGraph, headGraph] = await Promise.all([scanGitRef(absoluteRoot, base), scanGitRef(absoluteRoot, head)]);
  const changes = parseChanges(absoluteRoot, base, head);
  const baseNodes = new Map(baseGraph.nodes.map((node) => [node.id, node]));
  const headNodes = new Map(headGraph.nodes.map((node) => [node.id, node]));
  const baseEdges = new Map(baseGraph.edges.map((edge) => [edgeKey(edge), edge]));
  const headEdges = new Map(headGraph.edges.map((edge) => [edgeKey(edge), edge]));
  const addedEdges = [...headEdges].filter(([key]) => !baseEdges.has(key)).map(([, edge]) => edge);
  const removedEdges = [...baseEdges].filter(([key]) => !headEdges.has(key)).map(([, edge]) => edge);

  const reviewQueue = changes.map((change) => {
    const node = headNodes.get(change.file) ?? baseNodes.get(change.previousFile ?? change.file);
    if (!node) return { ...change, mapped: false, risk: "unmapped", directDependents: [], impacted: [], nearbyTests: [] };
    return { ...change, file: node.id, mapped: true, group: node.group, risk: node.risk,
      directDependents: node.usedBy, impacted: impactedNodes(node.id, headNodes), nearbyTests: nearbyTests(node, headGraph) };
  }).sort((a, b) => {
    const risk = { "sensitive path": 3, "externally exposed": 2, standard: 1, unmapped: 0 };
    return (risk[b.risk] ?? 0) - (risk[a.risk] ?? 0) || b.impacted.length - a.impacted.length || a.file.localeCompare(b.file);
  });
  const reviewByFile = new Map(reviewQueue.filter((item) => item.mapped).map((item) => [item.file, item]));
  const impactedIds = new Set(reviewQueue.flatMap((item) => item.impacted.map((entry) => entry.id)));
  for (const node of headGraph.nodes) {
    node.change = reviewByFile.get(node.id)?.status ?? null;
    node.review = reviewByFile.get(node.id) ?? null;
    node.impacted = impactedIds.has(node.id);
  }
  const changedMapped = reviewQueue.filter((item) => item.mapped);
  const impactedUnique = new Set(changedMapped.flatMap((item) => item.impacted.map((entry) => entry.id)));
  const summary = { changedFiles: changes.length, mappedModules: changedMapped.length,
    unmappedFiles: reviewQueue.filter((item) => !item.mapped).length, impactedModules: impactedUnique.size,
    addedEdges: addedEdges.length, removedEdges: removedEdges.length,
    highRiskChanges: changedMapped.filter((item) => item.risk !== "standard").length,
    missingNearbyTests: changedMapped.filter((item) => item.nearbyTests.length === 0).length,
    additions: changes.reduce((sum, item) => sum + (item.additions ?? 0), 0),
    deletions: changes.reduce((sum, item) => sum + (item.deletions ?? 0), 0) };
  const trace = [];
  let cursor = changedMapped[0]?.file;
  while (cursor && trace.length < 5) {
    trace.push(cursor);
    cursor = headNodes.get(cursor)?.imports.find((target) => !trace.includes(target));
  }
  headGraph.meta.mode = "compare";
  headGraph.meta.base = base.slice(0, 7);
  headGraph.meta.head = head.slice(0, 7);
  headGraph.meta.commit = head.slice(0, 7);
  headGraph.review = { summary, queue: reviewQueue, addedEdges, removedEdges };
  if (trace.length) headGraph.traces = [{ id: "changed", label: "Changed module dependency path", nodes: trace }];
  return headGraph;
}
