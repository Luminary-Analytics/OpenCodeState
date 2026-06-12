#!/usr/bin/env -S node
// OpenCodeState v1 (slice 1) — daemonless walking skeleton.
//
// Single-file TypeScript, run directly by Node's type stripping (Node >= 23.6):
//     node src/ocs.ts <command>
// Storage reuses the repo's git object database via plumbing commands; OCS refs
// live under refs/ocs/*; session/package metadata lives in .ocs/state.json.
// See ../README.md, ../../rfcs/0003-mvp.md, and ../../specs/ocs-storage.md.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as readline from "node:readline/promises";

import { groupChanges, type Change } from "./grouping.ts";
import { fallowProvider } from "./fallow.ts";
import type { ProviderResult, Severity, ValidationRecord } from "./provider.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { scanAddedLines, type SecretFinding } from "./secrets.ts";
import { OCS_VERSION } from "./version.ts";

type Trigger = "explicit" | "command" | "save" | "agent" | "pre-restore";

interface Checkpoint {
  n: number;
  ref: string;
  commit: string;
  tree: string;
  trigger: Trigger;
  actor: string;
  label: string | null;
  time: string;
}

interface Session {
  id: string;
  intent: string | null;
  state: "active" | "packaged" | "abandoned";
  startTime: string;
  finishTime: string | null;
  headAtStart: string | null;
  baselineTree: string;
  baselineCommit: string;
  baselineRef: string;
  checkpoints: Checkpoint[];
  finishTree: string | null;
  packages: string[];
}

interface State {
  version: number;
  activeSession: string | null;
  sessions: Record<string, Session>;
  packages: Record<string, unknown>;
}

// ---------- git plumbing ----------
let REPO_ROOT = "";

function git(args: string[], index?: string): string {
  const env = { ...process.env } as Record<string, string>;
  if (index) env.GIT_INDEX_FILE = index;
  return execFileSync("git", args, {
    cwd: REPO_ROOT || process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
  }).trimEnd();
}

function tryGit(args: string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// ---------- paths & state ----------
const ocsDir = (): string => path.join(REPO_ROOT, ".ocs");
const statePath = (): string => path.join(ocsDir(), "state.json");

function loadState(): State {
  if (!fs.existsSync(statePath())) {
    throw new Error("not an OpenCodeState workspace — run `ocs init` first");
  }
  return JSON.parse(fs.readFileSync(statePath(), "utf8")) as State;
}

function saveState(s: State): void {
  fs.writeFileSync(statePath(), JSON.stringify(s, null, 2) + "\n");
}

function id(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

const nowISO = (): string => new Date().toISOString();

// ---------- snapshots ----------
// Stage the whole working tree (honoring .gitignore) into a THROWAWAY index so
// the user's real index is never touched, then write it as a tree object.
// .ocs is excluded so OCS metadata never enters a snapshot.
function snapshotWorkingTree(): string {
  const idx = path.join(ocsDir(), "tmp-index");
  fs.rmSync(idx, { force: true });
  // .ocs is gitignored by `ocs init`, so `add -A` naturally skips OCS metadata.
  git(["add", "-A"], idx);
  const tree = git(["write-tree"], idx);
  fs.rmSync(idx, { force: true });
  return tree;
}

function mkCommit(tree: string, parent: string | null, message: string): string {
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", message);
  return git(args);
}

function lsTree(tree: string): string[] {
  const out = tryGit(["ls-tree", "-r", "--name-only", tree]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function isZero(sha: string): boolean {
  return /^0+$/.test(sha);
}

// Net change between two trees, parsed from `git diff --raw` (rename-aware).
function diffTrees(a: string, b: string): Change[] {
  const out = tryGit(["diff", "--raw", "--no-abbrev", "-M", a, b]);
  if (!out) return [];
  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith(":")) continue;
    const parts = line.split("\t");
    const f = parts[0].replace(/^:/, "").split(/\s+/); // srcMode dstMode srcSha dstSha STATUS
    const st = f[4][0];
    const mode = f[1] === "000000" ? f[0] : f[1];
    const before = isZero(f[2]) ? null : f[2];
    const after = isZero(f[3]) ? null : f[3];
    if (st === "R") {
      changes.push({ path: parts[2], status: "renamed", renamed_from: parts[1], before_oid: before, after_oid: after, mode });
    } else if (st === "C") {
      changes.push({ path: parts[2], status: "added", before_oid: null, after_oid: after, mode });
    } else {
      changes.push({
        path: parts[1],
        status: st === "A" ? "added" : st === "D" ? "deleted" : "modified",
        before_oid: before,
        after_oid: after,
        mode,
      });
    }
  }
  return changes;
}

// File lists of recent commits, for the historical co-change signal.
function readHistoryCommits(): string[][] {
  const raw = tryGit(["log", "-n", "200", "--name-only", "--format=%x00%H"]);
  if (!raw) return [];
  return raw
    .split("\0")
    .map((block) => block.split("\n").slice(1).map((l) => l.trim()).filter(Boolean))
    .filter((files) => files.length > 0);
}

// ADDED lines of one file between two trees, with new-file line numbers
// (for the secret scanner). Parses unified-diff hunk headers.
function addedLinesFor(a: string, b: string, p: string): { lines: { line: number; text: string }[]; truncated: boolean } {
  const out = tryGit(["diff", a, b, "--", p]);
  if (!out) return { lines: [], truncated: false };
  const lines: { line: number; text: string }[] = [];
  let newLine = 0;
  for (const l of out.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      newLine = parseInt(h[1], 10);
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("\\")) continue;
    if (l.startsWith("+")) {
      lines.push({ line: newLine, text: l.slice(1) });
      newLine++;
      if (lines.length >= 5000) return { lines, truncated: true };
    } else if (!l.startsWith("-")) {
      newLine++;
    }
  }
  return { lines, truncated: false };
}

// Normalized changed lines of one file between two trees (diff-similarity signal).
function changedLinesFor(a: string, b: string, p: string): string[] {
  const out = tryGit(["diff", a, b, "--", p]);
  if (!out) return [];
  const lines: string[] = [];
  for (const l of out.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l[0] === "+" || l[0] === "-") {
      const t = l.slice(1).trim();
      if (t) lines.push(t);
      if (lines.length >= 500) break;
    }
  }
  return lines;
}

// ---------- session helpers ----------
function requireActive(s: State): Session {
  if (!s.activeSession || !s.sessions[s.activeSession]) {
    throw new Error("no active session — run `ocs start`");
  }
  return s.sessions[s.activeSession];
}

function makeCheckpoint(sess: Session, trigger: Trigger, actor: string, label: string | null): Checkpoint {
  const tree = snapshotWorkingTree();
  const parent = sess.checkpoints.length
    ? sess.checkpoints[sess.checkpoints.length - 1].commit
    : sess.baselineCommit;
  const n = sess.checkpoints.length + 1;
  const ref = `refs/ocs/checkpoints/${sess.id}/${n}`;
  const commit = mkCommit(tree, parent, `ocs checkpoint ${n} (${trigger})`);
  git(["update-ref", ref, commit]);
  const cp: Checkpoint = { n, ref, commit, tree, trigger, actor, label, time: nowISO() };
  sess.checkpoints.push(cp);
  return cp;
}

const short = (sha: string): string => sha.slice(0, 8);

// ---------- commands ----------
function cmdInit(): void {
  const top = tryGit(["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error("not inside a git repository — run `git init` first");
  REPO_ROOT = top;
  fs.mkdirSync(path.join(ocsDir(), "packages"), { recursive: true });
  // Keep .ocs out of the user's normal git view.
  const gi = path.join(REPO_ROOT, ".gitignore");
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (!cur.split("\n").some((l) => l.trim() === ".ocs/" || l.trim() === ".ocs")) {
    fs.writeFileSync(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + ".ocs/\n");
  }
  if (!fs.existsSync(statePath())) {
    saveState({ version: 1, activeSession: null, sessions: {}, packages: {} });
  }
  const configPath = path.join(ocsDir(), "config.json");
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }
  console.log("Initialized OpenCodeState workspace in .ocs/ (policy: .ocs/config.json)");
}

function cmdStart(intent: string | null): void {
  const s = loadState();
  if (s.activeSession) {
    throw new Error(`session ${s.activeSession} already active — run \`ocs finish\` first`);
  }
  const sid = id("ses");
  const head = tryGit(["rev-parse", "HEAD"]);
  const tree = snapshotWorkingTree();
  const baselineRef = `refs/ocs/baseline/${sid}`;
  const baselineCommit = mkCommit(tree, head, `ocs baseline for ${sid}`);
  git(["update-ref", baselineRef, baselineCommit]);
  s.sessions[sid] = {
    id: sid,
    intent,
    state: "active",
    startTime: nowISO(),
    finishTime: null,
    headAtStart: head,
    baselineTree: tree,
    baselineCommit,
    baselineRef,
    checkpoints: [],
    finishTree: null,
    packages: [],
  };
  s.activeSession = sid;
  saveState(s);
  console.log(`Started session ${sid}${intent ? ` — "${intent}"` : ""}`);
}

function cmdCheckpoint(label: string | null, actor: string): void {
  const s = loadState();
  const sess = requireActive(s);
  const cp = makeCheckpoint(sess, actor.startsWith("ai:") ? "agent" : "explicit", actor, label);
  saveState(s);
  console.log(`Checkpoint #${cp.n} (${short(cp.commit)})${label ? ` — ${label}` : ""} by ${actor}`);
}

function cmdStatus(): void {
  const s = loadState();
  if (!s.activeSession) {
    console.log("No active session.");
    return;
  }
  const sess = requireActive(s);
  const changes = diffTrees(sess.baselineTree, snapshotWorkingTree());
  console.log(`Session ${sess.id} [${sess.state}]${sess.intent ? ` — "${sess.intent}"` : ""}`);
  console.log(`  started:     ${sess.startTime}`);
  console.log(`  checkpoints: ${sess.checkpoints.length}`);
  console.log(`  changed:     ${changes.length} file(s) since baseline`);
  for (const c of changes) console.log(`    ${c.status[0].toUpperCase()}  ${c.path}`);
}

function cmdLog(): void {
  const s = loadState();
  const sess = requireActive(s);
  console.log(`Session ${sess.id} — ${sess.checkpoints.length} checkpoint(s)`);
  for (const c of sess.checkpoints) {
    console.log(
      `  #${c.n}  ${short(c.commit)}  ${c.time}  ${c.trigger}  ${c.actor}` +
        (c.label ? `  "${c.label}"` : ""),
    );
  }
}

function cmdRestore(which: string): void {
  const s = loadState();
  const sess = requireActive(s);
  const cp = sess.checkpoints.find((c) => String(c.n) === which || c.commit.startsWith(which));
  if (!cp) throw new Error(`no checkpoint matching "${which}"`);
  // Safety: snapshot current state first, so restore is never destructive.
  makeCheckpoint(sess, "pre-restore", "human", `pre-restore to #${cp.n}`);
  const current = snapshotWorkingTree();
  const idx = path.join(ocsDir(), "tmp-index");
  fs.rmSync(idx, { force: true });
  git(["read-tree", cp.tree], idx);
  git(["checkout-index", "-a", "-f"], idx); // overwrites modified, recreates deleted
  fs.rmSync(idx, { force: true });
  // Remove files that exist now but not in the target tree.
  const target = new Set(lsTree(cp.tree));
  for (const f of lsTree(current)) {
    if (!target.has(f)) fs.rmSync(path.join(REPO_ROOT, f), { force: true });
  }
  saveState(s);
  console.log(`Restored working tree to checkpoint #${cp.n} (${short(cp.commit)}). Prior state saved as a checkpoint.`);
}

async function cmdFinish(dryRun: boolean, yes: boolean): Promise<void> {
  const s = loadState();
  const sess = requireActive(s);
  const finishTree = snapshotWorkingTree();
  let changes = diffTrees(sess.baselineTree, finishTree);
  const notes: string[] = [];

  // If HEAD moved during the session (pull, merge, or the user's own commits),
  // drop changes whose resulting blob matches what those commits introduced:
  // they are recorded in git history, not this session's packaged work.
  const headNow = tryGit(["rev-parse", "HEAD"]);
  if (sess.headAtStart && headNow && headNow !== sess.headAtStart) {
    const startTree = git(["rev-parse", `${sess.headAtStart}^{tree}`]);
    const nowTree = git(["rev-parse", `${headNow}^{tree}`]);
    const upstream = new Map(diffTrees(startTree, nowTree).map((c) => [c.path, c.after_oid ?? "deleted"]));
    const before = changes.length;
    changes = changes.filter((c) => upstream.get(c.path) !== (c.after_oid ?? "deleted"));
    if (changes.length < before)
      notes.push(`subtracted ${before - changes.length} change(s) matching commits made during the session`);
  }

  const byPath = new Map(changes.map((c) => [c.path, c] as const));
  // Window i spans trees[i-1] -> trees[i] and belongs to the actor who fired
  // checkpoint i; the final window (last checkpoint -> finish) belongs to
  // whoever runs finish (human in v1). Trees telescope from baseline to finish,
  // so every net-changed path appears in at least one window, and a path
  // touched by several actors honestly carries all of them. Only actor + paths
  // are recorded — no prompts, no transcripts (provenance is not surveillance).
  const trees = [sess.baselineTree, ...sess.checkpoints.map((c) => c.tree), finishTree];
  const windowActors = [...sess.checkpoints.map((c) => c.actor), "human"];
  const windows: string[][] = [];
  const pathActors = new Map<string, Set<string>>();
  for (let i = 1; i < trees.length; i++) {
    if (trees[i] === trees[i - 1]) continue;
    const w = diffTrees(trees[i - 1], trees[i]).map((c) => c.path).filter((p) => byPath.has(p));
    if (!w.length) continue;
    windows.push(w);
    for (const p of w) {
      if (!pathActors.has(p)) pathActors.set(p, new Set());
      pathActors.get(p)!.add(windowActors[i - 1]);
    }
  }

  const result = groupChanges({
    changes,
    checkpointWindows: windows,
    historyCommits: readHistoryCommits(),
    adapters: {
      readBlob: (p) => {
        const c = byPath.get(p);
        const oid = c?.after_oid ?? c?.before_oid;
        return oid ? tryGit(["cat-file", "blob", oid]) : null;
      },
      changedLines: (p) => changedLinesFor(sess.baselineTree, finishTree, p),
      whitespaceOnly: (p) => tryGit(["diff", "-w", sess.baselineTree, finishTree, "--", p]) === "",
    },
  });
  notes.push(...result.notes);

  const cfg = loadConfig(path.join(ocsDir(), "config.json"));

  // Secret scan over the session's ADDED lines (policy.secret_scan). Local and
  // cheap, so it runs even in dry-run. Findings are redacted before they touch
  // any output. Secrets in added lines are introduced-by-definition.
  const secretFindings: SecretFinding[] = [];
  if (cfg.policy.secret_scan && changes.length) {
    const allow: RegExp[] = [];
    for (const pat of cfg.policy.secret_allow_patterns) {
      try {
        allow.push(new RegExp(pat));
      } catch {
        notes.push(`ignoring invalid secret_allow_pattern: ${pat}`);
      }
    }
    for (const c of changes) {
      if (c.status === "deleted") continue;
      const { lines, truncated } = addedLinesFor(sess.baselineTree, finishTree, c.path);
      if (truncated) notes.push(`secret scan truncated at 5000 added lines for ${c.path}`);
      secretFindings.push(...scanAddedLines(c.path, lines, allow));
    }
  }
  const secretErrors = secretFindings.filter((f) => f.severity === "error").length;
  const secretRecord: ValidationRecord | null =
    cfg.policy.secret_scan && changes.length
      ? {
          type: "secret-scan",
          format: "ocs",
          status: secretFindings.length ? "issues" : "passed",
          rule_counts: secretFindings.reduce<Record<string, number>>((acc, f) => {
            acc[`ocs/${f.rule}`] = (acc[`ocs/${f.rule}`] ?? 0) + 1;
            return acc;
          }, {}),
          results: secretFindings.map((f) => ({
            rule_id: `ocs/${f.rule}`,
            level: f.severity === "warn" ? "warning" : "error",
            path: f.path,
            line: f.line,
            message: f.redacted,
          })),
          provenance: {
            provider_id: "ocs-secret-scan",
            provider_version: OCS_VERSION,
            analyzed_oid: finishTree,
            scope: "added-lines",
            timestamp: nowISO(),
          },
        }
      : null;

  // Codebase-intelligence provider (RFC 0005): runs only at finish, only on a
  // real (non-dry) run, and only when the provider speaks this repo's language.
  // Absence is normal — the package then carries no analysis evidence.
  const providerName = process.env.OCS_PROVIDER ?? cfg.provider;
  const provider = providerName === "none" ? null : fallowProvider;
  let prov: ProviderResult | null = null;
  if (changes.length && provider && provider.appliesTo(changes.map((c) => c.path))) {
    if (dryRun) {
      notes.push(`${provider.id} analysis skipped in dry-run (runs on real finish)`);
    } else {
      prov = provider.analyze({ repoRoot: REPO_ROOT, baselineRef: sess.baselineCommit, analyzedOid: finishTree });
      notes.push(...prov.notes);
    }
  } else if (changes.length && provider) {
    notes.push(`no ${provider.id} evidence: no ts/js files in this session's changes`);
  } else if (changes.length) {
    notes.push("provider disabled — package carries no analysis evidence");
  }

  // Per-unit risk = max severity of provider findings touching the unit's paths.
  const sevRank: Record<Severity, number> = { note: 0, warn: 1, error: 2 };
  const pathSev = new Map<string, Severity>();
  for (const v of prov?.validation ?? [])
    for (const r of v.results) {
      if (!r.path) continue;
      const lvl: Severity = r.level === "error" ? "error" : r.level === "warning" ? "warn" : "note";
      const cur = pathSev.get(r.path);
      if (!cur || sevRank[lvl] > sevRank[cur]) pathSev.set(r.path, lvl);
    }
  for (const f of secretFindings) {
    const cur = pathSev.get(f.path);
    if (!cur || sevRank[f.severity] > sevRank[cur]) pathSev.set(f.path, f.severity);
  }
  const unitRisk = (paths: string[]): Severity | null => {
    let best: Severity | null = null;
    for (const p of paths) {
      const s = pathSev.get(p);
      if (s && (!best || sevRank[s] > sevRank[best])) best = s;
    }
    return best;
  };

  const actorsOf = (paths: string[]): string[] => {
    const s = new Set<string>();
    for (const p of paths) for (const a of pathActors.get(p) ?? []) s.add(a);
    return [...s].sort();
  };

  const units = result.units.map((u) => ({
    id: id("cu"),
    title: u.title,
    kind: u.kind,
    confidence: result.confidence,
    paths: u.paths,
    depends_on: [] as string[],
    risk: unitRisk(u.paths),
    actors: actorsOf(u.paths),
    notes: u.notes,
  }));

  const actorPaths = new Map<string, string[]>();
  for (const [p, as] of pathActors)
    for (const a of as) {
      if (!actorPaths.has(a)) actorPaths.set(a, []);
      actorPaths.get(a)!.push(p);
    }
  const provenanceRecords = [...actorPaths.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([actor, paths]) => ({
      actor,
      contribution: actor.startsWith("ai:") ? "generated" : "edit",
      accepted: true,
      paths: paths.sort(),
    }));
  if (!provenanceRecords.length && changes.length)
    provenanceRecords.push({
      actor: "human",
      contribution: "edit",
      accepted: true,
      paths: changes.map((c) => c.path).sort(),
    });

  const planLines = [
    `  ${units.length} change unit(s), grouping confidence ${result.confidence}${result.fallback ? " (fallback: merged)" : ""}:`,
    ...units.map((u) => `    [${u.kind}]${u.risk ? ` (risk: ${u.risk})` : ""} ${u.title} — ${u.paths.join(", ")}`),
    ...notes.map((n) => `  note: ${n}`),
  ];
  let introTotal = 0;
  if (prov) {
    const a = prov.attribution;
    introTotal = a ? a.dead_code_introduced + a.complexity_introduced + a.duplication_introduced : 0;
    const inher = a ? a.dead_code_inherited + a.complexity_inherited + a.duplication_inherited : 0;
    const ver = prov.validation[0]?.provenance.provider_version ?? "?";
    planLines.push(
      `  provider fallow@${ver}: verdict ${prov.verdict ?? "n/a"} — ${introTotal} introduced, ${inher} inherited issue(s)`,
    );
  }
  if (provenanceRecords.length)
    planLines.push(
      `  provenance: ${provenanceRecords.map((r) => `${r.actor} (${r.paths.length} file(s))`).join(", ")}`,
    );
  if (secretFindings.length) {
    planLines.push(`  secrets: ${secretFindings.length} possible secret(s) in added lines (${secretErrors} error-level)`);
    for (const f of secretFindings.slice(0, 10))
      planLines.push(`    [${f.severity}] ocs/${f.rule} ${f.path}:${f.line} ${f.redacted}`);
    if (secretFindings.length > 10) planLines.push(`    …and ${secretFindings.length - 10} more`);
  }

  // The RFC 0003 decide step — the product in one branch: stay silent when the
  // work is clean and unambiguous; stop when judgment is required. Inherited
  // debt never interrupts; only what this session made worse does. Policy
  // (.ocs/config.json) tunes what counts as interrupt-worthy; it never tunes
  // what gets recorded.
  const reasons: string[] = [];
  if (units.length > 1 && cfg.policy.interrupt_on_multiple_units)
    reasons.push(`${units.length} change units — review the split`);
  if (result.fallback && cfg.policy.interrupt_on_low_confidence) reasons.push("low grouping confidence");
  if (introTotal > 0 && cfg.policy.interrupt_on_introduced_issues)
    reasons.push(`${introTotal} issue(s) introduced by this session`);
  if (secretErrors > 0 && cfg.policy.interrupt_on_secrets)
    reasons.push(`${secretErrors} possible secret(s) added`);

  if (dryRun) {
    console.log(`DRY RUN — finish plan for ${sess.id}`);
    if (!changes.length) console.log("  no changes since baseline");
    else {
      for (const l of planLines) console.log(l);
      console.log(reasons.length ? `  would interrupt: ${reasons.join("; ")}` : "  would auto-package (clean)");
    }
    return;
  }

  if (reasons.length && !yes) {
    console.log(`⏸ judgment required — finish paused:`);
    for (const r of reasons) console.log(`  • ${r}`);
    for (const l of planLines) console.log(l);
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question("approve and package? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (ans !== "y" && ans !== "yes") {
        console.log("finish cancelled — session remains active, nothing written");
        return;
      }
    } else {
      console.log("non-interactive: re-run with `ocs finish --yes` to approve, or keep working (session remains active)");
      process.exitCode = 3;
      return;
    }
  }

  const pid = id("pkg");
  const last = sess.checkpoints[sess.checkpoints.length - 1];
  const pkg = {
    id: pid,
    session_id: sess.id,
    created_at: nowISO(),
    intent: {
      declared: sess.intent,
      inferred: null,
      summary: sess.intent ?? (units.length ? units.map((u) => u.title).join("; ") : "Session changes"),
    },
    change_units: units,
    content_changes: changes,
    provenance: provenanceRecords,
    validation: [...(secretRecord ? [secretRecord] : []), ...(prov?.validation ?? [])],
    risk_signals: [
      ...secretFindings.map((f) => ({
        kind: "secret",
        severity: f.severity,
        target: f.path,
        rationale: `possible ${f.rule} in added lines (${f.redacted})`,
        introduced: true,
      })),
      ...(prov?.risk_signals ?? []),
    ],
    attribution: prov?.attribution ?? null,
    rollback: { strategy: "restore_checkpoint", checkpoint_ref: last ? last.ref : sess.baselineRef },
    tree: finishTree,
  };
  fs.writeFileSync(path.join(ocsDir(), "packages", pid + ".json"), JSON.stringify(pkg, null, 2) + "\n");
  sess.finishTree = finishTree;
  sess.finishTime = nowISO();
  sess.state = "packaged";
  sess.packages.push(pid);
  s.packages[pid] = pkg;
  s.activeSession = null;
  saveState(s);
  console.log(`Finished ${sess.id} → package ${pid}`);
  if (!changes.length) console.log("  no changes since baseline (empty package)");
  else for (const l of planLines) console.log(l);
  console.log(`  package: .ocs/packages/${pid}.json`);
}

function cmdExport(branch: string | null): void {
  const s = loadState();
  const sess = Object.values(s.sessions)
    .filter((x) => x.state === "packaged" && x.finishTree && x.finishTime)
    .sort((a, b) => (a.finishTime! < b.finishTime! ? 1 : -1))[0];
  if (!sess) throw new Error("no packaged session to export — run `ocs finish` first");
  const pid = sess.packages[sess.packages.length - 1];
  const pkg = s.packages[pid] as {
    tree: string;
    change_units: { id: string; title: string; paths: string[] }[];
    content_changes: Change[];
  };
  const br = branch ?? `ocs/${sess.id}`;
  const head = tryGit(["rev-parse", "HEAD"]);
  const byPath = new Map(pkg.content_changes.map((c) => [c.path, c] as const));

  // One commit per change unit, built from the baseline tree by applying each
  // unit's file changes in order. The final tree must equal the finish tree.
  const idx = path.join(ocsDir(), "tmp-index");
  fs.rmSync(idx, { force: true });
  git(["read-tree", sess.baselineTree], idx);
  let parent = head;
  let lastTree = sess.baselineTree;
  let commits = 0;

  // If the tree was dirty at `ocs start`, that pre-session state is not the
  // session's work and must not be attributed to a change unit — carry it in
  // an explicitly labeled commit instead of letting it ride silently.
  const headTree = head ? git(["rev-parse", `${head}^{tree}`]) : null;
  if (headTree !== null && headTree !== sess.baselineTree) {
    parent = mkCommit(sess.baselineTree, parent, `Pre-session working tree state\n\nocs-package: ${pid}\nsession: ${sess.id}`);
    console.log("  note: tree was dirty at session start — emitted a labeled pre-session commit");
  }
  for (const u of pkg.change_units) {
    for (const p of u.paths) {
      const c = byPath.get(p);
      if (!c) continue;
      if (c.renamed_from) git(["update-index", "--force-remove", "--", c.renamed_from], idx);
      if (c.status === "deleted") git(["update-index", "--force-remove", "--", p], idx);
      else git(["update-index", "--add", "--cacheinfo", `${c.mode},${c.after_oid},${p}`], idx);
    }
    const tree = git(["write-tree"], idx);
    if (tree === lastTree) continue;
    parent = mkCommit(tree, parent, `${u.title}\n\nocs-package: ${pid}\nocs-unit: ${u.id}\nsession: ${sess.id}`);
    lastTree = tree;
    commits++;
  }
  fs.rmSync(idx, { force: true });
  if (commits === 0) throw new Error("nothing to export — package has no changes");
  if (lastTree !== pkg.tree) console.error("warning: exported tree differs from the finish tree");
  git(["update-ref", `refs/heads/${br}`, parent!]);
  console.log(`Exported package ${pid} → branch ${br} (${commits} commit(s), head ${short(parent!)})`);
}

// Install/remove the Claude Code agent hook (the fallow `setup-hooks` pattern,
// pointed at provenance): after every Edit/Write tool call, the agent fires
// `ocs checkpoint --actor ai:<name>`, so AI edits land as actor-tagged
// checkpoints and packages show human-vs-AI authorship. The hook swallows all
// failures (no active session, etc.) so it never blocks the agent.
function cmdHooks(action: string, target: string, actor: string): void {
  if (!["install", "remove"].includes(action) || target !== "claude")
    throw new Error("usage: ocs hooks <install|remove> claude [--actor ai:<name>]");
  const settingsPath = path.join(REPO_ROOT, ".claude", "settings.json");
  const MARKER = "--label agent-hook";
  type Settings = { hooks?: { PostToolUse?: unknown[] } & Record<string, unknown> } & Record<string, unknown>;
  if (action === "remove" && !fs.existsSync(settingsPath)) {
    console.log("no .claude/settings.json — nothing to remove");
    return;
  }
  const settings: Settings = fs.existsSync(settingsPath)
    ? (JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Settings)
    : {};
  const hooks = (settings.hooks ??= {});
  const kept = (hooks.PostToolUse ?? []).filter((e) => !JSON.stringify(e).includes(MARKER));
  if (action === "install") {
    // Prefer a repo-relative script path when ocs lives inside this repo —
    // .claude/settings.json is committed and shared, and an absolute path
    // would break on every other machine. Hooks run with cwd = project root.
    const abs = path.resolve(process.argv[1]);
    const rel = path.relative(REPO_ROOT, abs);
    const scriptRef = rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
    const cmd = `node "${scriptRef}" checkpoint --actor ${actor} --label agent-hook >/dev/null 2>&1 || true`;
    kept.push({
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: cmd }],
    });
    hooks.PostToolUse = kept;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`Installed Claude Code agent hook in .claude/settings.json`);
    console.log(`  after Edit/Write tool calls: ocs checkpoint --actor ${actor}`);
  } else {
    hooks.PostToolUse = kept;
    if (!kept.length) delete hooks.PostToolUse;
    if (!Object.keys(hooks).length) delete settings.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log("Removed ocs-managed Claude Code hooks");
  }
}

// ---------- cli ----------
function parseFlags(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { _, flags } = parseFlags(rest);
  if (cmd !== "init") {
    const top = tryGit(["rev-parse", "--show-toplevel"]);
    if (top) REPO_ROOT = top;
  }
  switch (cmd) {
    case "init": cmdInit(); break;
    case "start": cmdStart((flags.intent as string) ?? null); break;
    case "checkpoint": cmdCheckpoint((flags.label as string) ?? null, (flags.actor as string) ?? "human"); break;
    case "status": cmdStatus(); break;
    case "log": cmdLog(); break;
    case "restore": cmdRestore(_[0] ?? ""); break;
    case "finish": await cmdFinish(flags["dry-run"] === true, flags["yes"] === true); break;
    case "export": cmdExport((flags.branch as string) ?? null); break;
    case "hooks": cmdHooks(_[0] ?? "", _[1] ?? "", (flags.actor as string) ?? "ai:claude-code"); break;
    default:
      console.log("usage: ocs <init|start|checkpoint|status|log|restore|finish [--dry-run] [--yes]|export|hooks>");
      process.exit(cmd ? 1 : 0);
  }
}

try {
  await main();
} catch (e) {
  console.error("error:", (e as Error).message);
  process.exit(1);
}
