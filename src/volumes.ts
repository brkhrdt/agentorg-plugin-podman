import { readFile, rename, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { ApiError, contains, protect, roots, volumeNames, volumePermission, type ContainerSettings } from "./policy.ts";
import { mountIdentity, type MountIdentity } from "./mounts.ts";

export const volumeNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(128);
/** Optional operator defaults, not an eligibility allowlist. */
export const volumeConfigSchema = z.record(volumeNameSchema, z.object({
  destination: z.string().min(1),
  description: z.string().max(256).optional(),
  readOnly: z.boolean().default(false),
}).strict()).default({});
type VolumeConfig = z.output<typeof volumeConfigSchema>;
type Mapping = VolumeConfig[string];
export interface VolumeChoice { name: string; destination?: string; description?: string; readOnly: boolean }
interface Identity { createdAt: string; mountpoint: string; dev: string; ino: string }
interface Pin extends Identity { destination: string; readOnly: boolean }
export interface VolumeMount { argument: string; identity: MountIdentity & { readOnly: boolean } }

/** Pure destination policy, shared by startup/settings validation and runtime grants. */
export function validateVolumeDestination(path: string, protectedPaths: string[] = []): void {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.endsWith('/') || /[,\s:\\\0]/.test(path))
    throw new ApiError("INVALID_PARAMS", "Volume destinations must be normalized absolute container paths without mount syntax");
  protect({ readOnlyDirs: [path], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] }, protectedPaths);
}

/** Discover existing plain local volumes. Trusted clients register destinations;
 * agents only delegate names and permissions. Registrations/identity pins live in
 * protected host state and survive recovery, without plugin config or restarts.
 */
export class Volumes {
  private pins: Record<string, Pin> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private config: VolumeConfig, private file: string, private command: (args: string[]) => Promise<string>) {
    for (const entry of Object.values(config)) validateVolumeDestination(entry.destination);
  }
  async initialize(): Promise<void> {
    try {
      this.pins = z.record(volumeNameSchema, z.object({ createdAt: z.string(), mountpoint: z.string(), dev: z.string(), ino: z.string(), destination: z.string(), readOnly: z.boolean() }).strict()).parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private mapping(name: string): Mapping | undefined {
    if (Object.hasOwn(this.config, name)) return this.config[name];
    if (Object.hasOwn(this.pins, name)) return { destination: this.pins[name]!.destination, readOnly: this.pins[name]!.readOnly };
  }
  private async inspect(name: string): Promise<Identity> {
    if (!volumeNameSchema.safeParse(name).success) throw new ApiError("INVALID_PARAMS", "Invalid volume name");
    try {
      const records = JSON.parse(await this.command(["volume", "inspect", name]));
      const v = records[0];
      if (records.length !== 1 || v.Name !== name || v.Driver !== "local" || Object.keys(v.Options ?? {}).length || typeof v.CreatedAt !== "string" || !v.CreatedAt || typeof v.Mountpoint !== "string") throw new Error("Unsupported volume");
      const identity = await mountIdentity(v.Mountpoint);
      return { createdAt: v.CreatedAt, mountpoint: v.Mountpoint, dev: identity.dev, ino: identity.ino };
    } catch {
      throw new ApiError("FORBIDDEN", `Volume is missing or not a plain local volume: ${name}`);
    }
  }
  private async inspectPin(name: string, mapping: Mapping): Promise<Pin> {
    return { ...await this.inspect(name), destination: mapping.destination, readOnly: mapping.readOnly };
  }
  private check(name: string, pin: Pin): void {
    if (Object.hasOwn(this.pins, name) && JSON.stringify(this.pins[name]) !== JSON.stringify(pin))
      throw new ApiError("FORBIDDEN", `Volume identity or configuration changed: ${name}; operator reset required`);
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const work = this.queue.then(fn);
    this.queue = work.catch(() => {});
    return work;
  }
  private async save(name: string, pin: Pin): Promise<void> {
    const pins = { ...this.pins, [name]: pin };
    await writeFile(`${this.file}.tmp`, JSON.stringify(pins), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
    this.pins = pins;
  }
  private pinned(name: string, mapping: Mapping, requirePin: boolean): Promise<Pin> {
    return this.serialized(async () => {
      const pin = await this.inspectPin(name, mapping);
      this.check(name, pin);
      if (!Object.hasOwn(this.pins, name)) {
        if (requirePin) throw new ApiError("FORBIDDEN", `Volume has no trusted identity pin: ${name}; update settings through a client`);
        await this.save(name, pin);
      }
      return pin;
    });
  }
  /** Caller authorization belongs to the client-only endpoint. Registration does
   * not grant access to any agent. Once pinned, remapping requires operator reset. */
  async configure(name: string, destination: string, protectedPaths: string[]): Promise<VolumeChoice> {
    validateVolumeDestination(destination, protectedPaths);
    return this.serialized(async () => {
      const existing = this.mapping(name);
      if (existing && existing.destination !== destination)
        throw new ApiError("FORBIDDEN", `Volume destination already configured: ${name}; operator reset required`);
      const mapping = existing ?? { destination, readOnly: false };
      const pin = await this.inspectPin(name, mapping);
      this.check(name, pin);
      if (!Object.hasOwn(this.pins, name)) await this.save(name, pin);
      return { name, ...mapping };
    });
  }
  async list(protectedPaths: string[] = []): Promise<{ volumes: VolumeChoice[] }> {
    let names: string[];
    try { names = (await this.command(["volume", "ls", "--format", "{{.Name}}"])).split("\n"); }
    catch { throw new ApiError("UNAVAILABLE", "Could not discover host Podman volumes"); }
    const volumes: VolumeChoice[] = [];
    for (const name of [...new Set(names.filter(n => volumeNameSchema.safeParse(n).success))].sort()) {
      const mapping = this.mapping(name);
      try {
        if (mapping) {
          validateVolumeDestination(mapping.destination, protectedPaths);
          this.check(name, await this.inspectPin(name, mapping));
        } else await this.inspect(name);
      } catch { continue; } // Never expose host paths, contents or inspect output.
      volumes.push({ name, ...(mapping ?? { readOnly: false }) });
    }
    return { volumes };
  }
  async validate(settings: ContainerSettings, protectedPaths: string[], requirePin: boolean): Promise<VolumeMount[]> {
    const result: VolumeMount[] = [];
    const destinations: string[] = [];
    for (const name of volumeNames(settings)) {
      const entry = this.mapping(name);
      if (!entry) throw new ApiError("INVALID_PARAMS", `Choose a container destination for volume ${name} through the client-only podman.volume.configure endpoint first`);
      if (entry.readOnly && volumePermission(settings, name) === 2) throw new ApiError("FORBIDDEN", `Volume permits only read-only access: ${name}`);
      const destination = entry.destination;
      if (destinations.some(p => contains(p, destination) || contains(destination, p)))
        throw new ApiError("INVALID_PARAMS", "Granted volume destinations must not overlap");
      destinations.push(destination);
      validateVolumeDestination(destination, protectedPaths);
      if (roots(settings).some(p => contains(p, destination) || contains(destination, p)))
        throw new ApiError("INVALID_PARAMS", `Volume destination conflicts with a directory grant: ${name}`);
      const pin = await this.pinned(name, entry, requirePin);
      const readOnly = volumePermission(settings, name) === 1;
      result.push({ argument: `${name}:${destination}:${readOnly ? 'ro' : 'rw'},nocopy`, identity: { path: destination, dev: pin.dev, ino: pin.ino, readOnly } });
    }
    return result;
  }
}
