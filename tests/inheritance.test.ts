import { expect, test } from 'vitest';
import type { AgentRecord } from 'agent-organization/types';
import { configuredGrants, effectiveImage, effectiveRuntime } from '../src/inheritance.ts';
import { parseSettings, withConfiguredGrants } from '../src/policy.ts';

const node = (id: string, parentId: string | null, podman: unknown = {}) => ({
  id, parentId, settings: { extensions: { podman } },
}) as unknown as AgentRecord;
const grants = (value: unknown = {}) => {
  const { readOnlyDirs, readWriteDirs, readOnlyVolumes, readWriteVolumes } = parseSettings(value);
  return { readOnlyDirs, readWriteDirs, readOnlyVolumes, readWriteVolumes };
};

test('nearest snapshots win independently; ordinary grants never implicitly inherit', () => {
  const config = grants({ readWriteDirs: ['/project'], readOnlyVolumes: ['state'] });
  const runtime = { network: 'none' as const, containerUid: 2000, containerGid: 2001 };
  const root = node('root', null, { image: 'root:v1', runtime, configGrants: config, readOnlyDirs: ['/extra'] });
  const child = node('child', 'root');
  const leaf = node('leaf', 'child');
  const agents = [root, child, leaf];
  expect(effectiveImage(leaf, agents, 'fallback:v1')).toBe('root:v1');
  expect(effectiveRuntime(leaf, agents)).toEqual(runtime);
  expect(configuredGrants(leaf, agents)).toEqual(config);
  const override = node('child', 'root', { image: 'child:v1', configGrants: {} });
  expect(effectiveImage(leaf, [root, override, leaf], 'fallback:v1')).toBe('child:v1');
  expect(configuredGrants(leaf, [root, override, leaf])).toEqual(grants());
  expect(configuredGrants(child, [node('root', null, { readOnlyDirs: ['/extra'] }), child])).toBeUndefined();
  // The proposed node must take precedence over its persisted record.
  expect(configuredGrants(override, agents)).toEqual(grants());
});

test('legacy profile snapshots remain usable without consulting the live catalog', () => {
  const root = node('root', null, { profile: { id: 'removed', name: 'Removed', revision: 1 }, readOnlyDirs: ['/project'] });
  expect(configuredGrants(node('child', 'root'), [root])).toEqual(grants({ readOnlyDirs: ['/project'] }));
});

test('missing ancestors fall back and all inheritance walks reject cycles', () => {
  const orphan = node('orphan', 'missing');
  expect(effectiveImage(orphan, [], 'fallback:v1')).toBe('fallback:v1');
  expect(effectiveRuntime(orphan, [])).toBeUndefined();
  expect(configuredGrants(orphan, [])).toBeUndefined();
  const a = node('a', 'b'), b = node('b', 'a');
  expect(() => effectiveImage(a, [a, b], 'fallback:v1')).toThrow('Cycle');
  expect(() => effectiveRuntime(a, [a, b])).toThrow('Cycle');
  expect(() => configuredGrants(a, [a, b])).toThrow('Cycle');
});

test('configured mount merging is canonical, idempotent and preserves permission islands', () => {
  const config = grants({ readWriteDirs: ['/project'], readOnlyDirs: ['/project/readonly'], readOnlyVolumes: ['state'] });
  const settings = parseSettings({ readOnlyDirs: ['/z-extra', '/a-extra'], readWriteVolumes: ['state', 'extra'] });
  const merged = withConfiguredGrants(settings, config);
  expect(merged.readOnlyDirs).toEqual(['/a-extra', '/project/readonly', '/z-extra']);
  expect(merged.readWriteDirs).toEqual(['/project']);
  expect(merged.readOnlyVolumes).toEqual(['state']);
  expect(merged.readWriteVolumes).toEqual(['extra']);
  expect(withConfiguredGrants(merged, config)).toEqual(merged);
  expect(() => withConfiguredGrants(parseSettings({ readWriteDirs: ['/project/readonly/subdir'] }), config)).toThrow('exceeds');
  expect(withConfiguredGrants(parseSettings({ readWriteDirs: ['/project'] }), config).readOnlyDirs).toEqual(['/project/readonly']);
});
