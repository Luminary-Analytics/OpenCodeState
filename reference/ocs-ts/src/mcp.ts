#!/usr/bin/env -S node
// Minimal MCP (Model Context Protocol) stdio server exposing OpenCodeState to
// AI agents — the second piece of the planned TypeScript surface (RFC 0003).
//
// Agents drive sessions natively (start/checkpoint/finish) instead of via
// shell hooks, with agent-first defaults: checkpoints default to actor
// ai:claude-code, and ocs_finish surfaces the judgment interrupt as a
// structured `judgment_required` result instead of packaging silently — an
// agent cannot bypass the human gate without an explicit approve: true.
//
// Implementation notes:
// - Tools-only server, hand-rolled over newline-delimited JSON-RPC to keep the
//   reference implementation runtime-dependency free; swap for the official
//   SDK when the surface grows beyond tools.
// - Each tool shells the ocs CLI (the tested contract): exit 0 -> ok,
//   3 -> judgment_required (NOT an error), anything else -> error.
// - stdout carries protocol JSON only; logs go to stderr.

import { execFileSync } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import { OCS_VERSION } from "./version.ts";

const OCS = fileURLToPath(new URL("./ocs.ts", import.meta.url));
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  args(a: Record<string, unknown>): string[];
}

const TOOLS: ToolDef[] = [
  {
    name: "ocs_init",
    description: "Initialize an OpenCodeState workspace in the current git repository (idempotent).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: () => ["init"],
  },
  {
    name: "ocs_start",
    description: "Start a work session. Record an intent when you know what the work is trying to accomplish.",
    inputSchema: {
      type: "object",
      properties: { intent: { type: "string", description: "What this session is trying to accomplish" } },
      additionalProperties: false,
    },
    args: (a) => ["start", ...(a.intent ? ["--intent", String(a.intent)] : [])],
  },
  {
    name: "ocs_checkpoint",
    description:
      "Snapshot the working tree as an actor-tagged restore point. Call after meaningful edits. Defaults to actor ai:claude-code — pass your own actor id if different.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        actor: { type: "string", description: "Defaults to ai:claude-code" },
      },
      additionalProperties: false,
    },
    args: (a) => [
      "checkpoint",
      "--actor",
      String(a.actor ?? "ai:claude-code"),
      ...(a.label ? ["--label", String(a.label)] : []),
    ],
  },
  {
    name: "ocs_status",
    description: "Show the active session and the files changed since its baseline.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: () => ["status"],
  },
  {
    name: "ocs_log",
    description: "Show the active session's checkpoint timeline (actors, triggers, labels).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: () => ["log"],
  },
  {
    name: "ocs_restore",
    description:
      "Restore the working tree to a checkpoint (by number or commit prefix). Non-destructive: the current state is checkpointed first.",
    inputSchema: {
      type: "object",
      properties: { checkpoint: { type: "string" } },
      required: ["checkpoint"],
      additionalProperties: false,
    },
    args: (a) => ["restore", String(a.checkpoint)],
  },
  {
    name: "ocs_finish_plan",
    description:
      "Preview the finish plan (change units, risk, secrets, whether it would interrupt) WITHOUT packaging. Cheap; call freely.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: () => ["finish", "--dry-run"],
  },
  {
    name: "ocs_finish",
    description:
      "Finish the session into package(s). If judgment is required (multiple units, introduced issues, secrets, low confidence) the result is status: judgment_required and NOTHING is written — surface the plan to the human and call again with approve: true only after they approve.",
    inputSchema: {
      type: "object",
      properties: {
        approve: { type: "boolean", description: "Explicit human-approved override of the judgment interrupt" },
      },
      additionalProperties: false,
    },
    args: (a) => ["finish", ...(a.approve === true ? ["--yes"] : [])],
  },
  {
    name: "ocs_export",
    description: "Export the most recent package to a git branch (one commit per change unit).",
    inputSchema: { type: "object", properties: { branch: { type: "string" } }, additionalProperties: false },
    args: (a) => ["export", ...(a.branch ? ["--branch", String(a.branch)] : [])],
  },
];

function runOcs(args: string[]): { code: number; text: string } {
  try {
    const out = execFileSync(process.execPath, [OCS, ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
      timeout: 240_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, text: out };
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    const text = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "unknown error";
    return { code: err.status ?? 1, text };
  }
}

function callTool(
  name: string,
  a: Record<string, unknown>,
): { content: { type: "text"; text: string }[]; isError?: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `status: error\n\nunknown tool: ${name}` }], isError: true };
  const { code, text } = runOcs(tool.args(a));
  const status = code === 0 ? "ok" : code === 3 ? "judgment_required" : "error";
  return {
    content: [{ type: "text", text: `status: ${status}\n\n${text.trim()}` }],
    ...(status === "error" ? { isError: true } : {}),
  };
}

function respond(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: { id?: unknown; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    respondError(null, -32700, "parse error");
    return;
  }
  if (!msg.method) return; // a response, not a request — ignore
  const { id, method } = msg;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  try {
    if (method === "initialize") {
      const requested = String(params.protocolVersion ?? "");
      respond(id, {
        protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ocs", version: OCS_VERSION },
      });
    } else if (method.startsWith("notifications/")) {
      // notifications need no response
    } else if (method === "ping") {
      respond(id, {});
    } else if (method === "tools/list") {
      respond(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    } else if (method === "tools/call") {
      const p = params as { name?: unknown; arguments?: Record<string, unknown> };
      respond(id, callTool(String(p.name ?? ""), p.arguments ?? {}));
    } else if (id !== undefined) {
      respondError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) respondError(id, -32603, (e as Error).message);
  }
});
rl.on("close", () => process.exit(0));
console.error(`ocs-mcp ${OCS_VERSION} ready (stdio)`);
