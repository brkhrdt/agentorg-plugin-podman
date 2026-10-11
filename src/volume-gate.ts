/** Verify explicit mount boundaries and requested access, in addition to inode
 * checks. Fail if a destination resolved through an image symlink elsewhere. */
export function verifyVolumeMounts(volumes: { path: string; readOnly: boolean }[], mountinfo: string): void {
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
  const mounts = mountinfo.trim().split("\n").map(line => line.split(" "));
  for (const volume of volumes) {
    const matches = mounts.filter(fields => unescape(fields[4] ?? "") === volume.path);
    if (matches.length !== 1 || !matches[0]![5]!.split(",").includes(volume.readOnly ? "ro" : "rw"))
      throw new Error(`Volume mount destination or access changed before container startup: ${volume.path}`);
  }
}
