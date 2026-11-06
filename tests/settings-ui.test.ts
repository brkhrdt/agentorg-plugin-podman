import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "agent-organization/client";
import type { ServerSettingsView, ServerPlugin } from "agent-organization/plugin";
import type { AgentRecord } from 'agent-organization/types';
import { createPodmanPlugin } from "../src/index.ts";

// Optional cross-repository integration: normal plugin checks/tests do not depend
// on the TUI installation. Its helper runs a real terminal client, not a mock UI.
interface TerminalClient {
  keys(text: string): void;
  visible(text: string): Promise<void>;
  close(): Promise<void>;
}
async function podmanGroupDownCount(client: OrganizationClient): Promise<number> {
  const catalog = await client.request<{ groups: Array<{ namespace: string }> }>('organization.settings.list', {});
  const index = catalog.groups.findIndex(group => group.namespace === 'podman');
  if (index < 0) throw new Error('Podman server-settings group is missing from the catalog');
  // The menu's first row is read-only Organization facts; plugin groups follow catalog order.
  return index + 1;
}
test.skipIf(process.env.ORG_PODMAN_TUI_TEST !== "1")("real TUI creates a named configuration with discovered image/volume choices, then selects it to create an isolated agent", async () => {
  const modulePath: string = '../../agentorg-tui/tests/terminal.ts';
  const { terminalClient } = await import(modulePath) as { terminalClient(socket: string, directory: string): TerminalClient };
  const dir = mkdtempSync(join(tmpdir(), 'podman-profile-ui-'));
  const workspace = join(dir, 'workspace'), volume = join(dir, 'volume'); mkdirSync(workspace); mkdirSync(volume);
  const volumeFile = join(dir, 'volumes.json'), imageFile = join(dir, 'images.json'), log = join(dir, 'commands.jsonl'), executable = join(dir, 'podman');
  writeFileSync(volumeFile, JSON.stringify({ pi: { Name: 'pi', Driver: 'local', Options: {}, CreatedAt: '2026-01-01', Mountpoint: volume } }));
  writeFileSync(imageFile, JSON.stringify({ 'test:v1': 'a'.repeat(64) }));
  writeFileSync(executable, `#!/bin/sh\nexport FAKE_PODMAN_LOG='${log}'\nexport FAKE_PODMAN_IMAGES='${imageFile}'\nexport FAKE_PODMAN_VOLUMES='${volumeFile}'\nexec '${process.execPath}' '${join(dirname(fileURLToPath(import.meta.url)), 'fixtures/podman.mjs')}' "$@"\n`); chmodSync(executable, 0o700);
  const harness: ServerPlugin = { apiVersion: 1, name: 'fixture', setup(host) {
    host.registerHarness({ name: 'fixture', launch: ({ agent }) => ({ command: 'fixture', args: [], cwd: agent.settings.cwd }) });
  } };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined, ui: TerminalClient | undefined;
  try {
    const dataDir = join(dir, 'data');
    server = await OrganizationServer.start({ dataDir, socketPath: join(dataDir, 'server.sock'), plugins: [harness, createPodmanPlugin({ podmanExecutable: executable })], limits: { startTimeoutMs: 3000, stopTimeoutMs: 1000, killTimeoutMs: 100 } });
    client = await OrganizationClient.connect(server.organization.socketPath);
    const group = () => client!.request<ServerSettingsView>('organization.settings.get', { namespace: 'podman' });
    ui = terminalClient(server.organization.socketPath, dir); const { keys, visible } = ui;
    await visible('connected'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Podman containers · shared server settings');
    keys('\x1b[B'.repeat(await podmanGroupDownCount(client!)) + '\r'); await visible('Podman containers · server-wide'); keys('\x1b[B'.repeat(12) + '\r'); await visible('No configurations. Press a to add.');
    keys('a'); await visible('Container configurations: New container'); keys('\r'); await visible('Name · text'); keys('\x15Coding\r'); await visible('Name: Coding · edited draft');
    keys('\x1b[B\r'); await visible('Image · select an available option'); await visible('test:v1'); keys('\x1b[B\r'); await visible('Image: test:v1 · edited draft');
    keys('\x1b[B\r'); await visible('Network · select an available option'); keys('\x1b[B\x1b[B\r'); await visible('Network: none · edited draft');
    keys('\x1b[B'.repeat(3) + '\r'); await visible('Default working directory · text'); keys('\x15' + workspace + '\r'); await visible('Default working directory:');
    keys('\x1b[B\x1b[B\r'); await visible('Edit Read/write directory defaults'); keys('J'); await visible('advanced JSON'); keys('\x15' + JSON.stringify([workspace]) + '\r');
    await visible('Edit Read/write directory defaults'); keys('S'); await visible('Read/write directory defaults: [1 entries');
    keys('\x1b[B\r'); await visible('Edit Read-only volumes'); keys('a'); await visible('Read-only volumes · select an available option'); await visible('pi → (choose container destination)'); keys('\r'); await visible('Container destination for pi'); keys('/home/pi/.pi\r');
    await visible('Edit Read-only volumes'); keys('S'); await visible('Read-only volumes: [1 entries');
    keys('S'); await visible('named configurations'); keys('S'); await visible('Container configurations: [1 entries; edit to inspect] · edited draft');
    expect((await group()).revision).toBe(0); keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server');
    expect((await group()).values.containers).toHaveLength(1);
    keys('\x1b'); await visible('shared by all clients'); keys('\x1b'); await visible('CLIENT ONLY'); keys('\x1b'); await visible('LATEST TRACKED EVENT');
    keys('n'); await visible('Create agent · root'); keys('\x1b[B'.repeat(9) + '\r'); await visible('Container · select an available option'); await visible('Coding · test:v1 · none');
    keys('\x1b[B\r'); await visible('Create agent · root'); keys('S'); await visible('LATEST TRACKED EVENT');
    const state = await client.request<{ agents: AgentRecord[] }>('organization.snapshot'); const root = state.agents[0]!;
    expect(root.state).toBe('idle'); expect(root.settings.cwd).toBe(workspace);
    expect(root.settings.extensions?.podman).toMatchObject({ image: 'test:v1', runtime: { network: 'none' }, profile: { name: 'Coding' }, readOnlyVolumes: ['pi'], readWriteDirs: [workspace] });
    const run = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]).find(args => args[0] === 'run')!;
    expect(run).toContain('test:v1'); expect(run[run.indexOf('--network') + 1]).toBe('none'); expect(run).toContain('pi:/home/pi/.pi:ro,nocopy');
    const saved = await group(); await client.request('organization.settings.update', { namespace: 'podman', expectedRevision: saved.revision, patch: { containers: [] } });
    expect((await client.request<AgentRecord>('agent.get', { agentId: root.id })).generation).toBe(root.generation);
  } finally { await ui?.close(); client?.close(); await server?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(process.env.ORG_PODMAN_TUI_TEST !== '1')('four default RO/RW lists seed new configurations and new agent drafts, without changing existing agents or creating pin files', async () => {
  const modulePath: string = '../../agentorg-tui/tests/terminal.ts';
  const { terminalClient } = await import(modulePath) as { terminalClient(socket: string, directory: string): TerminalClient };
  const dir = mkdtempSync(join(tmpdir(), 'podman-default-grants-ui-'));
  const workspace = join(dir, 'workspace'), readonly = join(dir, 'readonly'); mkdirSync(workspace); mkdirSync(readonly);
  const volumeFile = join(dir, 'volumes.json'), log = join(dir, 'commands.jsonl'), executable = join(dir, 'podman');
  const records = Object.fromEntries(['extra', 'pi'].map(name => { const mountpoint = join(dir, name); mkdirSync(mountpoint);
    return [name, { Name: name, Driver: 'local', Options: {}, CreatedAt: '2026-01-01', Mountpoint: mountpoint }]; }));
  writeFileSync(volumeFile, JSON.stringify(records));
  writeFileSync(executable, `#!/bin/sh\nexport FAKE_PODMAN_LOG='${log}'\nexport FAKE_PODMAN_VOLUMES='${volumeFile}'\nexec '${process.execPath}' '${join(dirname(fileURLToPath(import.meta.url)), 'fixtures/podman.mjs')}' "$@"\n`); chmodSync(executable, 0o700);
  const harness: ServerPlugin = { apiVersion: 1, name: 'fixture', setup(host) {
    host.registerHarness({ name: 'fixture', launch: ({ agent }) => ({ command: 'fixture', args: [], cwd: agent.settings.cwd }) });
  } };
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined, ui: TerminalClient | undefined;
  try {
    const dataDir = join(dir, 'data');
    server = await OrganizationServer.start({ dataDir, socketPath: join(dataDir, 'server.sock'), plugins: [harness, createPodmanPlugin({ podmanExecutable: executable })] });
    client = await OrganizationClient.connect(server.organization.socketPath);
    const group = () => client!.request<ServerSettingsView>('organization.settings.get', { namespace: 'podman' });
    ui = terminalClient(server.organization.socketPath, dir); const { keys, visible } = ui;
    await visible('connected'); keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Podman containers · shared server settings');
    keys('\x1b[B'.repeat(await podmanGroupDownCount(client!)) + '\r'); await visible('Podman containers · server-wide'); keys('\x1b[B'.repeat(5) + '\r');
    await visible('Edit Read-only directory defaults'); keys('J'); await visible('advanced JSON'); keys('\x15' + JSON.stringify([readonly]) + '\r'); await visible('Edit Read-only directory defaults'); keys('S');
    await visible('Read-only directory defaults: [1 entries'); keys('\x1b[B\r'); await visible('Edit Read/write directory defaults'); keys('J'); await visible('advanced JSON'); keys('\x15' + JSON.stringify([workspace]) + '\r'); await visible('Edit Read/write directory defaults'); keys('S');
    await visible('Read/write directory defaults: [1 entries'); keys('\x1b[B\r'); await visible('Edit Read-only volumes'); keys('a'); await visible('Read-only volumes · select an available option'); await visible('pi → (choose container destination)'); keys('\x1b[B\r'); await visible('Container destination for pi'); keys('/home/pi/.pi\r'); await visible('Edit Read-only volumes'); keys('S');
    await visible('Read-only volumes: [1 entries'); keys('\x1b[B\r'); await visible('Edit Read/write volumes'); keys('a'); await visible('Read/write volumes · select an available option'); await visible('extra → (choose container destination)'); keys('\r'); await visible('Container destination for extra'); keys('/home/pi/extra\r'); await visible('Edit Read/write volumes'); keys('S');
    await visible('Read/write volumes: [1 entries'); expect((await group()).revision).toBe(0); keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server · no agents restarted');
    const defaults = { readOnlyDirs: [readonly], readWriteDirs: [workspace], readOnlyVolumes: ['pi'], readWriteVolumes: ['extra'] };
    expect((await group()).effective).toMatchObject(defaults); expect((await group()).restartRequired).toEqual([]);
    keys('\x1b[B'.repeat(12) + '\r'); await visible('No configurations. Press a to add.'); keys('a'); await visible('Container configurations: New container');
    await visible('Read-only volumes: [1 entries'); await visible('Read/write volumes: [1 entries'); await visible('Read/write directory defaults: [1 entries');
    keys('\x1b'); await visible('Container configurations · named configurations'); keys('\x1b'); await visible('Podman containers · server-wide'); keys('\x1b'); await visible('shared by all clients'); keys('\x1b'); await visible('CLIENT ONLY'); keys('\x1b'); await visible('LATEST TRACKED EVENT');
    keys('n'); await visible('Create agent · root'); keys('\x1b[B'.repeat(4) + '\r'); await visible('Edit cwd'); keys('\x15' + workspace + '\r'); await visible('Create agent · root'); keys('S'); await visible('LATEST TRACKED EVENT');
    const root = (await client.request<{ agents: AgentRecord[] }>('organization.snapshot')).agents[0]!;
    expect(root.state).toBe('idle'); expect(root.settings.extensions?.podman).toMatchObject(defaults);
    keys('v'); await visible('CLIENT ONLY'); keys('s'); await visible('Podman containers · shared server settings'); keys('\x1b[B'.repeat(await podmanGroupDownCount(client!)) + '\r'); await visible('Podman containers · server-wide');
    keys('\x1b[B'.repeat(5) + 'z\x1b[Bz\x1b[Bz\x1b[Bz'); await visible('Read/write volumes: [0 entries; edit to inspect] · reset draft'); keys('S'); await visible('Confirm server-wide'); keys('y'); await visible('Saved on server');
    expect(await client.request<any>('podman.defaults', {})).toEqual({ readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] });
    expect(await client.request<AgentRecord>('agent.get', { agentId: root.id })).toMatchObject({ id: root.id, generation: root.generation, revision: root.revision, settings: root.settings });
    expect(existsSync(join(dataDir, 'podman-volume-pins.json'))).toBe(false);
    expect(JSON.parse(readFileSync(volumeFile, 'utf8'))).toEqual(records); expect(existsSync(join(dir, 'config.json'))).toBe(false);
  } finally { await ui?.close(); client?.close(); await server?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test.skipIf(process.env.ORG_PODMAN_TUI_TEST !== "1")("real TUI discovers Podman fields and confirms saves, collection deletion and resets", async () => {
  const modulePath: string = "../../agentorg-tui/tests/terminal.ts";
  const { terminalClient } = await import(modulePath) as { terminalClient(socket: string, directory: string): TerminalClient };
  const dir = mkdtempSync(join(tmpdir(), "podman-settings-ui-"));
  const executable = join(dir, "podman");
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = info ]; then printf \'%s\\n\' \'{"host":{"security":{"rootless":true}},"store":{}}\'; fi\n');
  chmodSync(executable, 0o700);
  const dataDir = join(dir, "data"); mkdirSync(dataDir);
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined, ui: TerminalClient | undefined;
  try {
    server = await OrganizationServer.start({ dataDir, socketPath: join(dataDir, "server.sock"), plugins: [createPodmanPlugin({ podmanExecutable: executable,
      volumes: { pi: { destination: "/home/pi/.pi", readOnly: true } } })] });
    client = await OrganizationClient.connect(server.organization.socketPath);
    const group = () => client!.request<ServerSettingsView>("organization.settings.get", { namespace: "podman" });
    ui = terminalClient(server.organization.socketPath, dir);
    const { keys, visible } = ui;
    await visible("connected"); keys("v"); await visible("CLIENT ONLY"); keys("s");
    await visible("Podman containers · shared server settings");
    keys("\x1b[B".repeat(await podmanGroupDownCount(client!)) + "\r"); await visible("Podman containers · server-wide · revision 0");
    keys("\x1b[B\r"); await visible("Network · select an available option");
    keys("\x1b[B\x1b[B\r"); await visible("Network: none · edited draft"); expect((await group()).revision).toBe(0);
    keys("S"); await visible("Confirm server-wide"); expect((await group()).revision).toBe(0);
    keys("y"); await visible("revision 1"); expect((await group()).effective.network).toBe("none");
    keys("\x1b[B".repeat(5) + "\r"); await visible("Edit Read-only directory defaults");
    keys('J'); await visible('advanced JSON'); keys('\x15["/public"]\r'); await visible('Edit Read-only directory defaults'); keys('S'); await visible('[1 entries; edit to inspect] · edited draft');
    keys("S"); await visible("Confirm server-wide"); keys("y"); await visible("revision 2");
    expect((await group()).effective.readOnlyDirs).toEqual(['/public']);
    keys("\x1b[B".repeat(5) + "z"); await visible("[0 entries; edit to inspect] · reset draft");
    keys("S"); await visible("Confirm server-wide"); keys("y"); await visible("revision 3");
    expect((await group()).restartRequired).toEqual([]); expect((await group()).overridden).toEqual(["network"]);
    keys("\x1b[B".repeat(4) + "\r"); await visible("Edit Environment variables");
    keys("d"); await visible("ORG_PI_MCP_SERVERS"); keys("S"); await visible("[3 entries; edit to inspect] · edited draft");
    keys("S"); await visible("Confirm server-wide"); keys("y"); await visible("revision 4");
    expect((await group()).effective.env).toEqual(["ORG_PI_MCP_SERVERS", "ORG_PI_EXTENSION", "AGENTORG_SKILL_FILES"]);
    expect(existsSync(join(dir, "config.json"))).toBe(false); // Server configuration is not a client preference.
  } finally { await ui?.close(); client?.close(); await server?.close(); rmSync(dir, { recursive: true, force: true }); }
}, 25_000);
