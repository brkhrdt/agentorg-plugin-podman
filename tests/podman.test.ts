import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrganizationServer } from "../../agentorg/src/server.ts";
import { OrganizationClient } from "agent-organization/client";
import type { AgentRecord, Operation } from "agent-organization/types";
import { createPodmanPlugin } from "../src/index.ts";
import { mountIdentity } from "../src/mounts.ts";
import { bindMount } from "../src/policy.ts";

const exec = promisify(execFile);
test.skipIf(process.env.ORG_PODMAN_TEST !== "1")("real rootless Podman: OS-enforced grants, private sessions, native MCP and independent containers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "real-aop-test-"));
  const image = `localhost/aop-test:${crypto.randomUUID()}`;
  let server: OrganizationServer | undefined, client: OrganizationClient | undefined;
  try {
    const binary = join(dir, "container-agent");
    const mcp = join(dir, "agentorg-podman-mcp");
    const gate = join(dir, "agentorg-podman-exec");
    await exec(process.execPath, ["build", "--compile", join(import.meta.dir, "fixtures/container-agent.ts"), "--outfile", binary]);
    await exec(process.execPath, ["build", "--compile", join(import.meta.dir, "../src/mcp.ts"), "--outfile", mcp]);
    await exec(process.execPath, ["build", "--compile", join(import.meta.dir, "../src/entrypoint.ts"), "--outfile", gate]);
    await writeFile(join(dir, "Containerfile"), `FROM ${process.env.ORG_PODMAN_BASE_IMAGE ?? "docker.io/library/debian:unstable"}\nCOPY --chmod=755 container-agent /usr/local/bin/container-agent\nCOPY --chmod=755 agentorg-podman-mcp /usr/local/bin/agentorg-podman-mcp\nCOPY --chmod=755 agentorg-podman-exec /usr/local/bin/agentorg-podman-exec\n`);
    await exec("podman", ["build", "--tag", image, dir], { timeout: 180_000 });
    const ro = join(dir, "ro"), rw = join(dir, "rw"), hidden = join(dir, "hidden");
    await Promise.all([ro, rw, hidden].map(d => mkdir(d)));
    await writeFile(join(ro, "input"), "read-only-input");
    await writeFile(join(hidden, "secret"), "host-secret");
    server = await OrganizationServer.start({ dataDir: join(dir, "data"), socketPath: join(dir, "data/server.sock"), plugins: [
      { apiVersion: 1, name: "fixture", setup(host) { host.registerHarness({ name: "fixture", launch: ({ agent }) => ({ command: "/usr/local/bin/container-agent", args: [], cwd: agent.settings.cwd }) }); } },
      createPodmanPlugin({ defaultImage: image, network: "none", containerUid: process.getuid!(), containerGid: process.getgid!() }),
    ], limits: { startTimeoutMs: 30_000, stopTimeoutMs: 5000 } });
    client = await OrganizationClient.connect(server.organization.socketPath);
    const run = async (method: string, params: unknown) => client!.wait(await client!.request<Operation>(method, params));
    const creation = await run("agent.create", { settings: { harness: "fixture", cwd: rw, extensions: { podman: { readOnlyDirs: [ro], readWriteDirs: [rw] } } } });
    expect(creation.status).toBe("completed");
    if (creation.status !== "completed") throw new Error(JSON.stringify(creation.error));
    const root = creation.result as AgentRecord;
    const session = join(dir, "data/sessions", root.id, "1");
    const work = await run("agent.prompt", { agentId: root.id, text: JSON.stringify({ read: { input: join(ro, "input"), hidden: join(hidden, "secret"), database: join(dir, "data/organization.sqlite") }, write: { denied: join(ro, "new"), allowed: join(rw, "new"), session: join(session, "test") }, call: { name: "child_create", arguments: { settings: { harness: "fixture", cwd: ro }, readOnlyDirs: [ro] } } }) });
    expect(work.status).toBe("completed");
    const result = JSON.parse((work.result as { text: string }).text);
    expect(result).toMatchObject({ uid: process.getuid!(), cwd: rw, token: null, input: "read-only-input", hidden: "ENOENT", database: "ENOENT", denied: "EROFS", allowed: "ok", session: "ok" });
    expect(result.tools).toContain("child_create");
    expect(await readFile(join(rw, "new"), "utf8")).toBe("container-write");
    const childCreation = await client.wait(JSON.parse(result.call.content[0].text));
    expect(childCreation.status).toBe("completed");
    const child = childCreation.result as AgentRecord;
    const childWork = await run("agent.prompt", { agentId: child.id, text: JSON.stringify({ read: { parentRw: join(rw, "new"), parentSession: join(session, "test") }, write: { denied: join(ro, "child-write") } }) });
    expect(JSON.parse((childWork.result as { text: string }).text)).toMatchObject({ parentRw: "ENOENT", parentSession: "ENOENT", denied: "EROFS" });
    const running = (await exec("podman", ["ps", "--format", "{{.Names}}"])).stdout;
    expect(running.split("\n").filter(n => n.startsWith("aop-")).length).toBeGreaterThanOrEqual(2);
    await run("agent.remove", { agentId: root.id });
    const remaining = (await exec("podman", ["ps", "--format", "{{.Names}}"])).stdout;
    expect(remaining).not.toContain(root.generation!);
    // Simulate a malicious directory substitution after host authorization but
    // before Podman binds the source. The harness must never execute.
    const identity = await mountIdentity(ro);
    await rename(ro, join(dir, "original-ro")); await symlink(hidden, ro);
    await expect(exec("podman", ["run", "--rm", "--network=none", "--userns=keep-id", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--mount", bindMount(ro, true), "--mount", bindMount(rw, false),
      "--entrypoint", "/usr/local/bin/agentorg-podman-exec", image, JSON.stringify({ mounts: [identity], env: {} }), "/bin/bash", "-c", `echo escaped > '${rw}/escaped'`])).rejects.toThrow("Mount identity changed");
    await expect(readFile(join(rw, "escaped"))).rejects.toThrow("ENOENT");
  } finally {
    client?.close(); await server?.close();
    await exec("podman", ["image", "rm", "--force", image]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 240_000);
