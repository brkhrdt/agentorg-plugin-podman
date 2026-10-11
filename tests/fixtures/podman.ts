#!/usr/bin/env bun
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_PODMAN_LOG) appendFileSync(process.env.FAKE_PODMAN_LOG, JSON.stringify(args) + "\n");
if (args[0] === "info") { console.log(JSON.stringify({ host: { security: { rootless: true } }, store: {} })); process.exit(0); }
if (args[0] !== "run") process.exit(0);
const cwd = args[args.indexOf("--workdir") + 1]!;
process.chdir(cwd);
for (let i = 0; i < args.length; i++) if (args[i] === "--env") { const [name, ...value] = args[++i]!.split("="); process.env[name!] = value.join("="); }
let sessionId: string = crypto.randomUUID();
const connection = acp.agent({ name: "container-fixture" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest("session/new", () => ({ sessionId }))
  .onRequest("session/load", ctx => { sessionId = ctx.params.sessionId; return {}; })
  .onRequest("session/prompt", async ctx => {
    await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.cwd() } } });
    return { stopReason: "end_turn" as const };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
process.stdin.on("end", () => { connection.close(); process.exit(0); });
