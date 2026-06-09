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

type Trigger = "explicit" | "command" | "save" | "agent" | "pre-restore";
type Status = "added" | "modified" | "deleted";

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

interface Change {
  path: string;
  status: Status;
  before_oid: string | null;
  after_oid: string | null;
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

// Net change between two trees, parsed from `git diff --raw`.
function diffTrees(a: string, b: string): Change[] {
  const out = tryGit(["diff", "--raw", "--no-renames", a, b]);
  if (!out) return [];
  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith(":")) continue;
    const [meta, file] = line.split("\t");
    const f = meta.replace(/^:/, "").split(/\s+/); // srcMode dstMode srcSha dstSha STATUS
    const st = f[4][0];
    changes.push({
      path: file,
      status: st === "A" ? "added" : st === "D" ? "deleted" : "modified",
      before_oid: isZero(f[2]) ? null : f[2],
      after_oid: isZero(f[3]) ? null : f[3],
    });
  }
  return changes;
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
  console.log("Initialized OpenCodeState workspace in .ocs/");
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
  const cp = makeCheckpoint(sess, "explicit", actor, label);
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

function cmdFinish(): void {
  const s = loadState();
  const sess = requireActive(s);
  const finishTree = snapshotWorkingTree();
  const changes = diffTrees(sess.baselineTree, finishTree);
  const pid = id("pkg");
  const last = sess.checkpoints[sess.checkpoints.length - 1];
  const pkg = {
    id: pid,
    session_id: sess.id,
    created_at: nowISO(),
    intent: { declared: sess.intent, inferred: null, summary: sess.intent ?? "Session changes" },
    change_units: [
      {
        id: id("cu"),
        title: sess.intent ?? "Session changes",
        kind: "session",
        confidence: 1,
        paths: changes.map((c) => c.path),
      },
    ],
    content_changes: changes,
    provenance: [{ actor: "human", contribution: "edit", accepted: true }],
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
  console.log(`  ${changes.length} file(s) in 1 change unit:`);
  for (const c of changes) console.log(`    ${c.status[0].toUpperCase()}  ${c.path}`);
  console.log(`  package: .ocs/packages/${pid}.json`);
}

function cmdExport(branch: string | null): void {
  const s = loadState();
  const sess = Object.values(s.sessions)
    .filter((x) => x.state === "packaged" && x.finishTree && x.finishTime)
    .sort((a, b) => (a.finishTime! < b.finishTime! ? 1 : -1))[0];
  if (!sess) throw new Error("no packaged session to export — run `ocs finish` first");
  const pid = sess.packages[sess.packages.length - 1];
  const pkg = s.packages[pid] as { intent: { summary: string }; content_changes: unknown[] };
  const br = branch ?? `ocs/${sess.id}`;
  const head = tryGit(["rev-parse", "HEAD"]);
  const summary =
    `${pkg.intent.summary}\n\n` +
    `ocs-package: ${pid}\nsession: ${sess.id}\nfiles: ${pkg.content_changes.length}`;
  const commit = mkCommit(sess.finishTree!, head, summary);
  git(["update-ref", `refs/heads/${br}`, commit]);
  console.log(`Exported package ${pid} → branch ${br} (${short(commit)})`);
  console.log(`  tree ${short(sess.finishTree!)} == working tree at finish`);
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

function main(): void {
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
    case "finish": cmdFinish(); break;
    case "export": cmdExport((flags.branch as string) ?? null); break;
    default:
      console.log("usage: ocs <init|start|checkpoint|status|log|restore|finish|export>");
      process.exit(cmd ? 1 : 0);
  }
}

try {
  main();
} catch (e) {
  console.error("error:", (e as Error).message);
  process.exit(1);
}
