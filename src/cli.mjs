#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { scanRepository } from "./scanner.mjs";
import { compareRefs } from "./compare.mjs";
import { writeReport } from "./report.mjs";
import { startServer } from "./server.mjs";

function parseArgs(values) {
  const options = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { options._.push(value); continue; }
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

function usage() {
  return "Tracefield\n\nCommands:\n  scan --repo <path> --output <dir>\n  compare --repo <path> --base <ref> [--head <ref>] --output <dir>\n  serve --report <dir> [--port 4173]\n";
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = parseArgs(rest);
  if (!command || command === "help" || options.help) { console.log(usage()); return; }
  if (command === "scan") {
    const graph = await scanRepository(path.resolve(options.repo ?? "."));
    const output = await writeReport(graph, options.output ?? "tracefield-report");
    console.log(`Tracefield: ${graph.meta.sourceFiles} files, ${graph.meta.edgeCount} edges -> ${output}`);
    return;
  }
  if (command === "compare") {
    if (!options.base) throw new Error("compare requires --base <git-ref>");
    const graph = await compareRefs(path.resolve(options.repo ?? "."), options.base, options.head ?? "HEAD");
    const output = await writeReport(graph, options.output ?? "tracefield-report");
    console.log(`Tracefield: ${graph.review.summary.changedFiles} changed, ${graph.review.summary.impactedModules} impacted -> ${output}`);
    return;
  }
  if (command === "serve") {
    const { url } = await startServer(path.resolve(options.report ?? "tracefield-report"), Number(options.port ?? 4173));
    console.log(`Tracefield: ${url}`);
    return new Promise(() => {});
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
