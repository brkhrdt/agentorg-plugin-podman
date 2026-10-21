import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "agent-organization/client";
import type { AgentRecord, Operation } from "agent-organization/types";
import { createPiPlugin } from "../../agentorg-plugin-pi-agent/src/index.ts";
import { createPodmanPlugin } from "../src/index.ts";

// No model calls: startup and MCP delegation only, with network disabled and an
// intentionally fake credential so Pi can choose a local default model record.
test.skipIf(!process.env.ORG_PODMAN_PI_IMAGE)("example Pi image: native ACP and native MCP create a child without host Pi/runtime mounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aop-pi-image-"));
  const cwd = join(dir, "workspace"); await mkdir(cwd);
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined, mcp: Client | undefined;
  try {
    server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"),
      plugins: [createPiPlugin({ bunExecutable: "/not-mounted/bun", adapterExecutable: "/not-mounted/adapter" }), createPodmanPlugin({ defaultImage: process.env.ORG_PODMAN_PI_IMAGE!, network: "none" })],
      limits: { startTimeoutMs: 30_000 } });
    client = await OrganizationClient.connect(server.organization.socketPath);
    const creation = await client.wait(await client.request<Operation>("agent.create", { settings: { harness: "pi", cwd, env: { ANTHROPIC_API_KEY: "offline-test-not-a-real-key" }, extensions: { podman: { readOnlyDirs: [cwd] } } } }));
    expect(creation.status).toBe("completed");
    if (creation.status !== "completed") throw new Error(JSON.stringify(creation.error));
    const root = creation.result as AgentRecord;
    // The stable container name is advertised only to this trusted test through
    // podman's label/name listing; no public host capability enters the container.
    const listing = Bun.spawn(["podman", "ps", "--format", "{{.Names}}"], { stdout: "pipe" });
    const name = (await new Response(listing.stdout).text()).split("\n").find(n => n.endsWith(root.generation!))!;
    await listing.exited;
    mcp = new Client({ name: "pi-image-test", version: "1" });
    await mcp.connect(new StdioClientTransport({ command: "podman", args: ["exec", "-i", name, "/usr/local/bin/agentorg-podman-mcp"] }));
    expect((await mcp.listTools()).tools.map(t => t.name)).toContain("create_subagent");
    const called = await mcp.callTool({ name: "create_subagent", arguments: { settings: { harness: "pi", cwd, env: { ANTHROPIC_API_KEY: "offline-test-not-a-real-key" } }, readOnlyDirs: [cwd] } });
    expect(called.isError).not.toBe(true);
    const childCreation = await client.wait(JSON.parse((called.content as any)[0].text));
    expect(childCreation.status).toBe("completed");
    const child = childCreation.result as AgentRecord;
    expect(child.state).toBe("idle"); expect(child.generation).not.toBe(root.generation);
  } finally {
    await mcp?.close(); client?.close(); await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);
