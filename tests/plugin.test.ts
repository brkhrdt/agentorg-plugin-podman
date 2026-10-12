import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "agent-organization/client";
import type { AgentRecord, Operation } from "agent-organization/types";
import type { ServerPlugin } from "agent-organization/plugin";
import { createPodmanPlugin, type PodmanPluginOptions } from "../src/index.ts";
import { RpcClient } from "../src/rpc.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function setup(extra: ServerPlugin[] = [], volumes: PodmanPluginOptions['volumes'] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "podman-plugin-test-"));
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, "child", "leaf"), { recursive: true });
  mkdirSync(join(workspace, "readonly")); mkdirSync(join(dir, "outside"));
  const log = join(dir, "podman.log");
  const executable = join(dir, "podman");
  const volumeFile = join(dir, 'volumes.json');
  const records = Object.fromEntries([...Object.keys(volumes), 'unrelated'].map(name => {
    const mountpoint = join(dir, 'volume-data', name); mkdirSync(mountpoint, { recursive: true });
    return [name, { Name: name, Driver: 'local', Options: {}, CreatedAt: '2026-01-01T00:00:00Z', Mountpoint: mountpoint }];
  }));
  writeFileSync(volumeFile, JSON.stringify(records));
  writeFileSync(executable, `#!/bin/sh\nexport FAKE_PODMAN_VOLUMES='${volumeFile}'\nexport FAKE_PODMAN_LOG='${log}'\nexec '${process.execPath}' '${join(import.meta.dir, "fixtures/podman.ts")}' "$@"\n`);
  chmodSync(executable, 0o700);
  const harness: ServerPlugin = { apiVersion: 1, name: "fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch: ({ agent, executionEnvironment }) => {
      expect(executionEnvironment).toBe("container");
      return { command: "fixture", args: [], cwd: agent.settings.cwd, env: { HOST_SECRET: "never-pass", ORG_PI_CONFIG: "fixture-config" } };
    } });
  } };
  const server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"),
    plugins: [harness, createPodmanPlugin({ podmanExecutable: executable, defaultImage: "test:v1", volumes }), ...extra],
    limits: { stopTimeoutMs: 1000, killTimeoutMs: 100, startTimeoutMs: 3000 } });
  const client = await OrganizationClient.connect(server.organization.socketPath);
  cleanup.push(async () => { client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const mutate = (method: string, params: unknown) => client.request<Operation>(method, params).then(op => client.wait(op));
  const create = (parentId: string | null, cwd = workspace, podman: unknown = { readWriteDirs: [workspace] }) => mutate("agent.create", { parentId, settings: { harness: "fixture", cwd, extensions: { podman } } });
  const root = (await create(null)).result as AgentRecord;
  expect(root).toBeDefined();
  const runs = () => readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l) as string[]).filter(a => a[0] === "run");
  const relay = (run: string[]) => run.find(s => s.startsWith("ORG_SOCKET="))!.slice("ORG_SOCKET=".length);
  const get = (id: string) => client.request<AgentRecord>("agent.get", { agentId: id });
  return { dir, workspace, server, client, mutate, create, root, runs, relay, get, volumeFile };
}
function toolResult(result: any) { return JSON.parse(result.content[0].text); }

test("every launch is wrapped, grants are explicit, only private session and MCP socket are exposed", async () => {
  const { dir, workspace, root, create, runs, relay, server } = await setup();
  const snapshot = await server.organization.request("organization.snapshot") as any;
  expect(snapshot.capabilities.settingsEditors.podman).toEqual({ fields: [
    { key: "readOnlyDirs", label: "Read-only grants", editor: "directories" },
    { key: "readWriteDirs", label: "Read/write grants", editor: "directories" },
    { key: "readOnlyVolumes", label: "Read-only volumes", editor: "list" },
    { key: "readWriteVolumes", label: "Read/write volumes", editor: "list" },
  ] });
  const run = runs()[0]!;
  expect(run).toContain("--userns=keep-id:uid=1000,gid=1000"); expect(run).toContain("--cap-drop=ALL");
  expect(run).toContain("--security-opt=no-new-privileges"); expect(run).toContain("test:v1");
  expect(run.some(a => a.startsWith("HOST_SECRET="))).toBe(false);
  expect(run.some(a => a.startsWith("ORG_TOKEN="))).toBe(false);
  const bootstrap = JSON.parse(run[run.indexOf("--entrypoint") + 3]!);
  expect(bootstrap.env.ORG_PI_CONFIG).toBe("fixture-config");
  expect(bootstrap.env.HOST_SECRET).toBeUndefined();
  expect(bootstrap.env.ORG_TOKEN).toBeUndefined();
  expect(run.filter(s => s.startsWith("type=bind"))).toHaveLength(3);
  expect(run.some(a => a.includes(server.organization.socketPath))).toBe(false);
  const childOp = await create(root.id, join(workspace, "child"), { readOnlyDirs: ["child"] });
  expect(childOp.status).toBe("completed");
  expect((childOp.result as AgentRecord).settings.extensions?.podman).toMatchObject({ readOnlyDirs: [join(workspace, "child")], readWriteDirs: [] });
  expect(runs()[1]).toContain("test:v1");
  const noGrants = await create(root.id, join(workspace, "child"), {});
  expect(noGrants.status).toBe("failed"); expect(noGrants.error?.message).toContain("cwd");
  const forbidden = await create(root.id, workspace, { readWriteDirs: [dir] });
  expect(forbidden.error?.code).toBe("FORBIDDEN");
  const rpc = new RpcClient(relay(run));
  try {
    await expect(rpc.request("agent.get", { agentId: root.id })).rejects.toThrow("only MCP");
    await expect(rpc.request("podman.modify", {})).rejects.toThrow("only MCP");
    const tools: any = await rpc.request("mcp.list");
    expect(tools.tools.find((t: any) => t.name === "child_create").inputSchema.properties.readOnlyDirs).toBeDefined();
  } finally { rpc.close(); }
});

test("agent runtime variables are delayed until after the mount gate, never applied to host Podman", async () => {
  const { root, mutate, runs } = await setup();
  const operation = await mutate("agent.modify", { agentId: root.id, settings: { env: { LD_PRELOAD: "/task/untrusted.so", BUN_OPTIONS: "--preload=/task/untrusted.ts", CONTAINER_HOST: "tcp://untrusted" } } });
  expect(operation.status).toBe("completed");
  const run = runs().at(-1)!;
  expect(run.some(arg => arg.startsWith("LD_PRELOAD=") || arg.startsWith("BUN_OPTIONS=") || arg.startsWith("CONTAINER_HOST="))).toBe(false);
  expect(JSON.parse(run[run.indexOf("--entrypoint") + 3]!).env).toMatchObject({ LD_PRELOAD: "/task/untrusted.so", BUN_OPTIONS: "--preload=/task/untrusted.ts", CONTAINER_HOST: "tcp://untrusted" });
});

test("agent MCP delegation rejects outside directories, symlink escapes and RO escalation", async () => {
  const { root, workspace, dir, client, mutate, runs, relay } = await setup();
  await mutate("agent.modify", { agentId: root.id, settings: { extensions: { podman: { readOnlyDirs: [workspace] } } } });
  symlinkSync(join(dir, "outside"), join(workspace, "escape"));
  const rpc = new RpcClient(relay(runs().at(-1)!));
  try {
    const invoke = async (readOnlyDirs: string[], readWriteDirs: string[], cwd = workspace) => {
      const result = await rpc.request("mcp.call", { name: "child_create", arguments: { settings: { harness: "fixture", cwd }, readOnlyDirs, readWriteDirs } });
      const value = toolResult(result);
      return (result as any).isError ? value : await client.wait(value);
    };
    expect((await invoke([], [workspace])).error?.code).toBe("FORBIDDEN");
    expect((await invoke([join(dir, "outside")], [], join(dir, "outside"))).error?.code).toBe("FORBIDDEN");
    expect((await invoke(["escape"], [], "escape")).error?.code).toBe("FORBIDDEN");
    const child = await invoke(["child"], [], "child");
    expect(child.status).toBe("completed");
    const changed = await rpc.request("mcp.call", { name: "descendant_modify", arguments: { agentId: child.agentId, readOnlyDirs: [], readWriteDirs: ["child"] } });
    expect((await client.wait(toolResult(changed))).error?.code).toBe("FORBIDDEN");
    const image = await rpc.request("mcp.call", { name: "descendant_modify", arguments: { agentId: child.agentId, settings: { extensions: { podman: { image: "evil:latest", readOnlyDirs: [join(workspace, "child")] } } } } });
    expect((await client.wait(toolResult(image))).error?.code).toBe("FORBIDDEN");
  } finally { rpc.close(); }
});

test("clients can add external directories, descendants may delegate them only with sufficient direct-parent permissions", async () => {
  const { root, workspace, dir, create, mutate, client, runs, relay } = await setup();
  const outside = join(dir, "outside");
  const child = (await create(root.id, outside, { readOnlyDirs: [outside] })).result as AgentRecord;
  const rpc = new RpcClient(relay(runs().at(-1)!));
  try {
    const result = toolResult(await rpc.request("mcp.call", { name: "child_create", arguments: { settings: { harness: "fixture", cwd: outside }, readOnlyDirs: [outside] } }));
    expect((await client.wait(result)).status).toBe("completed");
  } finally { rpc.close(); }
  await mutate("agent.modify", { agentId: child.id, settings: { cwd: join(workspace, "child"), extensions: { podman: { readWriteDirs: [join(workspace, "child")], readOnlyDirs: [outside] } } } });
  // Explicit client grants are not automatically inherited by sibling/parent agents.
  expect(root.settings.extensions?.podman).toMatchObject({ readWriteDirs: [workspace] });
});

test("mixed permission islands cannot be flattened into a writable child grant", async () => {
  const { root, workspace, mutate, runs, relay, client } = await setup();
  const readonly = join(workspace, "readonly");
  await mutate("agent.modify", { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [workspace], readOnlyDirs: [readonly] } } } });
  const rpc = new RpcClient(relay(runs().at(-1)!));
  try {
    for (const ro of [[], [readonly]]) {
      const op = toolResult(await rpc.request("mcp.call", { name: "child_create", arguments: { settings: { harness: "fixture", cwd: workspace }, readWriteDirs: [workspace], readOnlyDirs: ro } }));
      expect((await client.wait(op)).status).toBe(ro.length ? "completed" : "failed");
    }
  } finally { rpc.close(); }
});

test("image scopes pin branches, respect override boundaries, or replace all overrides", async () => {
  const { root, workspace, client, create, get, runs } = await setup();
  const child = (await create(root.id, join(workspace, "child"), { readOnlyDirs: [workspace] })).result as AgentRecord;
  const leaf = (await create(child.id, join(workspace, "child/leaf"), { image: "override:v1", readOnlyDirs: [workspace] })).result as AgentRecord;
  const change = async (image: string, imageScope: string) => {
    const current = await get(root.id);
    const result: any = await client.request("podman.modify", { agentId: root.id, expectedRevision: current.revision, imageScope, settings: { extensions: { podman: { ...current.settings.extensions?.podman as object, image } } } });
    expect(result.errors).toEqual([]);
  };
  await change("test:v2", "node");
  expect((await get(child.id)).settings.extensions?.podman).toMatchObject({ image: "test:v1" });
  expect((await get(leaf.id)).settings.extensions?.podman).toMatchObject({ image: "override:v1" });
  // Clear the child override, then inherited scope restarts it but not the explicit leaf.
  await client.wait(await client.request<Operation>("agent.modify", { agentId: child.id, settings: { extensions: { podman: { image: null, readOnlyDirs: [workspace] } } } }));
  const leafGeneration = (await get(leaf.id)).generation;
  const childGeneration = (await get(child.id)).generation;
  await change("test:v3", "inherited");
  expect((await get(child.id)).generation).not.toBe(childGeneration);
  expect((await get(leaf.id)).generation).toBe(leafGeneration);
  await change("test:v4", "all");
  expect((await get(leaf.id)).settings.extensions?.podman).toMatchObject({ image: null });
  expect(runs().at(-1)).toContain("test:v4");
});

test("stale generations lose relay access; launch refuses replaced mount paths", async () => {
  const { root, workspace, dir, runs, relay, mutate } = await setup();
  const path = relay(runs()[0]!);
  const rpc = new RpcClient(path);
  expect(await rpc.request("mcp.list")).toHaveProperty("tools");
  await mutate("agent.stop", { agentId: root.id });
  await expect(rpc.request("mcp.list")).rejects.toThrow(); rpc.close();
  renameSync(workspace, join(dir, "old-workspace"));
  symlinkSync(join(dir, "outside"), workspace);
  const op = await mutate("agent.restart", { agentId: root.id });
  expect(op.status).toBe("failed"); expect(op.error?.message).toContain("changed");
});

test("a later plugin cannot bypass the container wrapper", async () => {
  // Use a stopped record to test rejection without setup's successful-root assertion.
  const { root, server, mutate } = await setup();
  server.organization.beforeLaunch(spec => ({ ...spec, command: "unsafe-host-harness" }));
  const op = await mutate("agent.restart", { agentId: root.id });
  expect(op.status).toBe("failed"); expect(op.error?.message).toContain("final Podman wrapper");
});

const volumeConfig = {
  pi: { destination: '/home/pi/.pi', description: 'Shared Pi credentials' },
  claude: { destination: '/home/pi/.claude', readOnly: true },
};

test('eligible volumes have safe discovery, explicit modes, private sessions and persistent identity pins', async () => {
  const { client, server, workspace, root, mutate, create, runs, get, volumeFile, dir } = await setup([], volumeConfig);
  await expect(server.organization.request('podman.volumes', {}, { kind: 'agent', id: root.id })).rejects.toThrow('Only clients');
  expect(await client.request<any>('podman.volumes', {})).toEqual({ volumes: [
    { name: 'claude', ...volumeConfig.claude },
    { name: 'pi', ...volumeConfig.pi, readOnly: false },
    { name: 'unrelated', readOnly: false },
  ] });
  const grants = { readWriteDirs: [workspace], readWriteVolumes: ['pi'], readOnlyVolumes: ['claude'] };
  expect((await mutate('agent.modify', { agentId: root.id, settings: { extensions: { podman: grants } } })).status).toBe('completed');
  let run = runs().at(-1)!;
  expect(run).toContain('pi:/home/pi/.pi:rw,nocopy');
  expect(run).toContain('claude:/home/pi/.claude:ro,nocopy');
  const bootstrap = JSON.parse(run[run.indexOf('--entrypoint') + 3]!);
  expect(bootstrap.volumes).toHaveLength(2);
  expect(bootstrap.volumes.find((v: any) => v.path === '/home/pi/.pi')).toMatchObject({ readOnly: false });
  expect(bootstrap.mounts.some((v: any) => v.path.includes('/sessions/'))).toBe(true);
  const child = await create(root.id, workspace, { readOnlyDirs: [workspace] });
  expect(child.status).toBe('completed');
  expect(runs().at(-1)!.includes('--volume')).toBe(false);
  expect(runs().at(-1)).toContain('test:v1'); // Image inherits, volumes do not.
  await mutate('agent.stop', { agentId: root.id });
  expect((await mutate('agent.restart', { agentId: root.id })).status).toBe('completed');
  expect((await get(root.id)).settings.extensions?.podman).toMatchObject(grants);
  const commands = readFileSync(join(dir, 'podman.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(commands.some(a => a[0] === 'volume' && a[1] === 'rm')).toBe(false);
  const records = JSON.parse(readFileSync(volumeFile, 'utf8'));
  records.pi.CreatedAt = '2026-02-01T00:00:00Z';
  writeFileSync(volumeFile, JSON.stringify(records));
  const replaced = await mutate('agent.restart', { agentId: root.id });
  expect(replaced.error?.message).toContain('identity or configuration changed');
  delete records.pi; writeFileSync(volumeFile, JSON.stringify(records));
  expect((await mutate('agent.restart', { agentId: root.id })).error?.message).toContain('missing');
}, 30_000);

test('volume delegation is exact, independent of directory grants, and fences ancestor revocation', async () => {
  const { root, workspace, mutate, client, runs, relay, create } = await setup([], volumeConfig);
  await mutate('agent.modify', { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [workspace], readWriteVolumes: ['pi'] } } } });
  const rpc = new RpcClient(relay(runs().at(-1)!));
  try {
    const call = async (name: string, args: any) => {
      const result: any = await rpc.request('mcp.call', { name, arguments: args });
      return result.isError ? toolResult(result) : client.wait(toolResult(result));
    };
    const base = { settings: { harness: 'fixture', cwd: workspace }, readOnlyDirs: [workspace] };
    const ro = await call('child_create', { ...base, readOnlyVolumes: ['pi'] });
    expect(ro.status).toBe('completed');
    const rw = await call('child_create', { ...base, readWriteVolumes: ['pi'] });
    expect(rw.status).toBe('completed');
    expect((await call('child_create', { ...base, readOnlyVolumes: ['claude'] })).error?.code).toBe('FORBIDDEN');
    const leaf = (await create(ro.agentId, workspace, { readOnlyDirs: [workspace] })).result as AgentRecord;
    expect((await call('descendant_modify', { agentId: leaf.id, readWriteVolumes: ['pi'] })).error?.code).toBe('FORBIDDEN'); // Caller RW, direct parent only RO.
    expect((await call('descendant_modify', { agentId: rw.agentId, readOnlyVolumes: [] })).status).toBe('completed'); // Revoke without dependent children.
    expect((await call('descendant_modify', { agentId: ro.agentId, readWriteVolumes: ['pi'] })).status).toBe('completed');
    expect((await call('descendant_modify', { agentId: leaf.id, readWriteVolumes: ['pi'] })).status).toBe('completed');
    const revoke = await call('descendant_modify', { agentId: ro.agentId, readOnlyVolumes: ['pi'] });
    expect(revoke.error?.message).toContain('dependent child volume');
  } finally { rpc.close(); }
  await mutate('agent.modify', { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [workspace], readOnlyVolumes: ['pi'] } } } });
  const roRpc = new RpcClient(relay(runs().at(-1)!));
  try {
    const result = toolResult(await roRpc.request('mcp.call', { name: 'child_create', arguments: { settings: { harness: 'fixture', cwd: workspace }, readOnlyDirs: [workspace], readWriteVolumes: ['pi'] } }));
    expect((await client.wait(result)).error?.code).toBe('FORBIDDEN');
  } finally { roRpc.close(); }
}, 60_000);

test('new host volumes are discovered and usable without plugin configuration or server restart', async () => {
  const { server, client, workspace, root, mutate, runs, volumeFile, dir } = await setup();
  const records = JSON.parse(readFileSync(volumeFile, 'utf8'));
  const mountpoint = join(dir, 'new-host-volume'); mkdirSync(mountpoint);
  records['my-pi-volume'] = { Name: 'my-pi-volume', Driver: 'local', Options: {}, CreatedAt: '2026-03-01', Mountpoint: mountpoint };
  writeFileSync(volumeFile, JSON.stringify(records));
  expect((await client.request<any>('podman.volumes', {})).volumes).toContainEqual({ name: 'my-pi-volume', readOnly: false });
  await expect(server.organization.request('podman.volume.configure', { name: 'my-pi-volume', destination: '/home/pi/.pi' }, { kind: 'agent', id: root.id })).rejects.toThrow('Only clients');
  const invalid = await client.request<any>('podman.volume.configure', { name: 'my-pi-volume', destination: '/usr/local/bin' }).catch(error => error);
  expect(invalid.code).toBe('FORBIDDEN');
  expect(invalid.message).toContain('protected');
  expect(await client.request<any>('podman.volume.configure', { name: 'my-pi-volume', destination: '/home/pi/.pi' })).toMatchObject({ name: 'my-pi-volume', destination: '/home/pi/.pi' });
  const result = await mutate('agent.modify', { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [workspace], readOnlyVolumes: ['my-pi-volume'] } } } });
  expect(result.status).toBe('completed');
  expect(runs().at(-1)).toContain('my-pi-volume:/home/pi/.pi:ro,nocopy');
  expect((await mutate('agent.restart', { agentId: root.id })).status).toBe('completed');
}, 30_000);

test('final launch validation rejects omitted, added or altered named-volume mounts', async () => {
  const { server, root, workspace, mutate } = await setup([], volumeConfig);
  expect((await mutate('agent.modify', { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [workspace], readWriteVolumes: ['pi'] } } } })).status).toBe('completed');
  let mode = 'omit';
  server.organization.beforeLaunch(spec => {
    const args = [...spec.args];
    const index = args.indexOf('--volume');
    if (mode === 'omit') args.splice(index, 2);
    else if (mode === 'add') args.splice(index, 0, '--volume', 'unrelated:/home/pi/.codex:rw');
    else args[index + 1] = 'pi:/home/pi/.pi:ro,nocopy';
    return { ...spec, args };
  });
  for (mode of ['omit', 'add', 'alter']) {
    const result = await mutate('agent.restart', { agentId: root.id });
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('final Podman wrapper');
  }
}, 30_000);
