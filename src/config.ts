import { z } from "zod";
import type { ServerSettingsDefinition } from "agent-organization/plugin";
import { ApiError, containerSettingsSchema, envSchema, networkSchema, parseSettings, type ContainerGrants } from "./policy.ts";
import { profilesSchema, profileFields } from "./profiles.ts";
import { validateVolumeDestination, volumeConfigSchema } from "./volumes.ts";

const executable = z.string().min(1).max(4096).refine(s => !s.startsWith("-") && !/[\0\r\n]/.test(s), "Invalid executable");
export const configSchema = z.object({
  defaultImage: z.string().min(1).max(4096),
  podmanExecutable: executable,
  mcpExecutable: executable,
  entrypointExecutable: executable,
  containerUid: z.number().int().min(1).max(65535),
  containerGid: z.number().int().min(1).max(65535),
  network: networkSchema,
  containers: profilesSchema.default([]),
  readOnlyDirs: containerSettingsSchema.shape.readOnlyDirs,
  readWriteDirs: containerSettingsSchema.shape.readWriteDirs,
  readOnlyVolumes: containerSettingsSchema.shape.readOnlyVolumes,
  readWriteVolumes: containerSettingsSchema.shape.readWriteVolumes,
  /** Legacy operator destination policy, not grants. Retained for pins/backward compatibility. */
  volumes: volumeConfigSchema,
  /** Names only: trusted harness variables, never host environment or credentials. */
  env: envSchema,
}).strict();
export type PodmanConfig = z.output<typeof configSchema>;
export type PodmanPluginOptions = Partial<z.input<typeof configSchema>>;

const builtins: PodmanConfig = {
  defaultImage: "localhost/agentorg-pi:latest",
  podmanExecutable: "podman",
  mcpExecutable: "/usr/local/bin/agentorg-podman-mcp",
  entrypointExecutable: "/usr/local/bin/agentorg-podman-exec",
  containerUid: 1000, containerGid: 1000, network: "pasta", volumes: {}, containers: [],
  readOnlyDirs: [], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [],
  env: ["ORG_PI_CONFIG", "ORG_PI_MCP_SERVERS", "ORG_PI_EXTENSION", "AGENTORG_SKILL_FILES"],
};

/** Pure syntax/policy validation. No Podman commands, image probes or mount I/O. */
export function validateConfig(value: unknown): PodmanConfig {
  const config = configSchema.parse(value);
  parseSettings({ image: config.defaultImage, ...grantDefaults(config) });
  const dirs = [...config.readOnlyDirs, ...config.readWriteDirs];
  if (new Set(dirs).size !== dirs.length || dirs.some(path => /[\0\r\n]/.test(path))) throw new ApiError('INVALID_PARAMS', 'Duplicate, conflicting or invalid default directories');
  for (const entry of Object.values(config.volumes))
    validateVolumeDestination(entry.destination, [config.mcpExecutable, config.entrypointExecutable]);
  return config;
}
export function startupConfig(options: PodmanPluginOptions): PodmanConfig {
  // Keep the factory's existing optional/undefined option semantics.
  return validateConfig({ ...builtins, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) });
}

export function grantDefaults(config: ContainerGrants): ContainerGrants {
  return { readOnlyDirs: config.readOnlyDirs, readWriteDirs: config.readWriteDirs,
    readOnlyVolumes: config.readOnlyVolumes, readWriteVolumes: config.readWriteVolumes };
}

export function podmanServerSettings(defaults: PodmanConfig): ServerSettingsDefinition {
  return {
    namespace: "podman", title: "Podman containers", version: 4,
    description: "Named container configurations selectable when creating agents, plus server-wide defaults. No credentials or automatic restarts.",
    defaults,
    fields: [
      { key: "defaultImage", label: "Default image", editor: "text", choicesEndpoint: "podman.choices.images", effect: "future-launch",
        description: "Fallback for agents without an explicit ancestor image. Must already exist locally at launch; images are never pulled. Saving does not probe the image or restart existing containers." },
      { key: "network", label: "Network", editor: "select", choices: ["slirp4netns", "pasta", "none"], effect: "future-launch",
        description: "Network for subsequent containers. slirp4netns disables host loopback. Provider APIs usually require networking." },
      { key: "containerUid", label: "Container UID", editor: "number", min: 1, max: 65535, effect: "future-launch",
        description: "Non-root image user ID. keep-id maps the server user to this ID for new containers; must match the image." },
      { key: "containerGid", label: "Container GID", editor: "number", min: 1, max: 65535, effect: "future-launch",
        description: "Non-root image group ID for new containers; must match the image." },
      { key: "env", label: "Environment variables", editor: "list", effect: "future-launch",
        description: "Environment variable NAMES permitted from trusted harness launch specs. Values come from that harness, not the host environment; the generation token is always removed." },
      ...profileFields.filter(field => ['readOnlyDirs', 'readWriteDirs', 'readOnlyVolumes', 'readWriteVolumes'].includes(field.key)).map(field => ({ ...field,
        description: 'Seed new client-created agent drafts and new container configurations; review before saving. Does not change existing agents/configurations or agent-created child grants. Removing defaults never deletes data or volume registrations.' })),
      { key: "volumes", label: "Legacy volume destination policy", editor: "object-map", effect: "restart", deprecated: true,
        description: 'Compatibility-only operator policy. Preserves existing destinations, RO restrictions and identity pins; not default grants. Use the four RO/RW lists for new defaults.' },
      { key: "podmanExecutable", label: "Host Podman executable", editor: "text", effect: "restart",
        description: "Trusted host executable (path or PATH command). Resolved and verified rootless at server initialization; existing containers/cleanup retain the current executable until restart." },
      { key: "mcpExecutable", label: "Container MCP executable", editor: "text", effect: "restart",
        description: "Trusted MCP helper installed inside images; not a host mount. Effective only after server restart." },
      { key: "entrypointExecutable", label: "Container mount-gate executable", editor: "text", effect: "restart",
        description: "Trusted mount-identity gate installed inside images. Effective only after server restart; images must provide a compatible gate." },
      { key: "containers", label: "Container configurations", editor: "list", effect: "future-launch",
        description: "Add named container configurations, then select one when creating an agent. Harness, provider and model remain harness-owned. Local image availability is checked on save; mount security is checked on agent creation/launch.",
        itemFields: profileFields, itemIdKey: "id", itemLabelKey: "name",
        itemDefaultsFrom: { image: 'defaultImage', network: 'network', containerUid: 'containerUid', containerGid: 'containerGid', env: 'env',
          readOnlyDirs: 'readOnlyDirs', readWriteDirs: 'readWriteDirs', readOnlyVolumes: 'readOnlyVolumes', readWriteVolumes: 'readWriteVolumes' },
        itemDefaults: { id: "", name: "New container", image: defaults.defaultImage, network: defaults.network,
          containerUid: defaults.containerUid, containerGid: defaults.containerGid, env: defaults.env,
          cwd: "", ...grantDefaults(defaults) } },
    ],
    validate: value => validateConfig(value),
    migrate(overrides, fromVersion) { if (![1, 2].includes(fromVersion)) throw new Error("Unsupported Podman settings version"); return overrides; },
  };
}
