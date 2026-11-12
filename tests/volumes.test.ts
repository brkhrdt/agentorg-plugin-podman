import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Volumes, volumeConfigSchema } from '../src/volumes.ts';
import { parseSettings, requireVolumeDelegation } from '../src/policy.ts';
import { verifyVolumeMounts } from '../src/volume-gate.ts';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'aop-volumes-')); cleanup.push(dir);
  const mountpoint = join(dir, 'data'); await mkdir(mountpoint);
  const records: Record<string, any> = { pi: { Name: 'pi', Driver: 'local', Options: {}, CreatedAt: '2026-01-01', Mountpoint: mountpoint } };
  const command = async (args: string[]) => {
    if (args[1] === 'ls') return Object.keys(records).join('\n');
    expect(args.slice(0, 2)).toEqual(['volume', 'inspect']);
    if (!records[args[2]!]) throw new Error('missing');
    return JSON.stringify([records[args[2]!] ]);
  };
  const config = volumeConfigSchema.parse({ pi: { destination: '/home/pi/.pi' } });
  const volumes = new Volumes(config, command);
  return { dir, mountpoint, records, command, config, volumes };
}

test('settings reject invalid names, duplicates and RO/RW conflicts', () => {
  for (const readOnlyVolumes of [[''], ['--evil'], ['/host'], ['foo:bar'], ['pi', 'pi']])
    expect(() => parseSettings({ readOnlyVolumes })).toThrow();
  expect(() => parseSettings({ readOnlyVolumes: ['pi'], readWriteVolumes: ['pi'] })).toThrow();
  expect(parseSettings({})).toMatchObject({ readOnlyVolumes: [], readWriteVolumes: [] });
  expect(() => requireVolumeDelegation(parseSettings({ readOnlyVolumes: ['pi-other'] }), parseSettings({}), parseSettings({ readWriteVolumes: ['pi'] }), parseSettings({ readWriteVolumes: ['pi'] }))).toThrow('Cannot delegate');
});

test('Host authority may delegate eligible named-volume grants, while container authorities remain bounded', () => {
  const requested = parseSettings({ readWriteVolumes: ['pi'] });
  const empty = parseSettings({});
  expect(() => requireVolumeDelegation(requested, empty, empty, empty)).toThrow('Cannot delegate');
  expect(() => requireVolumeDelegation(requested, empty, empty, empty, true, true)).not.toThrow();
});

test('trusted destinations reject runtime paths and mount syntax', () => {
  for (const destination of ['/', '/proc/config', '/usr/local', '/run/x', 'relative', '/home/pi/../pi/.pi', '/home/pi/.pi/', '/home/pi/.pi,ro=false'])
    expect(() => new Volumes(volumeConfigSchema.parse({ pi: { destination } }), async () => '')).toThrow();
});

test('discovery hides missing/unsafe volumes; grants reject conflicts and policy escalation', async () => {
  const { volumes, records, config, command } = await setup();
  records.second = { ...records.pi, Name: 'second' };
  for (const destination of ['/home/pi/.pi', '/home/pi/.pi/agent']) {
    const alternatives = new Volumes({ ...config, second: { destination, readOnly: false } }, command);
    await expect(alternatives.validate(parseSettings({ readOnlyVolumes: ['pi', 'second'] }), [])).rejects.toThrow('overlap');
  }
  delete records.second;
  expect((await volumes.list()).volumes.map(v => v.name)).toEqual(['pi']);
  await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['other'] }), [])).rejects.toThrow('Choose a container destination');
  await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['pi'], readOnlyDirs: ['/home/pi'] }), [])).rejects.toThrow('conflicts');
  await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['pi'] }), ['/home/pi/.pi/runtime'])).rejects.toThrow('protected');
  const restricted = new Volumes({ pi: { ...config.pi!, readOnly: true } }, command);
  await expect(restricted.validate(parseSettings({ readWriteVolumes: ['pi'] }), [])).rejects.toThrow('only read-only');
  for (const patch of [{ Driver: 'external' }, { Options: { device: '/host', type: 'none', o: 'bind' } }]) {
    const original = { ...records.pi }; Object.assign(records.pi, patch);
    expect((await volumes.list()).volumes).toEqual([]);
    await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['pi'] }), [])).rejects.toThrow('not a plain local');
    records.pi = original;
  }
  delete records.pi; expect((await volumes.list()).volumes).toEqual([]);
});

test('same-name replacement is accepted with process-local destination and fresh manifest identity', async () => {
  const { volumes, config, command, records, mountpoint, dir } = await setup();
  const grants = parseSettings({ readOnlyVolumes: ['pi'] });
  const first = await volumes.validate(grants, []);
  expect(first[0]!.argument).toBe('pi:/home/pi/.pi:ro,nocopy');
  records.pi.CreatedAt += '-replaced';
  await rename(mountpoint, `${mountpoint}-old`); const replacement = join(dir, 'replacement'); await mkdir(replacement); records.pi.Mountpoint = replacement;
  const next = await volumes.validate(grants, []);
  expect(next[0]!.identity.ino).not.toBe(first[0]!.identity.ino);
  expect((await volumes.list()).volumes[0]).toMatchObject({ name: 'pi', destination: '/home/pi/.pi', readOnly: false });
  await expect(volumes.configure('pi', '/home/pi/.codex', [])).rejects.toThrow('already configured');
  const configuredReadOnly = new Volumes({ pi: { ...config.pi!, readOnly: true } }, command);
  await expect(configuredReadOnly.validate(parseSettings({ readWriteVolumes: ['pi'] }), [])).rejects.toThrow('only read-only');
});

test('client registrations are serialized, process-local, and require fresh registration after restart', async () => {
  const { command, dir } = await setup();
  const legacyFile = join(dir, 'podman-volume-pins.json'), sentinel = 'not valid JSON: leave untouched';
  await writeFile(legacyFile, sentinel);
  const concurrent = new Volumes({}, command);
  const racers = await Promise.allSettled([concurrent.configure('pi', '/home/pi/.one', []), concurrent.configure('pi', '/home/pi/.two', [])]);
  expect(racers.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(racers.filter(result => result.status === 'rejected')).toHaveLength(1);
  const volumes = new Volumes({}, command);
  expect(await volumes.list()).toEqual({ volumes: [{ name: 'pi', readOnly: false }] });
  const grants = parseSettings({ readWriteVolumes: ['pi'] });
  await expect(volumes.validate(grants, [])).rejects.toThrow('Choose a container destination');
  await expect(volumes.configure('missing', '/home/pi/.pi', [])).rejects.toThrow('missing');
  for (const destination of ['/', '/usr/bin', '/proc/x', 'relative', '/home/pi/.pi,ro=false'])
    await expect(volumes.configure('pi', destination, [])).rejects.toThrow();
  await expect(volumes.configure('pi', '/home/pi/.pi', ['/home/pi/.pi/private-relay'])).rejects.toThrow('protected');
  const registered = await volumes.configure('pi', '/home/pi/.pi', []);
  expect(registered).toEqual({ name: 'pi', destination: '/home/pi/.pi', readOnly: false });
  expect(await volumes.configure('pi', '/home/pi/.pi', [])).toMatchObject({ name: 'pi' });
  await expect(volumes.configure('pi', '/home/pi/.codex', [])).rejects.toThrow('already configured');
  expect((await volumes.validate(grants, []))[0]!.argument).toBe('pi:/home/pi/.pi:rw,nocopy');
  const restarted = new Volumes({}, command);
  await expect(restarted.validate(grants, [])).rejects.toThrow('Choose a container destination');
  await restarted.configure('pi', '/home/pi/.pi', []);
  expect((await restarted.validate(grants, []))[0]!.argument).toBe('pi:/home/pi/.pi:rw,nocopy');
  const operator = new Volumes(volumeConfigSchema.parse({ pi: { destination: '/home/pi/.codex' } }), command);
  expect((await operator.validate(grants, []))[0]!.argument).toBe('pi:/home/pi/.codex:rw,nocopy');
  expect(await readFile(legacyFile, 'utf8')).toBe(sentinel);
});

test('volume gate rejects omitted/redirected mounts and changed access modes', () => {
  const manifest = [{ path: '/home/pi/.pi', readOnly: true }];
  const info = '42 31 8:1 /volumes/pi /home/pi/.pi ro,nosuid - ext4 /dev/root rw\n';
  expect(() => verifyVolumeMounts(manifest, info)).not.toThrow();
  for (const bad of ['', info.replace('/home/pi/.pi', '/other'), info.replace('ro,nosuid', 'rw,nosuid'), info + info])
    expect(() => verifyVolumeMounts(manifest, bad)).toThrow('destination or access');
  expect(() => verifyVolumeMounts([{ ...manifest[0]!, readOnly: false }], info)).toThrow();
});
