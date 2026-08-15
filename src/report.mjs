import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const viewerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../viewer");

function cell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function summaryMarkdown(graph) {
  const review = graph.review;
  if (!review) return `# Tracefield code map\n\n- Commit: \`${graph.meta.commit}\`\n- Source files: ${graph.meta.sourceFiles}\n- Internal edges: ${graph.meta.edgeCount}\n`;
  const { summary } = review;
  const lines = [
    "# Tracefield PR impact", "",
    `- Base -> head: \`${graph.meta.base}\` -> \`${graph.meta.head}\``,
    `- Changed: **${summary.changedFiles} files** (+${summary.additions} / -${summary.deletions})`,
    `- Blast radius: **${summary.impactedModules} dependent modules**`,
    `- Dependency edges: **+${summary.addedEdges} / -${summary.removedEdges}**`,
    `- Review flags: **${summary.highRiskChanges} high-risk**, **${summary.missingNearbyTests} without nearby tests**`, "",
    "| File | Change | Risk | Direct dependents | Blast radius | Nearby tests |",
    "|---|---:|---|---:|---:|---:|",
  ];
  for (const item of review.queue) lines.push(`| ${cell(item.file)} | ${cell(item.status)} | ${cell(item.risk)} | ${item.directDependents.length} | ${item.impacted.length} | ${item.nearbyTests.length} |`);
  lines.push("", "> Static import evidence only. Tracefield does not execute repository code or claim runtime coverage.", "");
  return lines.join("\n");
}

export async function writeReport(graph, output) {
  const absolute = path.resolve(output);
  await fs.mkdir(absolute, { recursive: true });
  await fs.cp(viewerRoot, absolute, { recursive: true });
  await fs.mkdir(path.join(absolute, "data"), { recursive: true });
  const json = JSON.stringify(graph, null, 2);
  await fs.writeFile(path.join(absolute, "data/graph.json"), `${json}\n`, "utf8");
  await fs.writeFile(path.join(absolute, "data/graph.js"), `globalThis.TRACEFIELD_GRAPH = ${json.replaceAll("<", "\\u003c")};\n`, "utf8");
  await fs.writeFile(path.join(absolute, "summary.md"), summaryMarkdown(graph), "utf8");
  return absolute;
}
