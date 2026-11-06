import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;

test("build emits runnable helpers with their script dependency and executable bits", async () => {
  await exec("npm", ["run", "build"], { cwd: root });
  for (const file of ["agentorg-podman-mcp", "agentorg-podman-exec", "seed-volume.sh"]) {
    const mode = (await stat(join(root, "dist", file))).mode;
    expect(mode & 0o111, file).not.toBe(0);
  }
  await access(join(root, "dist", "seed-pi-config.mjs"), constants.R_OK);
  const mcp = await readFile(join(root, "dist", "agentorg-podman-mcp"), "utf8");
  expect(mcp).not.toMatch(/^import .+ from ["'](?:zod|@modelcontextprotocol\/sdk)/m);
  const script = join(root, "dist", "seed-volume.sh");
  await expect(exec("sh", [script])).rejects.toMatchObject({ code: 2 });
});
