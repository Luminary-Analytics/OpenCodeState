// Tier-0 change grouping (slice 2): deterministic, offline heuristics that
// split a session's net changes into logical change units. See RFC 0004.
//
// Pipeline: classify/normalize -> pairwise signals -> threshold clustering ->
// crude confidence -> ordered units. Signal weights are v1 constants chosen by
// eyeball, not calibration; the provider oracle (slice 3+) tunes them. When
// confidence is low the grouper emits ONE unit instead of guessing — low
// confidence is itself a judgment-interrupt, never a silent guess.
//
// This module is pure: all git access comes in through GroupAdapters.

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface Change {
  path: string;
  status: ChangeStatus;
  before_oid: string | null;
  after_oid: string | null;
  mode: string;
  renamed_from?: string;
}

export interface GroupAdapters {
  readBlob(path: string): string | null; // changed file's content (after side)
  changedLines(path: string): string[]; // normalized +/- diff lines vs baseline
  whitespaceOnly(path: string): boolean; // change is whitespace-only
}

export interface GroupInput {
  changes: Change[];
  checkpointWindows: string[][]; // changed paths per checkpoint window (temporal signal)
  historyCommits: string[][]; // file lists of recent commits (co-change signal)
  adapters: GroupAdapters;
}

export interface ProtoUnit {
  title: string;
  kind: string;
  paths: string[];
  notes: string[];
}

export interface GroupResult {
  units: ProtoUnit[];
  confidence: number;
  fallback: boolean;
  notes: string[];
}

// v1 signal weights. Edges at or above CLUSTER_THRESHOLD merge files into one unit.
const W_SAME_DIR = 1.0;
const W_SAME_DIR_ROOT = 0.3; // co-location at the repo root is weak evidence
const W_PREFIX_MAX = 0.8;
const W_IMPORT = 1.5;
const W_TEST_STEM = 1.5; // foo.test.ts <-> foo.ts
const W_COCHANGE_ONCE = 0.2; // a single historical co-occurrence is weak
const W_COCHANGE_STEP = 0.5;
const W_COCHANGE_CAP = 1.5;
const W_TEMPORAL = 0.5; // scaled by 2/|window|: big windows are weak evidence
const W_TEMPORAL_CAP = 1.0;
const W_DIFFSIM_STRONG = 2.0; // cross-cutting edits override path splits
const W_DIFFSIM_WEAK = 0.8;
const CLUSTER_THRESHOLD = 1.0;
const FALLBACK_CONFIDENCE = 0.5;
const MAX_SEMANTIC_NODES = 400;

const MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  "composer.json",
]);

const LOCK_TO_MANIFEST: Record<string, string> = {
  "package-lock.json": "package.json",
  "yarn.lock": "package.json",
  "pnpm-lock.yaml": "package.json",
  "bun.lockb": "package.json",
  "Cargo.lock": "Cargo.toml",
  "go.sum": "go.mod",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
  "Gemfile.lock": "Gemfile",
  "composer.lock": "composer.json",
};

const GENERATED_PATTERNS = [
  /^dist\//,
  /^build\//,
  /^out\//,
  /^vendor\//,
  /(^|\/)\.next\//,
  /\.min\.(js|css)$/,
  /\.snap$/,
  /(^|\/)__snapshots__\//,
  /(^|\/)generated(\/|\.)/i,
];

const KIND_ORDER: Record<string, number> = {
  deps: 0,
  reorg: 1,
  change: 2,
  tests: 3,
  reformat: 4,
  generated: 5,
  docs: 6,
};

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

function stem(p: string): string {
  let b = base(p);
  const i = b.lastIndexOf(".");
  if (i > 0) b = b.slice(0, i);
  return b.replace(/\.(test|spec)$/, "");
}

const isTest = (p: string): boolean =>
  /\.(test|spec)\.[^./]+$/.test(p) || /(^|\/)(__tests__|tests?)\//.test(p);
const isDoc = (p: string): boolean =>
  /\.(md|mdx|markdown|rst|adoc|txt)$/i.test(p) || /^docs?\//.test(p);
const isLock = (p: string): boolean => base(p) in LOCK_TO_MANIFEST;
const isGenerated = (p: string): boolean => GENERATED_PATTERNS.some((re) => re.test(p));

function commonDirDepth(a: string, b: string): number {
  const da = dirOf(a);
  const db = dirOf(b);
  if (da === "." || db === ".") return 0;
  const pa = da.split("/");
  const pb = db.split("/");
  let k = 0;
  while (k < pa.length && k < pb.length && pa[k] === pb[k]) k++;
  return k;
}

function resolveRel(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const baseParts = dirOf(fromFile) === "." ? [] : dirOf(fromFile).split("/");
  const out = [...baseParts];
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

function extractImports(content: string): string[] {
  const specs: string[] = [];
  const re = /(?:from\s+|import\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) specs.push(m[1]);
  return specs;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round2 = (x: number): number => Math.round(x * 100) / 100;

function kindOf(paths: string[], byPath: Map<string, Change>): string {
  const bs = paths.map(base);
  if (bs.every((b) => MANIFESTS.has(b) || b in LOCK_TO_MANIFEST)) return "deps";
  if (paths.every(isDoc)) return "docs";
  if (paths.every(isTest)) return "tests";
  const renamed = paths.filter((p) => byPath.get(p)?.status === "renamed").length;
  if (renamed > paths.length / 2) return "reorg";
  return "change";
}

function dominantDir(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(dirOf(p), (counts.get(dirOf(p)) ?? 0) + 1);
  let best = ".";
  let bn = -1;
  for (const [d, n] of [...counts.entries()].sort()) {
    if (n > bn) {
      best = d;
      bn = n;
    }
  }
  return best;
}

function titleOf(kind: string, paths: string[]): string {
  switch (kind) {
    case "deps":
      return "Dependency update";
    case "docs":
      return "Documentation";
    case "tests":
      return "Tests";
    case "reformat":
      return "Formatting";
    case "generated":
      return "Generated files";
    case "reorg":
      return "File reorganization";
    default: {
      const d = dominantDir(paths);
      return `Changes in ${d === "." ? "project root" : d}`;
    }
  }
}

export function groupChanges(input: GroupInput): GroupResult {
  const { changes, adapters } = input;
  const notes: string[] = [];
  const byPath = new Map(changes.map((c) => [c.path, c] as const));
  if (!changes.length) return { units: [], confidence: 1, fallback: false, notes };

  // -- classify / normalize pre-pass --
  const locks: string[] = [];
  const generated: string[] = [];
  const trivial: string[] = [];
  const semantic: string[] = [];
  for (const c of changes) {
    if (isLock(c.path)) locks.push(c.path);
    else if (isGenerated(c.path)) generated.push(c.path);
    else if (c.status === "modified" && adapters.whitespaceOnly(c.path)) trivial.push(c.path);
    else semantic.push(c.path);
  }
  semantic.sort();

  let clusters: string[][] = [];
  let confidence = 1;
  let fallback = false;

  if (semantic.length > MAX_SEMANTIC_NODES) {
    clusters = [semantic];
    confidence = 0.3;
    fallback = true;
    notes.push(
      `grouping capped: ${semantic.length} files exceeds the v1 limit of ${MAX_SEMANTIC_NODES}; emitted one unit`,
    );
  } else if (semantic.length) {
    const idxOf = new Map(semantic.map((p, i) => [p, i] as const));
    const W = new Map<string, number>();
    const key = (i: number, j: number): string => (i < j ? `${i}:${j}` : `${j}:${i}`);
    const add = (pa: string, pb: string, x: number): void => {
      const i = idxOf.get(pa);
      const j = idxOf.get(pb);
      if (i === undefined || j === undefined || i === j) return;
      W.set(key(i, j), (W.get(key(i, j)) ?? 0) + x);
    };

    // 1. path proximity (+ test-stem pairing)
    for (let i = 0; i < semantic.length; i++) {
      for (let j = i + 1; j < semantic.length; j++) {
        const a = semantic[i];
        const b = semantic[j];
        const da = dirOf(a);
        const db = dirOf(b);
        if (da === db) add(a, b, da === "." ? W_SAME_DIR_ROOT : W_SAME_DIR);
        else {
          const k = commonDirDepth(a, b);
          const max = Math.max(
            da === "." ? 0 : da.split("/").length,
            db === "." ? 0 : db.split("/").length,
          );
          if (k > 0 && max > 0) add(a, b, (k / max) * W_PREFIX_MAX);
        }
        if (stem(a) === stem(b) && isTest(a) !== isTest(b)) add(a, b, W_TEST_STEM);
      }
    }

    // 2. import edges (regex over changed ts/js content; in-engine, per RFC 0005)
    const importPairs = new Set<string>();
    for (const p of semantic) {
      if (!/\.[cm]?[jt]sx?$/.test(p)) continue;
      const content = adapters.readBlob(p);
      if (!content) continue;
      for (const spec of extractImports(content)) {
        const r = resolveRel(p, spec);
        if (!r) continue;
        for (const cand of [
          r,
          `${r}.ts`,
          `${r}.tsx`,
          `${r}.js`,
          `${r}.jsx`,
          `${r}.mjs`,
          `${r}.cjs`,
          `${r}/index.ts`,
          `${r}/index.js`,
        ]) {
          if (idxOf.has(cand) && cand !== p) {
            importPairs.add(key(idxOf.get(p)!, idxOf.get(cand)!));
            break;
          }
        }
      }
    }
    for (const k of importPairs) W.set(k, (W.get(k) ?? 0) + W_IMPORT);

    // 3. historical co-change
    const coCount = new Map<string, number>();
    for (const commit of input.historyCommits) {
      const present = commit.filter((p) => idxOf.has(p));
      for (let i = 0; i < present.length; i++)
        for (let j = i + 1; j < present.length; j++) {
          const k = key(idxOf.get(present[i])!, idxOf.get(present[j])!);
          coCount.set(k, (coCount.get(k) ?? 0) + 1);
        }
    }
    for (const [k, n] of coCount) {
      const w = n === 1 ? W_COCHANGE_ONCE : Math.min(n * W_COCHANGE_STEP, W_COCHANGE_CAP);
      W.set(k, (W.get(k) ?? 0) + w);
    }

    // 4. temporal co-occurrence (down-weighted for large windows)
    const tempo = new Map<string, number>();
    for (const win of input.checkpointWindows) {
      const present = [...new Set(win)].filter((p) => idxOf.has(p));
      if (present.length < 2) continue;
      const w = W_TEMPORAL * Math.min(1, 2 / present.length);
      for (let i = 0; i < present.length; i++)
        for (let j = i + 1; j < present.length; j++) {
          const k = key(idxOf.get(present[i])!, idxOf.get(present[j])!);
          tempo.set(k, Math.min((tempo.get(k) ?? 0) + w, W_TEMPORAL_CAP));
        }
    }
    for (const [k, w] of tempo) W.set(k, (W.get(k) ?? 0) + w);

    // 5. diff-similarity (cross-cutting edits override path splits)
    const lineSets = new Map<string, Set<string>>();
    for (const p of semantic) lineSets.set(p, new Set(adapters.changedLines(p)));
    for (let i = 0; i < semantic.length; i++)
      for (let j = i + 1; j < semantic.length; j++) {
        const A = lineSets.get(semantic[i])!;
        const B = lineSets.get(semantic[j])!;
        if (A.size < 2 || B.size < 2) continue;
        let inter = 0;
        for (const l of A) if (B.has(l)) inter++;
        const jac = inter / (A.size + B.size - inter);
        if (jac >= 0.5) add(semantic[i], semantic[j], W_DIFFSIM_STRONG);
        else if (jac >= 0.3) add(semantic[i], semantic[j], W_DIFFSIM_WEAK);
      }

    // cluster: connected components over edges >= threshold
    const parent = semantic.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [k, w] of W) {
      if (w >= CLUSTER_THRESHOLD) {
        const [i, j] = k.split(":").map(Number);
        parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, string[]>();
    semantic.forEach((p, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(p);
    });
    clusters = [...groups.values()].map((g) => g.sort());
    clusters.sort((a, b) => (a[0] < b[0] ? -1 : 1));

    // crude confidence: separation (how far inter-cluster edges sit below the
    // threshold) + cohesion of multi-file clusters. v1 formula, oracle later.
    let interMax = 0;
    const intra = new Map<number, { sum: number; n: number }>();
    for (const [k, w] of W) {
      const [i, j] = k.split(":").map(Number);
      if (find(i) === find(j)) {
        const e = intra.get(find(i)) ?? { sum: 0, n: 0 };
        e.sum += w;
        e.n++;
        intra.set(find(i), e);
      } else interMax = Math.max(interMax, w);
    }
    const multi = clusters.filter((c) => c.length > 1);
    let cohes = 0.6; // neutral when everything is a singleton
    if (multi.length) {
      let acc = 0;
      for (const c of multi) {
        const e = intra.get(find(idxOf.get(c[0])!));
        acc += e && e.n ? Math.min(e.sum / e.n / 2, 1) : 0;
      }
      cohes = acc / multi.length;
    }
    const sep = clamp01(1 - interMax / CLUSTER_THRESHOLD);
    confidence = round2(clamp01(0.35 + 0.45 * sep + 0.2 * cohes));
    if (clusters.length > 1 && confidence < FALLBACK_CONFIDENCE) {
      clusters = [semantic];
      fallback = true;
      notes.push("low grouping confidence — emitted a single unit instead of guessing");
    }
  }

  // -- assemble units: dependent files attach to their cause --
  interface U {
    paths: string[];
    forced?: string;
    unotes: string[];
  }
  const units: U[] = clusters.map((ps) => ({ paths: [...ps], unotes: [] }));

  const orphanLocks: string[] = [];
  for (const lp of locks.sort()) {
    const manifest = LOCK_TO_MANIFEST[base(lp)];
    const home =
      units.find((u) => u.paths.some((p) => base(p) === manifest && dirOf(p) === dirOf(lp))) ??
      units.find((u) => u.paths.some((p) => base(p) === manifest));
    if (home) {
      home.paths.push(lp);
      home.unotes.push(`${lp} attached to its manifest's unit`);
    } else orphanLocks.push(lp);
  }
  if (orphanLocks.length)
    units.push({ paths: orphanLocks, forced: "deps", unotes: ["lockfile changed without its manifest"] });

  for (const gp of generated.sort()) {
    let best: U | null = null;
    let bestDepth = 0;
    for (const u of units)
      for (const p of u.paths) {
        const d = commonDirDepth(gp, p);
        if (d > bestDepth) {
          bestDepth = d;
          best = u;
        }
      }
    if (best) {
      best.paths.push(gp);
      best.unotes.push(`${gp} attached as generated output`);
    } else {
      const g = units.find((u) => u.forced === "generated");
      if (g) g.paths.push(gp);
      else units.push({ paths: [gp], forced: "generated", unotes: [] });
    }
  }

  if (trivial.length)
    units.push({ paths: [...trivial].sort(), forced: "reformat", unotes: ["whitespace-only changes"] });

  const protos: ProtoUnit[] = units
    .filter((u) => u.paths.length)
    .map((u) => {
      u.paths.sort();
      const kind = u.forced ?? kindOf(u.paths, byPath);
      return { title: titleOf(kind, u.paths), kind, paths: u.paths, notes: u.unotes };
    });
  protos.sort(
    (a, b) =>
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
      (a.paths[0] < b.paths[0] ? -1 : 1),
  );
  return { units: protos, confidence, fallback, notes };
}
