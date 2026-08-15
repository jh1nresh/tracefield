import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", ".venv", "artifacts", "build", "coverage",
  "dist", "node_modules", "public", "vendor", "__pycache__",
]);
const ROOT_CANDIDATES = [
  "app", "components", "lib", "packages", "src", "test", "tests",
  "web/app", "web/components", "web/lib",
];
const MAX_FILE_BYTES = 256 * 1024;

const toPosix = (value) => value.split(path.sep).join("/");

function runGit(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  return result.stdout;
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

function isSupportedPath(relative) {
  if (!SOURCE_EXTENSIONS.has(path.posix.extname(relative))) return false;
  if (relative.split("/").some((part) => EXCLUDED_DIRECTORIES.has(part))) return false;
  return ROOT_CANDIDATES.some((root) => relative === root || relative.startsWith(`${root}/`));
}

async function collectFiles(directory, root, seen, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute, root, seen, files);
      continue;
    }
    const relative = toPosix(path.relative(root, absolute));
    if (!entry.isFile() || !isSupportedPath(relative) || seen.has(relative)) continue;
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_FILE_BYTES) continue;
    seen.add(relative);
    files.push({ relative, source: await fs.readFile(absolute, "utf8") });
  }
}

function classifyGroup(relative) {
  const value = `/${relative}`;
  if (/\/app\/api\//.test(value)) return "API";
  if (/\/app\//.test(value)) return "ROUTES";
  if (/\/components\/landing\//.test(value)) return "LANDING";
  if (/\/components\//.test(value)) return "COMPONENTS";
  if (/\/lib\//.test(value)) return "LIBRARY";
  if (/^\/(?:test|tests)\//.test(value) || /\.(?:test|spec)\.[jt]sx?$/.test(relative)) return "TESTS";
  if (/^\/packages\//.test(value)) return "PACKAGES";
  if (/^\/src\/(?:pharmabox|runtime|workers?)\//.test(value)) return "RUNTIME";
  return "SOURCE";
}

function classifyKind(relative) {
  if (/\.(test|spec)\.[jt]sx?$/.test(relative) || /^(?:test|tests)\//.test(relative)) return "test";
  if (/\/route\.[jt]s$/.test(relative)) return "api-route";
  if (/\/page\.[jt]sx$/.test(relative)) return "page-route";
  if (/\/layout\.[jt]sx$/.test(relative)) return "layout";
  if (/\.[jt]sx$/.test(relative)) return "component";
  if (relative.endsWith(".py")) return "python";
  return "module";
}

function languageFor(relative) {
  if (relative.endsWith(".tsx")) return "TSX";
  if (relative.endsWith(".ts")) return "TypeScript";
  if (relative.endsWith(".jsx")) return "JSX";
  if (relative.endsWith(".py")) return "Python";
  return "JavaScript";
}

function cleanComment(value) {
  return value.replace(/^\s*\/\*\*?/, "").replace(/\*\/\s*$/, "")
    .replace(/^\s*(\/\/|#|\*)\s?/gm, "").replace(/\s+/g, " ").trim();
}

function derivePurpose(relative, source, kind) {
  const block = source.match(/\/\*\*[\s\S]{1,420}?\*\//)?.[0];
  const line = source.match(/^\s*(?:\/\/|#)\s+(.{8,220})$/m)?.[1];
  const documented = cleanComment(block ?? line ?? "");
  if (documented) return documented.slice(0, 240);
  const name = path.basename(relative).replace(/\.[^.]+$/, "");
  if (kind === "page-route") return `Renders the ${relative.replace(/\/page\.[jt]sx$/, "")} page route.`;
  if (kind === "api-route") return `Handles the ${relative.replace(/\/route\.[jt]s$/, "")} API route.`;
  if (kind === "component") return `Implements the ${name} interface component.`;
  if (kind === "test") return `Verifies behavior around ${name.replace(/[-_]/g, " ")}.`;
  if (kind === "python") return `Implements the ${name.replace(/_/g, " ")} runtime module.`;
  return `Provides the ${name.replace(/[-_]/g, " ")} module.`;
}

function extractSpecifiers(source, language) {
  const specifiers = new Set();
  if (language === "Python") {
    for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm)) specifiers.add(match[1]);
    for (const match of source.matchAll(/^\s*import\s+([\w.]+)/gm)) specifiers.add(match[1]);
    return [...specifiers];
  }
  const staticImport = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImport = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticImport)) specifiers.add(match[1]);
  for (const match of source.matchAll(dynamicImport)) specifiers.add(match[1]);
  return [...specifiers];
}

function extractExports(source, language) {
  const values = new Set();
  const pattern = language === "Python"
    ? /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm
    : /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(pattern)) values.add(match[1]);
  return [...values].slice(0, 16);
}

function redactLine(line) {
  return line.replace(
    /(api[_-]?key|secret|token|password|private[_-]?key)(\s*[:=]\s*)["'][^"']+["']/gi,
    "$1$2\"[redacted]\"",
  );
}

function snippetFor(source) {
  return source.split(/\r?\n/).slice(0, 18).map((line, index) => ({
    line: index + 1,
    text: redactLine(line).slice(0, 180),
  }));
}

function resolveCandidate(base, lookup) {
  const attempts = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
    `${base}.cjs`, `${base}.py`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/__init__.py`];
  return attempts.find((candidate) => lookup.has(candidate));
}

function resolveImport(node, specifier, lookup) {
  if (node.language === "Python") {
    if (specifier.startsWith(".")) {
      const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
      const suffix = specifier.slice(dots).replaceAll(".", "/");
      let directory = path.posix.dirname(node.id);
      for (let index = 1; index < dots; index += 1) directory = path.posix.dirname(directory);
      return resolveCandidate(path.posix.join(directory, suffix || "__init__"), lookup);
    }
    const pythonPath = specifier.replaceAll(".", "/");
    return resolveCandidate(`src/${pythonPath}`, lookup) ?? resolveCandidate(pythonPath, lookup)
      ?? [...lookup].find((candidate) => candidate.endsWith(`/${pythonPath}.py`));
  }
  if (specifier.startsWith("@/")) {
    const suffix = specifier.slice(2);
    return [suffix, `src/${suffix}`, `web/${suffix}`, `app/${suffix}`]
      .map((candidate) => resolveCandidate(candidate, lookup)).find(Boolean);
  }
  if (specifier.startsWith(".")) {
    return resolveCandidate(path.posix.normalize(path.posix.join(path.posix.dirname(node.id), specifier)), lookup);
  }
  return undefined;
}

function riskFor(node) {
  const value = node.id.toLowerCase();
  if (node.kind === "api-route") return "externally exposed";
  if (/(auth|payment|billing|reservation|supplier|security|admin|cron|migration)/.test(value)) return "sensitive path";
  return "standard";
}

function chooseTrace(nodes, edges) {
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.source)?.push(edge.target);
  const preferred = [...nodes].sort((a, b) => {
    const routeA = ["page-route", "api-route"].includes(a.kind) ? 1 : 0;
    const routeB = ["page-route", "api-route"].includes(b.kind) ? 1 : 0;
    return routeB - routeA || (outgoing.get(b.id)?.length ?? 0) - (outgoing.get(a.id)?.length ?? 0);
  })[0];
  if (!preferred) return [];
  const trace = [preferred.id];
  while (trace.length < 5) {
    const next = (outgoing.get(trace.at(-1)) ?? []).filter((target) => !trace.includes(target))
      .sort((a, b) => (outgoing.get(b)?.length ?? 0) - (outgoing.get(a)?.length ?? 0))[0];
    if (!next) break;
    trace.push(next);
  }
  return trace;
}

function repositoryLabel(root) {
  try { return runGit(root, ["config", "--get", "remote.origin.url"]).trim() || path.basename(root); }
  catch { return path.basename(root); }
}

function buildGraph(root, files, { commit, ref = "working-tree" } = {}) {
  const nodes = files.sort((a, b) => a.relative.localeCompare(b.relative)).map((file) => {
    const language = languageFor(file.relative);
    const kind = classifyKind(file.relative);
    return { id: file.relative, label: path.basename(file.relative), path: file.relative, language, kind,
      group: classifyGroup(file.relative), loc: file.source.split(/\r?\n/).length,
      purpose: derivePurpose(file.relative, file.source, kind), importsRaw: extractSpecifiers(file.source, language),
      exports: extractExports(file.source, language), snippet: snippetFor(file.source), risk: "standard", imports: [], usedBy: [] };
  });
  const lookup = new Set(nodes.map((node) => node.id));
  const edges = [];
  const seenEdges = new Set();
  for (const node of nodes) {
    node.risk = riskFor(node);
    for (const specifier of node.importsRaw) {
      const target = resolveImport(node, specifier, lookup);
      if (!target || target === node.id) continue;
      const key = `${node.id}→${target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ id: `edge-${edges.length}`, source: node.id, target, specifier });
      node.imports.push(target);
    }
    delete node.importsRaw;
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) nodeById.get(edge.target)?.usedBy.push(edge.source);
  const groups = {};
  for (const node of nodes) groups[node.group] = (groups[node.group] ?? 0) + 1;
  const trace = chooseTrace(nodes, edges);
  return { meta: { title: `${path.basename(root)} Tracefield`, repository: repositoryLabel(root), root,
    commit: commit?.slice(0, 7) ?? "unknown", ref, generatedAt: new Date().toISOString(), readOnly: true,
    sourceFiles: nodes.length, edgeCount: edges.length, groups }, nodes, edges,
    traces: trace.length ? [{ id: "primary", label: "Primary source flow", nodes: trace }] : [] };
}

export async function scanRepository(root) {
  const absoluteRoot = path.resolve(root);
  const files = [];
  const seen = new Set();
  for (const relative of ROOT_CANDIDATES) {
    const absolute = path.join(absoluteRoot, relative);
    if (await exists(absolute)) await collectFiles(absolute, absoluteRoot, seen, files);
  }
  if (!files.length) throw new Error(`No supported source files found in ${absoluteRoot}`);
  let commit = "unknown";
  try { commit = runGit(absoluteRoot, ["rev-parse", "HEAD"]).trim(); } catch { /* non-Git scan */ }
  return buildGraph(absoluteRoot, files, { commit });
}

export async function scanGitRef(root, ref) {
  const absoluteRoot = path.resolve(root);
  const resolved = runGit(absoluteRoot, ["rev-parse", ref]).trim();
  const paths = runGit(absoluteRoot, ["ls-tree", "-r", "--name-only", resolved]).split(/\r?\n/)
    .filter(Boolean).filter(isSupportedPath);
  const files = [];
  for (const relative of paths) {
    const source = runGit(absoluteRoot, ["show", `${resolved}:${relative}`]);
    if (Buffer.byteLength(source) <= MAX_FILE_BYTES) files.push({ relative, source });
  }
  if (!files.length) throw new Error(`No supported source files found at ${ref}`);
  return buildGraph(absoluteRoot, files, { commit: resolved, ref });
}
