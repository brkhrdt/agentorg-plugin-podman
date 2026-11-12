import { afterEach, expect, test } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrganizationServer } from '../../agentorg/src/server.ts';
import { OrganizationClient } from 'agent-organization/client';
import type { AgentRecord, Operation } from 'agent-organization/types';
import type { ServerPlugin } from 'agent-organization/plugin';
import { createPodmanPlugin } from '../src/index.ts';
import { tsxImport } from '../../agentorg/tests/runtime.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

test('Host root launches natively; its agent-created child is frozen Container and cannot choose Host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'podman-host-test-'));
  const workspace = join(dir, 'workspace'); mkdirSync(workspace);
  const log = join(dir, 'podman.log'), volumes = join(dir, 'volumes.json'), executable = join(dir, 'podman');
  writeFileSync(volumes, '{}');
  writeFileSync(executable, `#!/bin/sh\nexport FAKE_PODMAN_LOG='${log}'\nexport FAKE_PODMAN_VOLUMES='${volumes}'\nexec '${process.execPath}' '${join(dirname(fileURLToPath(import.meta.url)), 'fixtures/podman.mjs')}' "$@"\n`);
  chmodSync(executable, 0o700);
  const fixture: ServerPlugin = { apiVersion: 1, name: 'host-test-fixture', setup(host) {
    host.registerHarness({ name: 'fixture', launch: ({ agent }) => ({ command: process.execPath,
      args: ['--import', tsxImport, join(import.meta.dirname, 'fixtures/host-agent.ts')], cwd: agent.settings.cwd }) });
  } };
  const server = await OrganizationServer.start({ dataDir: join(dir, 'data'), socketPath: join(dir, 'data/server.sock'),
    plugins: [fixture, createPodmanPlugin({ podmanExecutable: executable, defaultImage: 'test:v1' })] });
  const client = await OrganizationClient.connect(server.organization.socketPath);
  cleanups.push(async () => { client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const wait = async (operation: Operation) => client.wait(operation);
  const createdRoot = await wait(await client.request<Operation>('agent.create', { settings: {
    harness: 'fixture', cwd: workspace, extensions: { podman: { executionEnvironment: 'host' } },
  } }));
  expect(createdRoot.status, createdRoot.error?.message).toBe('completed');
  const root = createdRoot.result as AgentRecord;
  const podmanLog = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
  expect(podmanLog().some(args => args[0] === 'run')).toBe(false);

  const childOp = await wait(await server.organization.request('agent.create', { parentId: root.id, settings: {
    harness: 'fixture', cwd: workspace, extensions: { podman: { readWriteDirs: [workspace] } },
  } }, { kind: 'agent', id: root.id }) as Operation);
  expect(childOp.status).toBe('completed');
  const child = childOp.result as AgentRecord;
  expect(child.settings.extensions?.podman).toMatchObject({ executionEnvironment: 'container', image: 'test:v1', imageInherited: true });
  expect(podmanLog().some(args => args[0] === 'run')).toBe(true);
  const descendantOp = await wait(await server.organization.request('agent.create', { parentId: child.id, settings: {
    harness: 'fixture', cwd: workspace, extensions: { podman: { readWriteDirs: [workspace] } },
  } }, { kind: 'agent', id: child.id }) as Operation);
  expect(descendantOp.status).toBe('completed');
  const descendant = descendantOp.result as AgentRecord;
  const propagate = async (image: string) => {
    const current = await client.request<AgentRecord>('agent.get', { agentId: child.id });
    const result = await client.request<{ errors: unknown[] }>('podman.modify', { agentId: child.id, expectedRevision: current.revision,
      imageScope: 'inherited', settings: { extensions: { podman: { ...(current.settings.extensions?.podman as object), image } } } });
    expect(result.errors).toEqual([]);
  };
  await propagate('test:v2');
  const afterFirst = await client.request<AgentRecord>('agent.get', { agentId: descendant.id });
  expect(afterFirst.settings.extensions?.podman).toMatchObject({ image: 'test:v2', imageInherited: true });
  await propagate('test:v3');
  const afterSecond = await client.request<AgentRecord>('agent.get', { agentId: descendant.id });
  expect(afterSecond.settings.extensions?.podman).toMatchObject({ image: 'test:v3', imageInherited: true });

  const forbidden = await wait(await server.organization.request('agent.create', { parentId: root.id, settings: {
    harness: 'fixture', cwd: workspace, extensions: { podman: { executionEnvironment: 'host' } },
  } }, { kind: 'agent', id: root.id }) as Operation);
  expect(forbidden.status).toBe('failed');
  expect(forbidden.error?.code).toBe('FORBIDDEN');
});
