import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let sessionId: string = crypto.randomUUID();
const connection = acp.agent({ name: "real-container-fixture" })
  .onRequest("initialize", () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
  .onRequest("session/new", () => ({ sessionId }))
  .onRequest("session/load", ctx => { sessionId = ctx.params.sessionId; return {}; })
  .onRequest("session/prompt", async ctx => {
    const input = JSON.parse(ctx.params.prompt.filter(p => p.type === "text").map(p => (p as { text: string }).text).join(""));
    const result: Record<string, unknown> = { uid: process.getuid!(), cwd: process.cwd(), token: process.env.ORG_TOKEN ?? null };
    for (const [key, path] of Object.entries(input.read ?? {})) {
      try { result[key] = await readFile(path as string, "utf8"); } catch (error: any) { result[key] = error.code; }
    }
    for (const [key, path] of Object.entries(input.write ?? {})) {
      try { await writeFile(path as string, "container-write"); result[key] = "ok"; } catch (error: any) { result[key] = error.code; }
    }
    const mcp = new Client({ name: "real-container-test", version: "1" });
    await mcp.connect(new StdioClientTransport({ command: "/usr/local/bin/agentorg-podman-mcp", args: [], env: { ORG_SOCKET: process.env.ORG_SOCKET! } }));
    try {
      result.tools = (await mcp.listTools()).tools.map(t => t.name);
      if (input.call) result.call = await mcp.callTool(input.call);
    } finally { await mcp.close(); }
    await ctx.client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } } });
    return { stopReason: "end_turn" as const };
  }).connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
process.stdin.on("end", () => { connection.close(); process.exit(0); });
