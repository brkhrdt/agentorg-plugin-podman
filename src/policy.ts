import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { homedir } from "node:os";

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export const containerSettingsSchema = z.object({
  image: z.string().min(1).refine(s => !s.startsWith("-") && !/\s|\0/.test(s), "Invalid image reference").nullable().optional(),
  readOnlyDirs: z.array(z.string().min(1)).max(128).default([]),
  readWriteDirs: z.array(z.string().min(1)).max(128).default([]),
  readOnlyVolumes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(128)).max(128).default([]),
  readWriteVolumes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(128)).max(128).default([]),
}).strict().refine(settings => {
  const names = [...settings.readOnlyVolumes, ...settings.readWriteVolumes];
  return new Set(names).size === names.length;
}, "Duplicate or conflicting volume grants");
export type ContainerSettings = z.infer<typeof containerSettingsSchema>;
export function parseSettings(value: unknown): ContainerSettings {
  const result = containerSettingsSchema.safeParse(value ?? {});
  if (!result.success) throw new ApiError("INVALID_PARAMS", result.error.message);
  return result.data;
}
export function contains(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return !r || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}
export async function directory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
    if (/[,:\n\r\0]/.test(canonical)) throw new Error("Unsupported mount path characters");
    return canonical;
  } catch {
    throw new ApiError("INVALID_PARAMS", `Mount/cwd must be an existing directory without commas, colons or line breaks: ${path}`);
  }
}
/** Canonicalize even a not-yet-created control path through its existing ancestors. */
export async function canonicalFuturePath(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  while (true) {
    try { return resolve(await realpath(current), ...tail.reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current)); current = parent;
    }
  }
}
export function hostPath(path: string, base: string): string {
  return resolve(base, path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path);
}
export async function normalize(value: unknown, base: string): Promise<ContainerSettings> {
  const settings = parseSettings(value);
  const canonical = async (paths: string[]) => [...new Set(await Promise.all(paths.map(p => directory(hostPath(p, base)))))].sort();
  const readOnlyDirs = await canonical(settings.readOnlyDirs);
  const readWriteDirs = await canonical(settings.readWriteDirs);
  if (readOnlyDirs.some(p => readWriteDirs.includes(p))) throw new ApiError("INVALID_PARAMS", "A directory cannot be both read-only and read/write");
  return { ...settings, readOnlyDirs, readWriteDirs };
}
export function roots(settings: ContainerSettings): string[] {
  return [...settings.readOnlyDirs, ...settings.readWriteDirs];
}
/** Most specific mount wins, including a read-only island inside a writable directory. */
export function permission(settings: ContainerSettings, path: string): number {
  let length = -1, mode = 0;
  for (const [paths, access] of [[settings.readOnlyDirs, 1], [settings.readWriteDirs, 2]] as const)
    for (const root of paths) if (contains(root, path) && root.length > length) { length = root.length; mode = access; }
  return mode;
}
/** Check all permission boundaries, not merely each requested mount's root. */
export function requireDelegation(next: ContainerSettings, previous: ContainerSettings, caller: ContainerSettings, parent: ContainerSettings): void {
  const boundaries = new Set([...roots(next), ...roots(previous), ...roots(caller), ...roots(parent)]);
  for (const path of boundaries) {
    const mode = permission(next, path);
    if (mode > permission(previous, path) && (mode > permission(caller, path) || mode > permission(parent, path)))
      throw new ApiError("FORBIDDEN", `Cannot delegate ${mode === 2 ? "read/write" : "read-only"} access to ${path}; both caller and direct parent must have that access`);
  }
}
export function volumeNames(settings: ContainerSettings): string[] {
  return [...settings.readOnlyVolumes, ...settings.readWriteVolumes];
}
export function volumePermission(settings: ContainerSettings, name: string): number {
  return settings.readWriteVolumes.includes(name) ? 2 : settings.readOnlyVolumes.includes(name) ? 1 : 0;
}
export function requireVolumeDelegation(next: ContainerSettings, previous: ContainerSettings, caller: ContainerSettings, parent: ContainerSettings): void {
  for (const name of volumeNames(next)) {
    const mode = volumePermission(next, name);
    if (mode > volumePermission(previous, name) && (mode > volumePermission(caller, name) || mode > volumePermission(parent, name)))
      throw new ApiError("FORBIDDEN", `Cannot delegate volume ${name}; both caller and direct parent must have sufficient access`);
  }
}
export function protect(settings: ContainerSettings, protectedPaths: string[]): void {
  for (const path of roots(settings)) {
    if (protectedPaths.some(p => contains(path, p) || contains(p, path)))
      throw new ApiError("FORBIDDEN", `Mount overlaps protected host state: ${path}`);
    // Mounting over the image's executables or runtime plumbing could bypass the adapter/relay.
    if (["/proc", "/sys", "/dev", "/run", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64"].some(p => contains(path, p) || contains(p, path)))
      throw new ApiError("FORBIDDEN", `Mount overlaps container or host runtime paths: ${path}`);
  }
}
export function bindMount(source: string, readOnly: boolean): string {
  // Nonrecursive binds prevent writable host submounts leaking through a read-only grant.
  return `type=bind,src=${source},dst=${source},ro=${readOnly},bind-propagation=rprivate,bind-nonrecursive=true`;
}
