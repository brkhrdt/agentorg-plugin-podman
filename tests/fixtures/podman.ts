#!/usr/bin/env node
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_PODMAN_LOG) appendFileSync(process.env.FAKE_PODMAN_LOG, JSON.stringify(args) + "\n");
if (args[0] === "info") { console.log(JSON.stringify({ host: { security: { rootless: true } }, store: {} })); process.exit(0); }
const images: Record<string, string> = process.env.FAKE_PODMAN_IMAGES ? JSON.parse(readFileSync(process.env.FAKE_PODMAN_IMAGES, 'utf8')) : {
  'test:v1': 'a'.repeat(64), 'test:v2': 'b'.repeat(64), 'test:v3': 'd'.repeat(64), 'test:v4': 'e'.repeat(64),
  'explicit:v1': 'f'.repeat(64), 'custom:v3': '1'.repeat(64), 'override:v1': '2'.repeat(64),
  'root:v1': '3'.repeat(64), 'child:v1': '4'.repeat(64), 'fallback:v1': '5'.repeat(64),
  'operator:v3': '6'.repeat(64), 'operator:v4': '7'.repeat(64), 'localhost/agentorg-pi:latest': 'c'.repeat(64),
};
if (args[0] === 'images') {
  console.log(JSON.stringify([...Object.entries(images).map(([name, Id]) => ({ Id, Names: [name], Labels: { secret: 'DO-NOT-EXPOSE' } })),
    { Id: '9'.repeat(64), Names: [] }, { Id: '8'.repeat(64), RepoTags: ['<none>:<none>'] },
    { Id: '7'.repeat(64), Names: [], RepoTags: ['alias:v1', 'test:v1'] }])); process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') {
  for (const name of args.slice(3)) { if (!images[name]) process.exit(1); console.log(images[name]); } process.exit(0);
}
if (args[0] === "volume" && args[1] === "ls") {
  console.log(Object.keys(JSON.parse(readFileSync(process.env.FAKE_PODMAN_VOLUMES!, "utf8"))).join('\n')); process.exit(0);
}
if (args[0] === "volume" && args[1] === "inspect") {
  const volumes = JSON.parse(readFileSync(process.env.FAKE_PODMAN_VOLUMES!, "utf8"));
  if (!volumes[args[2]!]) process.exit(1);
  console.log(JSON.stringify([volumes[args[2]!] ])); process.exit(0);
}
if (args[0] !== "run") process.exit(0);
const image = args[args.indexOf("--entrypoint") + 2]!;
if (!images[image]) { console.error(`Image not found locally: ${image}`); process.exit(125); }
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
