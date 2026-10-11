import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AgentRecord, Caller, Operation, Settings } from "agent-organization/types";
import type { LaunchContext, LaunchSpec, PluginHost, ServerPlugin } from "agent-organization/plugin";
import { ApiError, bindMount, canonicalFuturePath, directory, hostPath, normalize, parseSettings, permission, protect, requireDelegation, roots } from "./policy.ts";
import { createRelay } from "./relay.ts";
import { mountIdentity } from "./mounts.ts";

const exec = promisify(execFile);
const configSchema = z.object({
  defaultImage: z.string().min(1).default("localhost/agentorg-pi:latest"),
  podmanExecutable: z.string().min(1).default("podman"),
  mcpExecutable: z.string().min(1).default("/usr/local/bin/agentorg-podman-mcp"),
  entrypointExecutable: z.string().min(1).default("/usr/local/bin/agentorg-podman-exec"),
  containerUid: z.number().int().min(1).max(65535).default(1000),
  containerGid: z.number().int().min(1).max(65535).default(1000),
  network: z.enum(["slirp4netns", "pasta", "none"]).default("pasta"),
  /** Trusted harness variables only. Host credentials and HOME are never copied implicitly. */
  harnessEnv: z.array(z.string()).default(["ORG_PI_CONFIG", "ORG_PI_MCP_SERVERS", "ORG_PI_EXTENSION", "AGENTORG_SKILL_FILES"]),
}).strict();
export type PodmanPluginOptions = z.input<typeof configSchema>;
export type ImageScope = "node" | "inherited" | "all";
export { containerSettingsSchema as podmanSettingsSchema, type ContainerSettings as PodmanSettings } from "./policy.ts";

export function effectiveImage(agent: Readonly<AgentRecord>, agents: Readonly<AgentRecord>[], fallback: string): string {
  let node: Readonly<AgentRecord> | undefined = agent;
  const seen = new Set<string>();
  while (node) {
    if (seen.has(node.id)) throw new ApiError("INVALID_PARAMS", "Cycle in agent hierarchy");
    seen.add(node.id);
    const image = parseSettings(node.settings.extensions?.podman).image;
    if (image) return image;
    node = agents.find(a => a.id === node!.parentId);
  }
  return fallback;
}
export function imageDescendants(agentId: string, agents: Readonly<AgentRecord>[], scope: ImageScope): Readonly<AgentRecord>[] {
  if (scope === "node") return [];
  const result: Readonly<AgentRecord>[] = [];
  function visit(id: string) {
    for (const child of agents.filter(a => !a.removedAt && a.parentId === id)) {
      if (scope === "inherited" && parseSettings(child.settings.extensions?.podman).image) continue;
      result.push(child); visit(child.id);
    }
  }
  visit(agentId);
  return result;
}

export function createPodmanPlugin(options: PodmanPluginOptions = {}): ServerPlugin {
  const config = configSchema.parse(options);
  parseSettings({ image: config.defaultImage });
  return { apiVersion: 1, name: "podman", setup(host: PluginHost) {
    const serverCaller = { kind: "server", id: "podman" } as const;
    const owner = createHash("sha256").update(resolve(host.dataDir)).digest("hex").slice(0, 20);
    const label = `org.agentorg.podman.owner=${owner}`;
    let podmanExecutable = config.podmanExecutable;
    let protectedPaths = [resolve(host.dataDir), join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "containers")];
    if (process.env.XDG_RUNTIME_DIR) protectedPaths.push(resolve(process.env.XDG_RUNTIME_DIR));
    for (const name of ["CONTAINERS_CONF", "CONTAINERS_STORAGE_CONF"]) if (process.env[name]) protectedPaths.push(resolve(process.env[name]!));
    const resources = new Map<string, { agentId: string; name: string; relay: Awaited<ReturnType<typeof createRelay>> }>();
    const launches = new WeakMap<LaunchContext, LaunchSpec>();
    const cleanupJobs = new Map<string, Promise<void>>();
    const command = async (args: string[]) => (await exec(podmanExecutable, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: process.env })).stdout.trim();
    async function snapshot() { return (await host.request("organization.snapshot", {}, serverCaller) as { agents: AgentRecord[] }).agents; }
    function cleanup(key: string): Promise<void> {
      const pending = cleanupJobs.get(key);
      if (pending) return pending;
      const resource = resources.get(key);
      if (!resource) return Promise.resolve();
      const work = (async () => {
        await resource.relay.close();
        // An exited podman CLI does not imply that conmon/the container has exited.
        await command(["rm", "--force", "--ignore", resource.name]);
        resources.delete(key);
        protectedPaths = protectedPaths.filter(path => path !== dirname(resource.relay.path));
      })().finally(() => cleanupJobs.delete(key));
      cleanupJobs.set(key, work);
      return work;
    }
    host.registerSettings({ namespace: "podman", validate: parseSettings, ui: { fields: [
      { key: "readOnlyDirs", label: "Read-only grants", editor: "directories" },
      { key: "readWriteDirs", label: "Read/write grants", editor: "directories" },
    ] } });
    host.registerCapability("podman", {
      settingsNamespace: "podman", defaultImage: config.defaultImage,
      endpoints: { modify: "podman.modify" }, imageScopes: ["node", "inherited", "all"],
      readOnlyDirs: true, readWriteDirs: true, isolatedContainers: true, modelDiscovery: false,
    });
    host.onInitialize(async () => {
      if (process.getuid?.() === 0) throw new Error("Podman plugin requires a non-root server user");
      const candidates = config.podmanExecutable.includes("/") ? [resolve(config.podmanExecutable)] : (process.env.PATH ?? "").split(delimiter).map(p => resolve(p, config.podmanExecutable));
      let executable: string | undefined;
      for (const path of candidates) {
        try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) { executable = await realpath(path); break; } } catch {}
      }
      if (!executable) throw new Error(`Podman executable not found: ${config.podmanExecutable}`);
      podmanExecutable = executable; protectedPaths.push(executable);
      const info = JSON.parse(await command(["info", "--format=json"]));
      if (info.host?.security?.rootless !== true) throw new Error("Podman plugin requires rootless Podman");
      for (const path of [info.store?.graphRoot, info.store?.runRoot, info.store?.volumePath, info.store?.configFile])
        if (typeof path === "string") protectedPaths.push(resolve(path));
      // Preserve lexical aliases too: granting their parents could let an agent
      // redirect a host control/config symlink before the next Podman invocation.
      protectedPaths = [...new Set([...protectedPaths, ...await Promise.all(protectedPaths.map(canonicalFuturePath))])];
      // Recover after a host crash before core starts any agent. Never adopt orphan containers.
      const names = (await command(["ps", "--all", "--filter", `label=${label}`, "--format", "{{.Names}}"])).split("\n").filter(Boolean);
      if (names.length) await command(["rm", "--force", "--ignore", ...names]);
    });
    async function normalized(settings: Settings, agent: Readonly<AgentRecord>, launch = false): Promise<Settings> {
      const agents = await snapshot();
      const parent = agents.find(a => a.id === agent.parentId);
      const base = parent?.settings.cwd ?? process.cwd();
      if (!settings.cwd) throw new ApiError("INVALID_PARAMS", "Container agents require an explicit cwd covered by a directory mount");
      const cwd = await directory(hostPath(settings.cwd, base));
      const value = await normalize(settings.extensions?.podman, base);
      protect(value, protectedPaths);
      if (!permission(value, cwd)) throw new ApiError("INVALID_PARAMS", "cwd must be covered by an explicit readOnlyDirs or readWriteDirs mount");
      if (launch) {
        // Reject changed symlink targets at recovery/restart, rather than silently expanding access.
        const old = parseSettings(settings.extensions?.podman);
        if (cwd !== settings.cwd || JSON.stringify(value) !== JSON.stringify(old)) throw new ApiError("FORBIDDEN", "Persisted mount/cwd paths changed; update settings through a trusted client");
      }
      return { ...settings, cwd, extensions: { ...settings.extensions, podman: value } };
    }
    host.beforeSettings(normalized);
    host.beforeMutation(async context => {
      if (context.caller.kind !== "agent" || !["agent.create", "agent.modify"].includes(context.method)) return;
      const caller = context.agents.find(a => a.id === context.caller.id)!;
      const parent = context.agents.find(a => a.id === context.agent.parentId);
      if (!parent) throw new ApiError("FORBIDDEN", "Agent directory grants require a direct parent");
      const next = parseSettings(context.agent.settings.extensions?.podman);
      const old = parseSettings(context.previous?.settings.extensions?.podman);
      if ((next.image ?? null) !== (old.image ?? null)) throw new ApiError("FORBIDDEN", "Only clients may change container images");
      const callerGrants = parseSettings((await normalized(caller.settings, caller, true)).extensions?.podman);
      const parentGrants = parseSettings((await normalized(parent.settings, parent, true)).extensions?.podman);
      requireDelegation(next, old, callerGrants, parentGrants);
      // Agents cannot revoke a grant while leaving a previously delegated child with greater rights.
      for (const child of context.agents.filter(a => !a.removedAt && a.parentId === context.agent.id)) {
        const grants = parseSettings(child.settings.extensions?.podman);
        for (const path of new Set([...roots(grants), ...roots(old), ...roots(next)]))
          if (permission(grants, path) <= permission(old, path) && permission(grants, path) > permission(next, path))
            throw new ApiError("FORBIDDEN", "Modify dependent child grants before reducing parent permissions");
      }
    });

    for (const toolName of ["child_create", "descendant_modify"]) host.transformTool(toolName, tool => {
      const properties = { ...tool.inputSchema.properties };
      const settingsSchema = properties.settings as { properties?: Record<string, unknown>; required?: string[] } | undefined;
      if (toolName === "child_create" && settingsSchema?.properties?.cwd)
        properties.settings = { ...settingsSchema, required: [...new Set([...(settingsSchema.required ?? []), "cwd"])] };
      const strings = { type: "array", items: { type: "string", minLength: 1 }, description: "Existing mounted directories, absolute or relative to the target's direct parent cwd. Defaults to empty; no implicit cwd mount. Never escalate read-only access." };
      properties.readOnlyDirs = strings;
      properties.readWriteDirs = strings;
      return { ...tool, description: tool.description + " Every child runs in its own container with the inherited image. Explicitly grant directories covering cwd; grants must be within your and the direct parent's mounted permissions.", inputSchema: { ...tool.inputSchema, properties }, async execute(args, caller, api) {
        const parsed = z.object({ readOnlyDirs: z.array(z.string().min(1)).optional(), readWriteDirs: z.array(z.string().min(1)).optional(), settings: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(args);
        const { readOnlyDirs, readWriteDirs, ...rest } = parsed;
        if (readOnlyDirs === undefined && readWriteDirs === undefined) return tool.execute(rest, caller, api);
        const settings = parsed.settings ?? {};
        const extensions = settings.extensions as Record<string, unknown> | undefined;
        if (extensions && Object.hasOwn(extensions, "podman")) throw new ApiError("INVALID_PARAMS", "Use top-level directory grants or settings.extensions.podman, not both");
        const current = toolName === "descendant_modify" ? parseSettings((await api.request("agent.get", { agentId: rest.agentId }, caller) as AgentRecord).settings.extensions?.podman) : {};
        // Both arrays replace the grants. Omitted arrays are empty, never inherited.
        return tool.execute({ ...rest, settings: { ...settings, extensions: { ...extensions, podman: { ...current, readOnlyDirs: readOnlyDirs ?? [], readWriteDirs: readWriteDirs ?? [] } } } }, caller, api);
      } };
    });

    host.prepareLaunch(async context => {
      for (const path of [context.socketPath, await canonicalFuturePath(context.socketPath)])
        if (!protectedPaths.includes(path)) protectedPaths.push(path);
      await normalized(context.agent.settings, context.agent, true);
      const agent = context.agent;
      const key = agent.generation!;
      const name = `aop-${owner}-${key}`;
      const relay = await createRelay(context.socketPath, context.token);
      protectedPaths.push(dirname(relay.path));
      resources.set(key, { agentId: agent.id, name, relay });
      context.executionEnvironment = "container";
      context.socketPath = relay.path;
      context.mcpServers = [{ name: "organization", command: config.mcpExecutable, args: [], env: [{ name: "ORG_SOCKET", value: relay.path }] }];
      // Only an agent's own session directory is mounted, never the database or siblings' sessions.
      await mkdir(join(host.dataDir, "sessions", agent.id, String(agent.sessionNumber)), { recursive: true, mode: 0o700 });
    });
    host.beforeLaunch(async (spec, context) => {
      const resource = resources.get(context.agent.generation!);
      if (!resource || context.executionEnvironment !== "container") throw new Error("Missing container launch preparation");
      const settings = await normalized(context.agent.settings, context.agent, true);
      if (spec.cwd !== undefined && await directory(spec.cwd) !== settings.cwd) throw new ApiError("FORBIDDEN", "Harness cwd differs from the permitted container cwd");
      const grants = parseSettings(settings.extensions?.podman);
      protect(grants, [...protectedPaths, dirname(resource.relay.path)]);
      const image = effectiveImage(context.agent, await snapshot(), config.defaultImage);
      const env: Record<string, string | undefined> = { ...settings.env };
      for (const name of config.harnessEnv) if (spec.env?.[name] !== undefined) env[name] = spec.env[name];
      Object.assign(env, context.env, { ORG_SOCKET: resource.relay.path, ORG_AGENT_ID: context.agent.id });
      // The generation token remains exclusively on the host, even if supplied in settings.env.
      delete env.ORG_TOKEN;
      const args = ["run", "--rm", "--interactive", "--pull=never", "--name", resource.name, "--label", label,
        `--userns=keep-id:uid=${config.containerUid},gid=${config.containerGid}`, "--user", `${config.containerUid}:${config.containerGid}`, "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--pid=private", "--ipc=private", "--pids-limit=256", "--network", config.network === "slirp4netns" ? "slirp4netns:allow_host_loopback=false" : config.network,
        "--workdir", settings.cwd!];
      // Parent mounts first so more specific read-only/read-write islands take precedence.
      const paths = roots(grants).sort((a, b) => a.length - b.length);
      const sessionDir = join(host.dataDir, "sessions", context.agent.id, String(context.agent.sessionNumber));
      const identities = await Promise.all([...paths, sessionDir].map(path => mountIdentity(path)));
      identities.push(await mountIdentity(resource.relay.path, true));
      for (const path of paths) args.push("--mount", bindMount(path, grants.readOnlyDirs.includes(path)));
      args.push("--mount", bindMount(sessionDir, false));
      args.push("--mount", bindMount(resource.relay.path, true));
      const childEnv: Record<string, string> = {};
      for (const [name, value] of Object.entries(env)) if (value !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) throw new ApiError("INVALID_PARAMS", "Invalid container environment variable");
        childEnv[name] = value;
      }
      // Agent-controlled LD_PRELOAD/BUN_OPTIONS/etc must not run before the mount
      // gate. Apply those only to the harness AFTER verification. These two engine
      // env values are host-owned and also support trusted `podman exec` diagnostics.
      args.push("--env", `ORG_SOCKET=${resource.relay.path}`, "--env", `ORG_AGENT_ID=${context.agent.id}`);
      if (!spec.command || spec.command.startsWith("-")) throw new Error("Invalid container harness command");
      args.push("--entrypoint", config.entrypointExecutable, image, JSON.stringify({ mounts: identities, env: childEnv }), spec.command, ...spec.args);
      const wrapped: LaunchSpec = { command: podmanExecutable, args, cwd: settings.cwd, env: { ...process.env }, inheritEnv: false,
        gracefulStop: async () => { await command(["stop", "--ignore", "--time=1", resource.name]); await cleanup(context.agent.generation!); } };
      launches.set(context, { ...wrapped, args: [...wrapped.args] });
      return wrapped;
    });
    host.validateLaunch(async (spec, context) => {
      const expected = launches.get(context);
      if (!expected || spec.command !== expected.command || JSON.stringify(spec.args) !== JSON.stringify(expected.args) || spec.cwd !== expected.cwd || spec.inheritEnv !== false || typeof spec.gracefulStop !== "function")
        throw new ApiError("FORBIDDEN", "Every agent must launch through the final Podman wrapper; load podman after other launch-transforming plugins");
      // No later plugin may insert Podman remote/control environment variables.
      for (const name of ["CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINERS_CONF", "CONTAINERS_STORAGE_CONF", "DOCKER_HOST", "LD_PRELOAD", "LD_LIBRARY_PATH", "PATH", "HOME"])
        if (spec.env?.[name] !== process.env[name]) throw new ApiError("FORBIDDEN", `Final Podman environment changed ${name}`);
      const hostEnv = { ...process.env, ...context.env };
      const reserved = new Set(["ORG_SOCKET", "ORG_TOKEN", "ORG_AGENT_ID"]);
      for (const name of new Set([...Object.keys(hostEnv), ...Object.keys(spec.env ?? {})]))
        if (!reserved.has(name) && spec.env?.[name] !== hostEnv[name]) throw new ApiError("FORBIDDEN", `Final Podman environment changed ${name}`);
      await normalized(context.agent.settings, context.agent, true);
    });
    host.onEvent(async event => {
      if (!["agent.state", "agent.removed"].includes(event.type)) return;
      const data = event.data as { state?: string };
      if (event.type !== "agent.removed" && !["stopped", "failed"].includes(data.state ?? "")) return;
      // Observers are invoked synchronously; capture before awaiting a new generation.
      const keys = [...resources].filter(([, r]) => r.agentId === event.agentId).map(([key]) => key);
      await Promise.all(keys.map(cleanup));
    });
    host.onShutdown(async () => { await Promise.all([...resources.keys()].map(cleanup).concat([...cleanupJobs.values()])); });

    // Client-only orchestration. Each step is revision-fenced; errors return completed steps
    // rather than silently retrying or pretending a multi-process restart is atomic.
    host.registerEndpoint("podman.modify", async (input, caller: Caller) => {
      if (caller.kind !== "client") throw new ApiError("FORBIDDEN", "Only clients may choose image propagation");
      const p = z.object({ agentId: z.string(), expectedRevision: z.number().int(), imageScope: z.enum(["node", "inherited", "all"]),
        name: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(), settings: z.record(z.string(), z.unknown()) }).strict().parse(input);
      const agents = await snapshot();
      const agent = agents.find(a => a.id === p.agentId && !a.removedAt);
      if (!agent) throw new ApiError("NOT_FOUND", "Agent not found");
      if (agent.revision !== p.expectedRevision) throw new ApiError("CONFLICT", "Stale agent revision");
      const extensions = p.settings.extensions as Record<string, unknown> | undefined;
      const next = parseSettings(extensions?.podman);
      if (!extensions || !Object.hasOwn(extensions, "podman")) throw new ApiError("INVALID_PARAMS", "Supply the complete settings.extensions.podman value");
      const operations: Operation[] = [];
      const errors: Array<{ agentId: string; message: string }> = [];
      async function mutate(target: Readonly<AgentRecord>, patch: Record<string, unknown>) {
        let op = await host.request("agent.modify", { agentId: target.id, expectedRevision: target.revision, ...patch }, caller) as Operation;
        while (["queued", "running"].includes(op.status)) op = await host.request("operation.wait", { operationId: op.id, waitMs: 1000 }, caller) as Operation;
        operations.push(op);
        if (op.status !== "completed") throw new Error(op.error?.message ?? `Mutation ${op.status}`);
      }
      const oldImage = effectiveImage(agent, agents, config.defaultImage);
      const proposed = { ...agent, settings: { ...agent.settings, extensions: { ...agent.settings.extensions, podman: next } } };
      const newImage = effectiveImage(proposed, agents, config.defaultImage);
      if (oldImage !== newImage && p.imageScope === "node") {
        // Pin direct inheriting children so their entire branches retain the old image.
        for (const child of agents.filter(a => !a.removedAt && a.parentId === agent.id && !parseSettings(a.settings.extensions?.podman).image)) {
          try { await mutate(child, { settings: { extensions: { podman: { ...parseSettings(child.settings.extensions?.podman), image: oldImage } } } }); }
          catch (error: any) { errors.push({ agentId: child.id, message: error.message }); }
        }
        if (errors.length) return { operations, errors };
      }
      try { await mutate(agent, { settings: p.settings, ...(p.name !== undefined && { name: p.name }), ...(p.metadata !== undefined && { metadata: p.metadata }) }); }
      catch (error: any) { errors.push({ agentId: agent.id, message: error.message }); return { operations, errors }; }
      if (oldImage !== newImage || p.imageScope === "all") {
        for (const child of imageDescendants(agent.id, agents, p.imageScope)) {
          const grants = parseSettings(child.settings.extensions?.podman);
          try {
            if (grants.image) {
              // Clear an explicit override for the "all" scope; modify restarts active agents.
              await mutate(child, { settings: { extensions: { podman: { ...grants, image: null } } } });
            } else if (["idle", "busy", "starting"].includes(child.state)) {
              const current = await host.request("agent.get", { agentId: child.id }, serverCaller) as AgentRecord;
              if (current.revision !== child.revision) throw new Error("Stale descendant revision");
              let op = await host.request("agent.restart", { agentId: child.id }, caller) as Operation;
              while (["queued", "running"].includes(op.status)) op = await host.request("operation.wait", { operationId: op.id, waitMs: 1000 }, caller) as Operation;
              operations.push(op);
              if (op.status !== "completed") throw new Error(op.error?.message ?? `Restart ${op.status}`);
            }
          } catch (error: any) { errors.push({ agentId: child.id, message: error.message }); }
        }
      }
      return { operations, errors };
    });
  } };
}
export const podmanPlugin = createPodmanPlugin();
export default podmanPlugin;
