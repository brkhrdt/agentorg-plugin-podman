import { readFile, stat } from "node:fs/promises";
import { verifyVolumeMounts } from "./volume-gate.ts";
import { z } from "zod";

const config = z.object({
  mounts: z.array(z.object({ path: z.string().min(1), dev: z.string(), ino: z.string() }).strict()),
  volumes: z.array(z.object({ path: z.string().min(1), dev: z.string(), ino: z.string(), readOnly: z.boolean() }).strict()).default([]),
  env: z.record(z.string(), z.string()),
}).strict().parse(JSON.parse(process.argv[2] ?? "null"));
const argv = process.argv.slice(3);
if (!argv.length) throw new Error("Container harness command is required");
for (const expected of config.mounts) {
  const actual = await stat(expected.path, { bigint: true });
  if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino)
    throw new Error(`Mount identity changed before container startup: ${expected.path}`);
}
if (config.volumes.length) {
  const mountinfo = await readFile("/proc/self/mountinfo", "utf8");
  for (const expected of config.volumes) {
    const actual = await stat(expected.path, { bigint: true });
    if (String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino)
      throw new Error(`Volume identity changed before container startup: ${expected.path}`);
  }
  verifyVolumeMounts(config.volumes, mountinfo);
}
// No harness or MCP code runs before all mounts have been verified. The container
// has a private mount namespace and no CAP_SYS_ADMIN, so it cannot replace them.
// Untrusted runtime/loader variables are applied only here, never to this gate.
const child = Bun.spawn(argv, { env: { ...process.env, ...config.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
