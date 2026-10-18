import type { AgentRecord } from "agent-organization/types";
import { ApiError, parseSettings, type ContainerSettings } from "./policy.ts";

/** Walk the proposed node first, then persisted ancestors, with one cycle policy. */
function* lineage(agent: Readonly<AgentRecord>, agents: readonly Readonly<AgentRecord>[]) {
  const byId = new Map(agents.map(node => [node.id, node]));
  const seen = new Set<string>();
  let node: Readonly<AgentRecord> | undefined = agent;
  while (node) {
    if (seen.has(node.id)) throw new ApiError("INVALID_PARAMS", "Cycle in agent hierarchy");
    seen.add(node.id);
    yield parseSettings(node.settings.extensions?.podman);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
}

export function effectiveImage(agent: Readonly<AgentRecord>, agents: readonly Readonly<AgentRecord>[], fallback: string): string {
  for (const settings of lineage(agent, agents)) if (settings.image) return settings.image;
  return fallback;
}

export function effectiveRuntime(agent: Readonly<AgentRecord>, agents: readonly Readonly<AgentRecord>[]): ContainerSettings['runtime'] {
  for (const settings of lineage(agent, agents)) if (settings.runtime) return settings.runtime;
}

export function configuredGrants(agent: Readonly<AgentRecord>, agents: readonly Readonly<AgentRecord>[]): ContainerSettings['configGrants'] {
  for (const settings of lineage(agent, agents)) {
    if (settings.configGrants) return settings.configGrants;
    // Profiles persisted before configGrants used their grant lists as the snapshot.
    if (settings.profile) return { readOnlyDirs: settings.readOnlyDirs, readWriteDirs: settings.readWriteDirs,
      readOnlyVolumes: settings.readOnlyVolumes, readWriteVolumes: settings.readWriteVolumes };
  }
}
