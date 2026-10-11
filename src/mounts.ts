import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { ApiError } from "./policy.ts";

export interface MountIdentity { path: string; dev: string; ino: string }
/** Pin the authorized inode while recording its identity. Checking the opened FD's
 * real path also detects symlink substitutions in any ancestor, not just the leaf.
 * The image's startup gate checks the bound inode BEFORE executing the harness.
 */
export async function mountIdentity(path: string, socket = false): Promise<MountIdentity> {
  if (socket) {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isSocket()) throw new ApiError("FORBIDDEN", "Relay socket was replaced");
    return { path, dev: String(stat.dev), ino: String(stat.ino) };
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (await realpath(`/proc/${process.pid}/fd/${handle.fd}`) !== path) throw new ApiError("FORBIDDEN", `Mount path changed while preparing launch: ${path}`);
    const stat = await handle.stat({ bigint: true });
    return { path, dev: String(stat.dev), ino: String(stat.ino) };
  } finally { await handle.close(); }
}
