import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "agent-organization/client";
import type { AgentRecord, Operation, ServerEvent } from "agent-organization/types";
import type { ServerPlugin, ServerSettingsView } from "agent-organization/plugin";
import { createPodmanPlugin, type PodmanPluginOptions } from "../src/index.ts";
import { RpcClient } from "../src/rpc.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "podman-server-settings-"));
  const workspace = join(dir, "workspace"); mkdirSync(workspace);
  const log = join(dir, "commands.jsonl"), alternateLog = join(dir, "alternate.jsonl");
  const volumeFile = join(dir, "volumes.json"), imageFile = join(dir, "images.json");
  writeFileSync(imageFile, JSON.stringify({
    'test:v1': 'a'.repeat(64), 'test:v2': 'b'.repeat(64), 'test:v3': 'c'.repeat(64), 'test:v4': 'd'.repeat(64),
    'explicit:v1': 'e'.repeat(64), 'custom:v3': 'f'.repeat(64), 'operator:v3': '1'.repeat(64), 'operator:v4': '2'.repeat(64),
  }));
  const records = Object.fromEntries(["pi", "extra"].map(name => {
    const mountpoint = join(dir, name); mkdirSync(mountpoint);
    return [name, { Name: name, Driver: "local", Options: {}, CreatedAt: "2026-01-01", Mountpoint: mountpoint }];
  }));
  writeFileSync(volumeFile, JSON.stringify(records));
  function executable(name: string, log: string) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nexport FAKE_PODMAN_VOLUMES='${volumeFile}'\nexport FAKE_PODMAN_IMAGES='${imageFile}'\nexport FAKE_PODMAN_LOG='${log}'\nexec '${process.execPath}' '${join(dirname(fileURLToPath(import.meta.url)), "fixtures/podman.mjs")}' "$@"\n`);
    chmodSync(path, 0o700); return path;
  }
  const podman = executable("podman", log), alternate = executable("alternate-podman", alternateLog);
  const mcpCommands: string[] = [];
  const harness: ServerPlugin = { apiVersion: 1, name: "fixture", setup(host) {
    host.registerHarness({ name: "fixture", launch(context) {
      const mcp = context.mcpServers[0]!;
      if (!('command' in mcp)) throw new Error('Expected stdio MCP helper');
      mcpCommands.push(mcp.command);
      return { command: "fixture", args: [], cwd: context.agent.settings.cwd,
        env: { ORG_PI_CONFIG: "legacy-config", PUBLIC_CONFIG: "new-config", HOST_SECRET: "not-public" } };
    } });
  } };
  let server: OrganizationServer, client: OrganizationClient;
  const defaults: PodmanPluginOptions = { podmanExecutable: podman, defaultImage: "test:v1" };
  const start = async (options: PodmanPluginOptions = {}) => {
    server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"), recover: false,
      plugins: [harness, createPodmanPlugin({ ...defaults, ...options })], limits: { startTimeoutMs: 3000, stopTimeoutMs: 1000, killTimeoutMs: 100 } });
    client = await OrganizationClient.connect(server.organization.socketPath);
  };
  const commands = (file = log): string[][] => { try { return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  const runs = (file = log) => commands(file).filter(args => args[0] === "run");
  const group = () => client.request<ServerSettingsView>("organization.settings.get", { namespace: "podman" });
  const mutate = async (method: string, params: unknown) => client.wait(await client.request<Operation>(method, params));
  const create = (parentId: string | null = null, image?: string) => mutate("agent.create", { parentId, settings: { harness: "fixture", cwd: workspace, extensions: { podman: { ...(image && { image }), readWriteDirs: [workspace] } } } });
  await start();
  cleanups.push(async () => { client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, workspace, imageFile, log, alternateLog, podman, alternate, commands, runs, mcpCommands, group, mutate, create,
    get client() { return client; }, get server() { return server; },
    async update(patch: Record<string, unknown> = {}, reset: string[] = []) {
      return client.request<ServerSettingsView>("organization.settings.update", { namespace: "podman", expectedRevision: (await group()).revision, patch, reset });
    },
    async restart(options: PodmanPluginOptions = {}) { client.close(); await server.close(); await start(options); },
  };
}
const bootstrap = (run: string[]) => JSON.parse(run[run.indexOf("--entrypoint") + 3]!);

test("Podman declares public server fields; validation/auth are authoritative and reads/saves do not probe", async () => {
  const f = await fixture();
  const group = await f.group();
  expect(group.plugin).toBe("podman"); expect(group.version).toBe(4); expect(group.revision).toBe(0);
  expect(group.fields.map(field => field.key).sort()).toEqual(Object.keys(group.defaults).sort());
  expect(group.fields.filter(field => field.effect === "restart").map(field => field.key).sort())
    .toEqual(["volumes", "podmanExecutable", "mcpExecutable", "entrypointExecutable"].sort());
  expect(group.values).toEqual(group.defaults); expect(group.effective).toEqual(group.defaults);
  expect(group.fields.find(field => field.key === 'volumes')?.deprecated).toBe(true);
  expect(group.fields.filter(field => !field.deprecated && /^(readOnly|readWrite)/.test(field.key)).map(field => field.key))
    .toEqual(['readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes']);
  expect(await f.client.request<any>('podman.defaults', {})).toEqual({ readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] });
  const snapshot: any = await f.client.request("organization.snapshot");
  expect(snapshot.capabilities.serverSettings.groups.find((g: any) => g.namespace === "podman").fields).toEqual(group.fields);
  expect(snapshot.capabilities.plugins.podman.serverSettingsNamespace).toBe("podman");
  group.values.env = ["MUTATED"]; expect((await f.group()).values.env).not.toEqual(["MUTATED"]);
  const commandCount = f.commands().length;
  const invalid = [
    { defaultImage: "--option" }, { defaultImage: "two images" }, { containerUid: 0 }, { containerGid: 65536 }, { containerUid: 1.5 },
    { network: "host" }, { env: ["invalid=name"] }, { env: ["A", "A"] }, { env: [3] },
    { podmanExecutable: "-bad" }, { mcpExecutable: "x\0y" }, { entrypointExecutable: "" },
    { readOnlyDirs: ['/same'], readWriteDirs: ['/same'] }, { readOnlyDirs: [''] },
    { readOnlyVolumes: ['pi'], readWriteVolumes: ['pi'] }, { readWriteVolumes: ['--bad'] },
    { volumes: { pi: { destination: "relative" } } }, { volumes: { pi: { destination: "/home/pi/../pi" } } },
    { volumes: { pi: { destination: "/home/pi/.pi,ro=false" } } }, { volumes: { "--bad": { destination: "/home/pi/.pi" } } },
    { volumes: { pi: { destination: "/home/pi/.pi", readOnly: "false" } } },
    { volumes: { pi: { destination: "/home/pi/.pi", apiKey: "not-allowed" } } }, { env: { API_KEY: "not-allowed" } },
  ];
  for (const patch of invalid) await expect(f.update(patch)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  for (const patch of [
    { volumes: { pi: { destination: "/usr/local/bin" } } },
    { mcpExecutable: "/home/pi/helpers/mcp", volumes: { pi: { destination: "/home/pi/helpers" } } },
  ]) await expect(f.update(patch)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("podman:") });
  expect((await f.group()).revision).toBe(0); expect(f.commands()).toHaveLength(commandCount);
  const root = (await f.create()).result as AgentRecord;
  for (const method of ["organization.settings.list", "organization.settings.get", "organization.settings.update"])
    await expect(f.server.organization.request(method, {}, { kind: "agent", id: root.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  const run = f.runs()[0]!;
  const relay = new RpcClient(run.find(arg => arg.startsWith("ORG_SOCKET="))!.slice("ORG_SOCKET=".length));
  try {
    await expect(relay.request("organization.settings.update", {})).rejects.toThrow("only MCP");
    const tools: any = await relay.request("mcp.list");
    expect(tools.tools.some((tool: any) => /settings/.test(tool.name))).toBe(false);
  } finally { relay.close(); }
  // This phase validates public configuration, not container capabilities/existence.
  const beforeSave = f.commands().length;
  expect((await f.update({ defaultImage: "locally-missing:latest" })).values.defaultImage).toBe("locally-missing:latest");
  expect(f.commands()).toHaveLength(beforeSave);
}, 15_000);

test("server defaults do not retarget assigned containers; reset restores startup defaults", async () => {
  const f = await fixture();
  const root = (await f.create()).result as AgentRecord;
  const peer = await OrganizationClient.connect(f.server.organization.socketPath);
  const events: ServerEvent[] = []; peer.onEvent(event => { if (event.type === "organization.settings.changed") events.push(event); });
  await peer.request("subscribe", { types: ["organization.settings.changed"] });
  try {
    const saved = await f.update({ defaultImage: "test:v2", network: "none", containerUid: 2000, containerGid: 2001, env: ["PUBLIC_CONFIG"] });
    expect(saved.restartRequired).toEqual([]); expect(saved.effective).toEqual(saved.values);
    expect(await peer.request<ServerSettingsView>("organization.settings.get", { namespace: "podman" })).toEqual(saved);
    expect(f.runs()).toHaveLength(1);
    expect(await f.client.request<AgentRecord>("agent.get", { agentId: root.id })).toEqual(root);
    expect(bootstrap(f.runs()[0]!).env).toMatchObject({ ORG_PI_CONFIG: "legacy-config" });
    const child = await f.create(root.id); expect(child.status).toBe("completed");
    const run = f.runs().at(-1)!;
    // Existing root assignment is frozen; server defaults affect only explicit reselection/new root assignments.
    expect(run).toContain("test:v1"); expect(run[run.indexOf("--network") + 1]).toBe("pasta");
    expect(run).toContain("--userns=keep-id:uid=1000,gid=1000"); expect(run[run.indexOf("--user") + 1]).toBe("1000:1000");
    expect(bootstrap(run).env.PUBLIC_CONFIG).toBeUndefined();
    expect(bootstrap(run).env.ORG_PI_CONFIG).toBe("legacy-config"); expect(bootstrap(run).env.HOST_SECRET).toBeUndefined();
    expect((await f.create(root.id, "explicit:v1")).status).toBe("completed"); expect(f.runs().at(-1)).toContain("explicit:v1");
    const revision = saved.revision;
    await expect(peer.request("organization.settings.update", { namespace: "podman", expectedRevision: 0, patch: { network: "pasta" } })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await f.update({ network: "none" })).revision).toBe(revision); // No-op save.
    expect((await f.update({}, ["defaultImage", "network", "containerUid", "containerGid", "env"])).overridden).toEqual([]);
    expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed");
    const resetRun = f.runs().at(-1)!;
    expect(resetRun).toContain("test:v1"); expect(resetRun).toContain("--userns=keep-id:uid=1000,gid=1000");
    expect(resetRun[resetRun.indexOf("--network") + 1]).toBe("pasta");
    expect(bootstrap(resetRun).env.ORG_PI_CONFIG).toBe("legacy-config"); expect(bootstrap(resetRun).env.PUBLIC_CONFIG).toBeUndefined();
    expect(events).toHaveLength(2); expect(JSON.stringify(events)).not.toContain("test:v2");
  } finally { peer.close(); }
}, 15_000);

test('four grant defaults are durable, detached, future-draft-only, and reset without revoking grants', async () => {
  const f = await fixture(), directory = join(f.dir, 'config'); mkdirSync(directory);
  await f.client.request('podman.volume.configure', { name: 'pi', destination: '/home/pi/.pi' });
  await f.client.request('podman.volume.configure', { name: 'extra', destination: '/home/pi/extra' });
  const defaults = { readOnlyDirs: [directory], readWriteDirs: [f.workspace], readOnlyVolumes: ['pi'], readWriteVolumes: ['extra'] };
  const group = await f.update(defaults); expect(group.restartRequired).toEqual([]); expect(group.effective).toMatchObject(defaults);
  expect(group.fields.find(field => field.key === 'containers')!.itemDefaultsFrom).toMatchObject(Object.fromEntries(Object.keys(defaults).map(key => [key, key])));
  const copy = await f.client.request<any>('podman.defaults', {}); copy.readOnlyVolumes.push('not-saved');
  expect(await f.client.request<any>('podman.defaults', {})).toEqual(defaults);
  // Raw API/agent callers still supply explicit grants; defaults never silently enlarge their authority.
  const root = (await f.create()).result as AgentRecord;
  expect(root.settings.extensions?.podman).toMatchObject({ readOnlyDirs: [], readWriteDirs: [f.workspace], readOnlyVolumes: [], readWriteVolumes: [] });
  await f.update({ readOnlyVolumes: [] }); expect(await f.client.request<AgentRecord>('agent.get', { agentId: root.id })).toEqual(root);
  await f.restart(); expect(await f.client.request<any>('podman.defaults', {})).toEqual({ ...defaults, readOnlyVolumes: [] });
  await f.update({}, Object.keys(defaults));
  expect(await f.client.request<any>('podman.defaults', {})).toEqual({ readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] });
}, 15_000);

test("restart-only paths and volume defaults persist over module defaults and stay effective until reopening", async () => {
  const f = await fixture();
  const root = (await f.create()).result as AgentRecord;
  const pending = await f.update({ defaultImage: "test:v2", podmanExecutable: f.alternate, mcpExecutable: "/opt/agentorg/mcp", entrypointExecutable: "/opt/agentorg/gate",
    volumes: { pi: { destination: "/home/pi/.pi", readOnly: true }, extra: { destination: "/home/pi/.extra" } } });
  expect(pending.restartRequired.sort()).toEqual(["podmanExecutable", "mcpExecutable", "entrypointExecutable", "volumes"].sort());
  expect((pending.values.volumes as any).extra.readOnly).toBe(false); // Normalized before persistence.
  expect(pending.effective.volumes).toEqual({}); expect(pending.effective.podmanExecutable).toBe(f.podman);
  expect((await f.client.request<any>("podman.volumes", {})).volumes.find((v: any) => v.name === "pi").destination).toBeUndefined();
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed");
  expect(f.runs().at(-1)).toContain("test:v1"); expect(f.runs().at(-1)![f.runs().at(-1)!.indexOf("--entrypoint") + 1]).toBe("/usr/local/bin/agentorg-podman-exec");
  expect(f.mcpCommands.at(-1)).toBe("/usr/local/bin/agentorg-podman-mcp"); expect(f.commands(f.alternateLog)).toEqual([]);
  await f.restart({ defaultImage: "operator:v3" });
  const reopened = await f.group();
  expect(reopened.revision).toBe(pending.revision); expect(reopened.restartRequired).toEqual([]);
  expect(reopened.effective).toEqual(reopened.values); expect(reopened.values.defaultImage).toBe("test:v2"); expect(reopened.defaults.defaultImage).toBe("operator:v3");
  expect(f.commands(f.alternateLog)[0]![0]).toBe("info");
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed");
  const run = f.runs(f.alternateLog).at(-1)!;
  expect(run).toContain("test:v1"); expect(run[run.indexOf("--entrypoint") + 1]).toBe("/opt/agentorg/gate"); expect(f.mcpCommands.at(-1)).toBe("/opt/agentorg/mcp");
  const granted = await f.mutate("agent.modify", { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [f.workspace], readOnlyVolumes: ["pi"] } } } });
  expect(granted.status).toBe("completed"); expect(f.runs(f.alternateLog).at(-1)).toContain("pi:/home/pi/.pi:ro,nocopy");
  await f.update({ volumes: { pi: { destination: "/home/pi/.pi", readOnly: true } } }, ["defaultImage", "podmanExecutable", "mcpExecutable", "entrypointExecutable"]);
  await f.restart({ defaultImage: "operator:v3" });
  const choices = (await f.client.request<any>("podman.volumes", {})).volumes;
  expect(choices.find((v: any) => v.name === "pi")).toMatchObject({ destination: "/home/pi/.pi", readOnly: true });
  expect(choices.find((v: any) => v.name === "extra").destination).toBeUndefined();
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed"); expect(f.runs().at(-1)).toContain("test:v1");
  const escalation = await f.mutate("agent.modify", { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [f.workspace], readWriteVolumes: ["pi"] } } } });
  expect(escalation.error?.message).toContain("only read-only");
  expect([...f.commands(), ...f.commands(f.alternateLog)].some(args => args[0] === "volume" && args[1] === "rm")).toBe(false);
  // Reset removes the override durably, not a copy of the previous module default.
  await f.restart({ defaultImage: "operator:v4" }); expect((await f.group()).values.defaultImage).toBe("operator:v4");
}, 25_000);

test("named configurations validate local images, persist, and snapshot runtime/grants into agents independently of later catalog edits", async () => {
  const f = await fixture();
  await f.client.request('podman.volume.configure', { name: 'pi', destination: '/home/pi/.pi' });
  const defaults = (await f.group()).fields.find(field => field.key === 'containers')!.itemDefaults!;
  const profile = { ...defaults, id: 'coding', name: 'Coding', image: 'test:v1', network: 'none', containerUid: 2200, containerGid: 2201,
    cwd: f.workspace, env: defaults.env as string[], readWriteDirs: [f.workspace], readOnlyVolumes: ['pi'] };
  const before = (await f.group()).revision;
  await expect(f.update({ containers: [{ ...profile, image: 'missing:latest' }] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect((await f.group()).revision).toBe(before);
  await expect(f.update({ containers: [{ ...profile, env: { TOKEN: 'not-allowed' } }] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(f.update({ containers: [profile, profile] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(f.update({ containers: [{ ...profile, id: 'default' }] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  const saved = await f.update({ containers: [profile] });
  const catalog = await f.client.request<any>('podman.profiles', {});
  expect(catalog.revision).toBe(saved.revision);
  expect(catalog.profiles).toEqual([{ id: 'default', name: 'Default', image: 'test:v1', network: 'pasta', containerUid: 1000, containerGid: 1000,
    env: ['ORG_PI_CONFIG', 'ORG_PI_MCP_SERVERS', 'ORG_PI_EXTENSION', 'AGENTORG_SKILL_FILES'], cwd: '', readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] }, profile]);
  const createFrom = (parentId: string | null, selected: typeof profile, revision: number) => f.mutate('agent.create', { parentId,
    settings: { harness: 'fixture', cwd: f.workspace, extensions: { podman: {
      image: selected.image, readWriteDirs: [f.workspace], profile: { id: selected.id, name: selected.name, revision },
      runtime: { network: selected.network, containerUid: selected.containerUid, containerGid: selected.containerGid, env: selected.env },
    } } } });
  const creation = await createFrom(null, profile, saved.revision); expect(creation.status).toBe('completed');
  const root = creation.result as AgentRecord;
  expect(root.settings.extensions?.podman).toMatchObject({ image: 'test:v1', imageInherited: false });
  expect(f.runs()[0]).toContain('test:v1'); expect(f.runs()[0]).toContain('--userns=keep-id:uid=2200,gid=2201');
  expect(f.runs()[0]![f.runs()[0]!.indexOf('--network') + 1]).toBe('none');
  const changed = { ...profile, image: 'test:v2', network: 'pasta', containerUid: 3300, containerGid: 3301 };
  const updated = await f.update({ containers: [changed] });
  expect(await f.client.request<AgentRecord>('agent.get', { agentId: root.id })).toEqual(root);
  expect((await createFrom(root.id, profile, saved.revision)).error?.code).toBe('CONFLICT');
  expect((await createFrom(root.id, changed, updated.revision)).status).toBe('completed');
  expect(f.runs().at(-1)).toContain('test:v2'); expect(f.runs().at(-1)).toContain('--userns=keep-id:uid=3300,gid=3301');
  await f.update({ containers: [] });
  expect((await f.mutate('agent.restart', { agentId: root.id })).status).toBe('completed');
  expect(f.runs().at(-1)).toContain('test:v1'); expect(f.runs().at(-1)).toContain('--userns=keep-id:uid=2200,gid=2201');
  // Children inherit the selected container's configured mounts even without requesting them.
  expect((await f.create(root.id)).status).toBe('completed');
  expect(f.runs().at(-1)).toContain('--userns=keep-id:uid=2200,gid=2201');
  expect(f.runs().at(-1)).toContain('pi:/home/pi/.pi:ro,nocopy');
  for (const method of ['podman.profiles', 'podman.choices.images', 'podman.choices.volumes.ro', 'podman.choices.volumes.defaults', 'podman.defaults'])
    await expect(f.server.organization.request(method, {}, { kind: 'agent', id: root.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await f.restart(); expect((await f.group()).values.containers).toEqual([]);
}, 25_000);

test.each([1, 2])("version-%i settings migrate additively without losing operator overrides", async version => {
  const f = await fixture();
  const policy = { pi: { destination: '/home/pi/.pi', readOnly: false } };
  await f.update({ network: 'none', volumes: policy });
  await f.client.request('podman.volume.configure', { name: 'pi', destination: '/home/pi/.pi' });
  const record = f.server.organization.store.serverSettings('podman')!;
  f.server.organization.store.saveServerSettings({ ...record, version });
  await f.restart();
  const migrated = await f.group();
  expect(migrated.version).toBe(4); expect(migrated.revision).toBe(record.revision + 1);
  expect(migrated.values.network).toBe('none'); expect(migrated.values.containers).toEqual([]); expect(migrated.values.volumes).toEqual(policy);
  expect(await f.client.request<any>('podman.defaults', {})).toEqual({ readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] });
  expect((await f.client.request<any>('podman.volumes', {})).volumes.find((v: any) => v.name === 'pi').destination).toBe('/home/pi/.pi');
}, 15_000);

test("missing image references fail at launch without pulling or creating an image", async () => {
  const f = await fixture();
  const failed = await f.create(null, 'missing:v1');
  expect(failed.status).toBe('failed');
  expect(f.runs().at(-1)).toContain('--pull=never');
  expect(f.runs().at(-1)).toContain('missing:v1');
  expect(f.commands().some(args => args[0] === 'pull' || args[0] === 'image' && args[1] === 'build')).toBe(false);
}, 15_000);

test("same-tag rebuilds preserve references and launch the current local image", async () => {
  const f = await fixture();
  const created = await f.create(null, 'test:v1'); expect(created.status).toBe('completed');
  const root = created.result as AgentRecord;
  expect(f.runs().at(-1)).toContain('test:v1');
  writeFileSync(f.imageFile, JSON.stringify({ 'test:v1': '9'.repeat(64), 'test:v2': 'b'.repeat(64) }));
  expect((await f.mutate('agent.restart', { agentId: root.id })).status).toBe('completed');
  expect(f.runs().at(-1)).toContain('test:v1');
  expect(f.runs().at(-1)).not.toContain('9'.repeat(64));
  await f.restart();
  expect((await f.mutate('agent.restart', { agentId: root.id })).status).toBe('completed');
  expect(f.runs().at(-1)).toContain('test:v1');
  expect((await f.client.request<AgentRecord>('agent.get', { agentId: root.id })).settings.extensions?.podman).toMatchObject({ image: 'test:v1' });
}, 15_000);

test("option catalogs contain public local image tags and exact eligible volume/network choices", async () => {
  const f = await fixture();
  const images = await f.client.request<any>('podman.choices.images', {});
  expect(images.choices.map((choice: any) => choice.value)).toEqual(['alias:v1', 'custom:v3', 'explicit:v1', 'operator:v3', 'operator:v4', 'test:v1', 'test:v2', 'test:v3', 'test:v4']);
  expect(JSON.stringify(images)).not.toContain('DO-NOT-EXPOSE');
  expect(JSON.stringify(images)).not.toContain('9999999999999999');
  const defaultOptions = await f.client.request<any>('podman.choices.volumes.defaults', {});
  expect(defaultOptions.choices.find((v: any) => v.value === 'pi')).toEqual({ value: 'pi', label: 'pi → (choose container destination)', defaults: { destination: '', readOnly: false, description: '' } });
  expect(JSON.stringify(defaultOptions)).not.toContain(f.dir);
  expect((await f.group()).values.volumes).toEqual({}); // Discovery never writes defaults or registrations.
  await f.client.request('podman.volume.configure', { name: 'pi', destination: '/home/pi/.pi' });
  expect((await f.client.request<any>('podman.choices.volumes.defaults', {})).choices.find((v: any) => v.value === 'pi').defaults.destination).toBe('/home/pi/.pi');
  const volumes = await f.client.request<any>('podman.choices.volumes.ro', {});
  expect(volumes.choices.find((v: any) => v.value === 'pi').label).toBe('pi → /home/pi/.pi');
  expect(JSON.stringify(volumes)).not.toContain(f.dir);
  const network = (await f.group()).fields.find(field => field.key === 'network')!;
  expect(network.choices).toEqual(['slirp4netns', 'pasta', 'none']);
}, 15_000);

test("image-scope orchestration preserves frozen descendant assignments", async () => {
  const f = await fixture();
  const root = (await f.create()).result as AgentRecord;
  await f.update({ defaultImage: "test:v2" });
  const child = (await f.create(root.id)).result as AgentRecord;
  expect(f.runs().at(-1)).toContain("test:v1");
  const result = await f.client.request<{ errors: unknown[] }>("podman.modify", {
    agentId: root.id, expectedRevision: root.revision, imageScope: "node",
    settings: { extensions: { podman: { ...root.settings.extensions?.podman as object, image: "custom:v3" } } },
  });
  expect(result.errors).toEqual([]);
  expect((await f.client.request<AgentRecord>("agent.get", { agentId: child.id })).settings.extensions?.podman).toMatchObject({ image: "test:v1", imageInherited: false });
  expect(f.runs().at(-1)).toContain("custom:v3");
}, 15_000);

test("operator volume policy changes only take effect in a new process; client mappings are not recovered", async () => {
  const f = await fixture();
  await f.update({ volumes: { pi: { destination: "/home/pi/.pi" } } }); await f.restart();
  const root = (await f.create()).result as AgentRecord;
  expect((await f.mutate("agent.modify", { agentId: root.id, settings: { extensions: { podman: { readWriteDirs: [f.workspace], readOnlyVolumes: ["pi"] } } } })).status).toBe("completed");
  await f.update({ volumes: { pi: { destination: "/home/pi/redirected" } } });
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed"); // Effective policy still unchanged.
  await f.restart();
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed");
  expect(f.runs().at(-1)).toContain("pi:/home/pi/redirected:ro,nocopy");
  await f.restart();
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed");
  expect(f.runs().at(-1)).toContain("pi:/home/pi/redirected:ro,nocopy");
  await f.update({}, ["volumes"]); await f.restart();
  expect((await f.mutate("agent.restart", { agentId: root.id })).error?.message).toContain("Choose a container destination");
  await f.client.request("podman.volume.configure", { name: "pi", destination: "/home/pi/.pi" });
  expect((await f.mutate("agent.restart", { agentId: root.id })).status).toBe("completed");
  expect(f.runs().at(-1)).toContain("pi:/home/pi/.pi:ro,nocopy");
}, 20_000);
