// Throwaway MCP client for the acceptance test: drives src/mcp.ts over stdio
// with raw newline-delimited JSON-RPC (the real protocol — no SDK, no mocks)
// and plays an agent working in the repo passed as argv[2]. Exits nonzero on
// the first failed assertion.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const repo = process.argv[2];
if (!repo) {
  console.error("usage: node mcp_client.mjs <repo-dir>");
  process.exit(2);
}
const mcpPath = fileURLToPath(new URL("../src/mcp.ts", import.meta.url));
const srv = spawn(process.execPath, [mcpPath], {
  cwd: repo,
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, OCS_PROVIDER: "none" },
});

const pending = new Map();
const rl = readline.createInterface({ input: srv.stdout });
rl.on("line", (l) => {
  let m;
  try {
    m = JSON.parse(l);
  } catch {
    return fail("server emitted non-JSON on stdout: " + l.slice(0, 120));
  }
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

let nextId = 1;
function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("timeout waiting for " + method));
      }
    }, 240_000).unref();
  });
}
function notify(method, params) {
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}
function fail(msg) {
  console.error("FAIL(mcp): " + msg);
  process.exit(1);
}
const text = (r) => {
  if (r.error) fail("rpc error: " + JSON.stringify(r.error));
  return r.result.content[0].text;
};

// -- handshake --
const init = await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "ocs-acceptance", version: "0" },
});
if (init.result?.serverInfo?.name !== "ocs") fail("bad serverInfo: " + JSON.stringify(init.result));
if (init.result.protocolVersion !== "2025-06-18") fail("bad protocolVersion echo");
notify("notifications/initialized");

const list = await call("tools/list", {});
const names = list.result.tools.map((t) => t.name);
for (const want of [
  "ocs_init",
  "ocs_start",
  "ocs_checkpoint",
  "ocs_status",
  "ocs_log",
  "ocs_restore",
  "ocs_finish_plan",
  "ocs_finish",
  "ocs_export",
]) {
  if (!names.includes(want)) fail("missing tool " + want);
}

// -- agent session --
let r = await call("tools/call", { name: "ocs_init", arguments: {} });
if (!text(r).includes("status: ok")) fail("init not ok: " + text(r));

r = await call("tools/call", { name: "ocs_start", arguments: { intent: "agent work over MCP" } });
if (!text(r).includes("status: ok")) fail("start not ok: " + text(r));

// the "agent" edits stream A, then checkpoints (default actor ai:claude-code)
fs.appendFileSync(path.join(repo, "src/util.ts"), "\nexport const MCP_A = 1;\n");
r = await call("tools/call", { name: "ocs_checkpoint", arguments: { label: "agent edit" } });
if (!text(r).includes("status: ok")) fail("checkpoint not ok: " + text(r));
if (!text(r).includes("ai:claude-code")) fail("checkpoint should default to actor ai:claude-code: " + text(r));

// stream B: an unrelated docs edit -> two units -> judgment required at finish
fs.writeFileSync(path.join(repo, "README.md"), "# sample\n\ndocs written over MCP\n");

r = await call("tools/call", { name: "ocs_finish_plan", arguments: {} });
if (!text(r).includes("DRY RUN")) fail("finish_plan should be a dry run: " + text(r));
if (!text(r).includes("would interrupt")) fail("plan should report it would interrupt: " + text(r));

r = await call("tools/call", { name: "ocs_finish", arguments: {} });
if (!text(r).includes("status: judgment_required")) fail("finish without approve must be judgment_required: " + text(r));
if (r.result.isError) fail("judgment_required must not be isError");

r = await call("tools/call", { name: "ocs_finish", arguments: { approve: true } });
if (!text(r).includes("status: ok") || !text(r).includes("package")) fail("approved finish should package: " + text(r));

r = await call("tools/call", { name: "ocs_status", arguments: {} });
if (!text(r).includes("No active session")) fail("session should be closed after finish: " + text(r));

// unknown tool -> isError
r = await call("tools/call", { name: "ocs_nope", arguments: {} });
if (!r.result?.isError) fail("unknown tool should be isError");

console.log("MCP-CLIENT-OK");
srv.stdin.end();
process.exit(0);
