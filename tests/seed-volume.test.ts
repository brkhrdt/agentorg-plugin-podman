import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const examples = join(dirname(fileURLToPath(import.meta.url)), '../examples'), helper = join(examples, 'seed-pi-config.mjs');
const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'minimal-pi-seed-')); cleanup.push(dir);
  const source = join(dir, 'source'), target = join(dir, 'target'); mkdirSync(join(source, 'agent'), { recursive: true }); mkdirSync(target);
  const auth = '{"test-provider":{"type":"api_key","key":"TEST-SECRET-DO-NOT-PRINT"}}\n';
  writeFileSync(join(source, 'agent/auth.json'), auth);
  writeFileSync(join(source, 'agent/settings.json'), JSON.stringify({
    defaultProvider: 'test-provider', defaultModel: 'test-model', defaultThinkingLevel: 'high', enabledModels: ['test-provider/*'],
    transport: 'sse', compaction: { enabled: true, reserveTokens: 1234, hostPath: '/private/host' },
    retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 100, bad: 'secret' } },
    packages: ['npm:untrusted'], extensions: ['/host/extension.ts'], skills: ['/host/skills'], themes: ['host-theme'], prompts: ['/host/prompts'],
    shellCommandPrefix: 'untrusted-command', shellPath: '/host/shell', sessionDir: '/host/sessions',
    httpProxy: 'https://user:TEST-PASSWORD@proxy/', unknownFutureField: { token: 'TEST-SECRET-DO-NOT-PRINT' },
  }));
  for (const file of ['models.json', 'models-store.json', 'trust.json', 'mcp.json', 'AGENTS.md']) writeFileSync(join(source, 'agent', file), 'not copied');
  for (const folder of ['sessions', 'extensions', 'skills', 'npm', 'cache']) { mkdirSync(join(source, 'agent', folder)); writeFileSync(join(source, 'agent', folder, 'private'), 'not copied'); }
  writeFileSync(join(source, 'todo.db'), 'not copied');
  const run = () => spawnSync(process.execPath, [helper, source, target], { encoding: 'utf8', timeout: 5000 });
  return { dir, source, target, auth, run };
}

test('minimal Pi seed copies exact auth plus portable settings, excludes host code/data and uses private permissions', () => {
  const f = fixture(), result = f.run(); expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('TEST-SECRET'); expect(result.stdout + result.stderr).not.toContain('TEST-PASSWORD');
  expect(readdirSync(f.target).sort()).toEqual(['.agentorg-seeded', 'agent']);
  expect(readdirSync(join(f.target, 'agent')).sort()).toEqual(['auth.json', 'settings.json']);
  expect(readFileSync(join(f.target, 'agent/auth.json'), 'utf8')).toBe(f.auth);
  expect(JSON.parse(readFileSync(join(f.target, 'agent/settings.json'), 'utf8'))).toEqual({
    defaultProvider: 'test-provider', defaultModel: 'test-model', defaultThinkingLevel: 'high', enabledModels: ['test-provider/*'], transport: 'sse',
    compaction: { enabled: true, reserveTokens: 1234 }, retry: { enabled: true, maxRetries: 2, provider: { timeoutMs: 100 } },
  });
  expect(statSync(f.target).mode & 0o777).toBe(0o700); expect(statSync(join(f.target, 'agent')).mode & 0o777).toBe(0o700);
  for (const file of ['auth.json', 'settings.json']) expect(statSync(join(f.target, 'agent', file)).mode & 0o777).toBe(0o600);
  writeFileSync(join(f.source, 'agent/auth.json'), 'invalid new source'); expect(f.run().status).toBe(0);
  expect(readFileSync(join(f.target, 'agent/auth.json'), 'utf8')).toBe(f.auth); // Idempotent; no automatic sync/pruning.
});

test('invalid JSON is sanitized and rejected before creating a partially initialized destination', () => {
  const f = fixture(); writeFileSync(join(f.source, 'agent/auth.json'), '{TEST-SECRET-DO-NOT-PRINT');
  const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('contents suppressed');
  expect(result.stdout + result.stderr).not.toContain('TEST-SECRET'); expect(readdirSync(f.target)).toEqual([]);
});

test('seed refuses symlinked credentials and symlinked agent directories', () => {
  const f = fixture(); rmSync(join(f.source, 'agent/auth.json')); symlinkSync('/etc/passwd', join(f.source, 'agent/auth.json'));
  expect(f.run().status).not.toBe(0); expect(readdirSync(f.target)).toEqual([]);
  rmSync(join(f.source, 'agent'), { recursive: true }); symlinkSync('/tmp', join(f.source, 'agent'));
  expect(f.run().status).not.toBe(0); expect(readdirSync(f.target)).toEqual([]);
});

test('seed refuses nonempty/uninitialized targets and permits preferences without stored credentials', () => {
  const f = fixture(); writeFileSync(join(f.target, 'keep'), 'existing'); expect(f.run().status).not.toBe(0);
  expect(readFileSync(join(f.target, 'keep'), 'utf8')).toBe('existing'); rmSync(join(f.target, 'keep'));
  rmSync(join(f.source, 'agent/auth.json')); expect(f.run().status).toBe(0); expect(readdirSync(join(f.target, 'agent'))).toEqual(['settings.json']);
});

function fakeTools(f: ReturnType<typeof fixture>) {
  const log = join(f.dir, 'commands.jsonl'), state = join(f.dir, 'volume-exists');
  const engine = join(f.dir, 'podman');
  writeFileSync(engine, `#!${process.execPath}\nimport {appendFileSync, existsSync, writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2); appendFileSync(process.env.FAKE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='info') console.log(process.env.FAKE_ROOTLESS ?? 'true');
else if(args[0]==='volume'&&args[1]==='exists') process.exit(existsSync(process.env.FAKE_STATE)?0:1);
else if(args[0]==='volume'&&args[1]==='create') writeFileSync(process.env.FAKE_STATE,'yes');
else if(args[0]==='volume'&&args[1]==='inspect') console.log(process.env.FAKE_DRIVER ?? 'local|0');
else if(args[0]==='run') { const mounts=args.filter((v,i)=>args[i-1]==='--mount'); const source=mounts.find(v=>v.includes('dst=/seed,'))?.match(/src=(.*?),dst=/)?.[1]; const script=mounts.find(v=>v.includes('dst=/run/seed-pi-config.mjs,'))?.match(/src=(.*?),dst=/)?.[1]; if(!source||!script) process.exit(2); const r=spawnSync(process.execPath,[script,source,process.env.FAKE_TARGET],{stdio:'inherit'}); process.exit(r.status??1); }
`); chmodSync(engine, 0o700);
  const env = { ...process.env, PODMAN: engine, HOME: join(f.dir, 'home'), FAKE_LOG: log, FAKE_STATE: state, FAKE_TARGET: f.target };
  return { engine, env, state, commands: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) };
}

test.skipIf(process.env.ORG_PODMAN_SEED_TEST !== '1')('real rootless Podman seeds only auth and filtered settings into a disposable volume', () => {
  const f = fixture(), engine = process.env.PODMAN ?? 'podman', name = `agentorg-pi-seed-test-${crypto.randomUUID()}`;
  const command = (args: string[]) => spawnSync(engine, args, { encoding: 'utf8', timeout: 30_000 });
  let created = false;
  try {
    const result = command(['volume', 'create', name]); expect(result.status).toBe(0); created = result.status === 0;
    const seed = spawnSync('sh', [join(examples, 'seed-volume.sh'), name, process.env.ORG_PODMAN_IMAGE ?? 'localhost/agentorg-pi:latest', f.source], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, PODMAN: engine },
    });
    expect(seed.status).toBe(0); expect(seed.stdout + seed.stderr).not.toContain('TEST-SECRET');
    const inspect = command(['volume', 'inspect', name]); expect(inspect.status).toBe(0);
    const root = JSON.parse(inspect.stdout)[0].Mountpoint as string;
    expect(readdirSync(root).sort()).toEqual(['.agentorg-seeded', 'agent']);
    expect(readdirSync(join(root, 'agent')).sort()).toEqual(['auth.json', 'settings.json']);
    expect(readFileSync(join(root, 'agent/auth.json'), 'utf8')).toBe(f.auth);
    const settings = JSON.parse(readFileSync(join(root, 'agent/settings.json'), 'utf8'));
    expect(settings.defaultThinkingLevel).toBe('high'); expect(settings.packages).toBeUndefined(); expect(settings.shellCommandPrefix).toBeUndefined();
    expect(statSync(join(root, 'agent/auth.json')).mode & 0o777).toBe(0o600);
  } finally { if (created) expect(command(['volume', 'rm', name]).status).toBe(0); }
}, 40_000);

test('seed shell wrapper uses rootless offline/no-pull Node with read-only source/helper mounts and rejects non-plain volumes', () => {
  const f = fixture(), tools = fakeTools(f); writeFileSync(tools.state, 'yes');
  const run = (extra = {}) => spawnSync('sh', [join(examples, 'seed-volume.sh'), 'pi-config', 'local/test:v1', f.source], { encoding: 'utf8', env: { ...tools.env, ...extra } });
  expect(run().status).toBe(0);
  const command = tools.commands().find(args => args[0] === 'run')!;
  for (const flag of ['--pull=never', '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges']) expect(command).toContain(flag);
  expect(command[command.indexOf('--entrypoint') + 1]).toBe('node');
  expect(command.filter((_, i) => command[i - 1] === '--mount').every(mount => mount.includes('ro=true'))).toBe(true);
  expect(run({ FAKE_DRIVER: 'local|1' }).status).not.toBe(0); expect(run({ FAKE_ROOTLESS: 'false' }).status).not.toBe(0);
});

test('example build seeds only when explicitly requested, creates missing volumes, forwards build options and never adds credentials to build context', () => {
  const f = fixture(), tools = fakeTools(f), root = join(f.dir, 'plugin');
  for (const path of ['examples/pi', 'dist']) mkdirSync(join(root, path), { recursive: true });
  mkdirSync(join(f.dir, 'agentorg-plugin-pi-agent/dist'), { recursive: true });
  writeFileSync(join(root, 'examples/pi/build.sh'), readFileSync(join(examples, 'pi/build.sh')));
  writeFileSync(join(root, 'examples/seed-volume.sh'), readFileSync(join(examples, 'seed-volume.sh')));
  writeFileSync(join(root, 'examples/seed-pi-config.mjs'), readFileSync(helper));
  for (const name of ['agentorg-podman-mcp', 'agentorg-podman-exec']) writeFileSync(join(root, 'dist', name), 'binary fixture');
  writeFileSync(join(f.dir, 'agentorg-plugin-pi-agent/dist/pi-acp'), 'binary fixture');
  mkdirSync(tools.env.HOME, { recursive: true }); symlinkSync(f.source, join(tools.env.HOME, '.pi'));
  const bin = join(f.dir, 'bin'); mkdirSync(bin);
  const npmLog = join(f.dir, 'npm.jsonl'), npm = join(bin, 'npm');
  writeFileSync(npm, `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> '${npmLog}'\n`); chmodSync(npm, 0o700);
  const build = (args: string[]) => spawnSync('sh', [join(root, 'examples/pi/build.sh'), ...args], { encoding: 'utf8', env: { ...tools.env, PATH: `${bin}:${process.env.PATH}`, AGENTORG_PODMAN_IMAGE: 'local/test:v1' } });
  const initial = build([]); expect(initial.status, initial.stderr).toBe(0); expect(existsSync(tools.state)).toBe(false); expect(tools.commands().some(args => args[0] === 'run')).toBe(false);
  expect(readFileSync(npmLog, 'utf8').split('\n').filter(Boolean).map(line => line.split(' ').at(-1))).toEqual(['ci', 'build', 'ci', 'build']);
  expect(build(['--seed-volume', 'pi-config', '--build-arg', 'PI_VERSION=1.0.2']).status).toBe(0);
  expect(tools.commands().filter(args => args[0] === 'build').at(-1)).toEqual(['build', '--tag', 'local/test:v1', '--build-arg', 'PI_VERSION=1.0.2', join(root, 'examples/pi')]);
  expect(tools.commands().some(args => args[0] === 'volume' && args[1] === 'create')).toBe(true);
  expect(readdirSync(join(root, 'examples/pi')).sort()).toEqual(['agentorg-pi-acp', 'agentorg-podman-exec', 'agentorg-podman-mcp', 'build.sh']);
  expect(readdirSync(join(f.target, 'agent')).sort()).toEqual(['auth.json', 'settings.json']);
  expect(build(['--seed-volume']).status).not.toBe(0); expect(build(['--seed-volume', '--invalid']).status).not.toBe(0);
});
