import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8" };

export function startServer(reportRoot, port = 4173) {
  const root = path.resolve(reportRoot);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/status") {
        const graph = JSON.parse(await fs.readFile(path.join(root, "data/graph.json"), "utf8"));
        const current = spawnSync("git", ["-C", graph.meta.root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim();
        response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ scanned: graph.meta.commit, current, stale: Boolean(current && current !== graph.meta.commit) }));
        return;
      }
      const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const absolute = path.resolve(root, `.${requested}`);
      if (!absolute.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end("Forbidden"); return; }
      const data = await fs.readFile(absolute);
      response.writeHead(200, { "cache-control": "no-store", "content-type": types[path.extname(absolute)] ?? "application/octet-stream", "x-content-type-options": "nosniff" });
      response.end(data);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${port}` }));
  });
}
