# Tracefield

Tracefield turns a Git diff into a read-only code map and PR impact receipt. It never installs or executes the target repository.

## What a reviewer sees

- changed source modules and non-graph files
- direct consumers and transitive blast radius
- added and removed internal dependency edges
- externally exposed or sensitive-path changes
- nearby-test presence, with explicit gaps
- source path, purpose, imports, consumers, and bounded source evidence

## Local review

```bash
node src/cli.mjs compare --repo /path/to/repo --base origin/main --head HEAD --output tracefield-report
node src/cli.mjs serve --report tracefield-report --port 4173
```

Open `http://127.0.0.1:4173`. The report folder is also a static artifact; `data/graph.js` lets it open without a backend.

## GitHub Actions

```yaml
- uses: jh1nresh/tracefield@v1
  with:
    base-ref: ${{ github.event.pull_request.base.sha }}
```

The action writes the five review signals to the GitHub Step Summary and uploads the full report. It requires only `contents: read` and does not comment on or mutate the PR.

## Boundary

P1 resolves static TypeScript/JavaScript and Python imports under common source roots. It is not runtime telemetry, a security scanner, or a substitute for tests and normal diffs.
