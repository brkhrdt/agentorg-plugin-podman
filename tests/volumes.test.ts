import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
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
  const file = join(dir, 'pins.json');
  const config = volumeConfigSchema.parse({ pi: { destination: '/home/pi/.pi' } });
  const volumes = new Volumes(config, file, command); await volumes.initialize();
  return { dir, mountpoint, records, command, file, config, volumes };
}

test('settings reject invalid names, duplicates and RO/RW conflicts', () => {
  for (const readOnlyVolumes of [[''], ['--evil'], ['/host'], ['foo:bar'], ['pi', 'pi']])
    expect(() => parseSettings({ readOnlyVolumes })).toThrow();
  expect(() => parseSettings({ readOnlyVolumes: ['pi'], readWriteVolumes: ['pi'] })).toThrow();
  expect(parseSettings({})).toMatchObject({ readOnlyVolumes: [], readWriteVolumes: [] });
  expect(() => requireVolumeDelegation(parseSettings({ readOnlyVolumes: ['pi-other'] }), parseSettings({}), parseSettings({ readWriteVolumes: ['pi'] }), parseSettings({ readWriteVolumes: ['pi'] }))).toThrow('Cannot delegate');
});

test('trusted destinations reject runtime paths and mount syntax', () => {
  for (const destination of ['/', '/proc/config', '/usr/local', '/run/x', 'relative', '/home/pi/../pi/.pi', '/home/pi/.pi/', '/home/pi/.pi,ro=false'])
    expect(() => new Volumes(volumeConfigSchema.parse({ pi: { destination } }), '/tmp/unused', async () => '')).toThrow();

});

test('discovery hides missing/unsafe volumes; grants reject conflicts and policy escalation', async () => {
  const { volumes, records, file, config, command } = await setup();
  records.second = { ...records.pi, Name: 'second' };
  for (const destination of ['/home/pi/.pi', '/home/pi/.pi/agent']) {
    const alternatives = new Volumes({ ...config, second: { destination, readOnly: false } }, file, command);
    await expect(alternatives.validate(parseSettings({ readOnlyVolumes: ['pi', 'second'] }), [], false)).rejects.toThrow('overlap');
  }
  delete records.second;
  expect((await volumes.list()).volumes.map(v => v.name)).toEqual(['pi']);
  await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['other'] }), [], false)).rejects.toThrow('Choose a container destination');
  await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['pi'], readOnlyDirs: ['/home/pi'] }), [], false)).rejects.toThrow('conflicts');
  await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['pi'] }), ['/home/pi/.pi/runtime'], false)).rejects.toThrow('protected');
  const restricted = new Volumes({ pi: { ...config.pi!, readOnly: true } }, file, command);
  await expect(restricted.validate(parseSettings({ readWriteVolumes: ['pi'] }), [], false)).rejects.toThrow('only read-only');
  for (const patch of [{ Driver: 'external' }, { Options: { device: '/host', type: 'none', o: 'bind' } }, { CreatedAt: '' }]) {
    const original = { ...records.pi }; Object.assign(records.pi, patch);
    expect((await volumes.list()).volumes).toEqual([]);
    await expect(volumes.validate(parseSettings({ readOnlyVolumes: ['pi'] }), [], false)).rejects.toThrow('not a plain local');
    records.pi = original;
  }
  delete records.pi; expect((await volumes.list()).volumes).toEqual([]);
});

test('volume identity pins survive plugin recovery and detect replacement/config changes', async () => {
  const { volumes, config, file, command, records, mountpoint } = await setup();
  const grants = parseSettings({ readOnlyVolumes: ['pi'] });
  await expect(volumes.validate(grants, [], true)).rejects.toThrow('no trusted identity pin');
  const mounts = await volumes.validate(grants, [], false);
  expect(mounts[0]!.argument).toContain(':ro,nocopy');
  expect(JSON.parse(await readFile(file, 'utf8')).pi.destination).toBe('/home/pi/.pi');
  const recovered = new Volumes(config, file, command); await recovered.initialize();
  expect(await recovered.validate(grants, [], true)).toEqual(mounts);
  const redirected = new Volumes({ pi: { ...config.pi!, destination: '/home/pi/.codex' } }, file, command); await redirected.initialize();
  await expect(redirected.validate(grants, [], true)).rejects.toThrow('configuration changed');
  records.pi.CreatedAt += '-replaced';
  await expect(recovered.validate(grants, [], true)).rejects.toThrow('identity');
  records.pi.CreatedAt = '2026-01-01';
  await rename(mountpoint, `${mountpoint}-old`); await mkdir(mountpoint);
  await expect(recovered.validate(grants, [], true)).rejects.toThrow('identity');
});

test('host volumes need no plugin config; client registrations and pins persist across recovery', async () => {
  const { file, command } = await setup();
  const volumes = new Volumes({}, file, command); await volumes.initialize();
  expect(await volumes.list()).toEqual({ volumes: [{ name: 'pi', readOnly: false }] });
  const grants = parseSettings({ readWriteVolumes: ['pi'] });
  await expect(volumes.validate(grants, [], false)).rejects.toThrow('Choose a container destination');
  await expect(volumes.configure('missing', '/home/pi/.pi', [])).rejects.toThrow('missing');
  for (const destination of ['/', '/usr/bin', '/proc/x', 'relative', '/home/pi/.pi,ro=false'])
    await expect(volumes.configure('pi', destination, [])).rejects.toThrow();
  await expect(volumes.configure('pi', '/home/pi/.pi', ['/home/pi/.pi/private-relay'])).rejects.toThrow('protected');
  expect(await volumes.configure('pi', '/home/pi/.pi', [])).toEqual({ name: 'pi', destination: '/home/pi/.pi', readOnly: false });
  expect(await volumes.configure('pi', '/home/pi/.pi', [])).toMatchObject({ name: 'pi' }); // Idempotent.
  await expect(volumes.configure('pi', '/home/pi/.codex', [])).rejects.toThrow('already configured');
  expect((await volumes.validate(grants, [], true))[0]!.argument).toBe('pi:/home/pi/.pi:rw,nocopy');
  const recovered = new Volumes({}, file, command); await recovered.initialize();
  expect((await recovered.list()).volumes[0]!.destination).toBe('/home/pi/.pi');
  expect(await recovered.validate(grants, [], true)).toEqual(await volumes.validate(grants, [], true));
});

test('volume gate rejects omitted/redirected mounts and changed access modes', () => {
  const manifest = [{ path: '/home/pi/.pi', readOnly: true }];
  const info = '42 31 8:1 /volumes/pi /home/pi/.pi ro,nosuid - ext4 /dev/root rw\n';
  expect(() => verifyVolumeMounts(manifest, info)).not.toThrow();
  for (const bad of ['', info.replace('/home/pi/.pi', '/other'), info.replace('ro,nosuid', 'rw,nosuid'), info + info])
    expect(() => verifyVolumeMounts(manifest, bad)).toThrow('destination or access');
  expect(() => verifyVolumeMounts([{ ...manifest[0]!, readOnly: false }], info)).toThrow();
});
