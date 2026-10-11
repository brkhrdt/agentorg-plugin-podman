import { readFile, rename, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { z } from "zod";
import { ApiError, contains, protect, roots, volumeNames, volumePermission, type ContainerSettings } from "./policy.ts";
import { mountIdentity, type MountIdentity } from "./mounts.ts";

export const volumeConfigSchema = z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(128), z.object({
  destination: z.string().min(1),
  description: z.string().max(256).optional(),
  readOnly: z.boolean().default(false),
}).strict()).default({});
type VolumeConfig = z.output<typeof volumeConfigSchema>;
export interface VolumeChoice { name: string; destination: string; description?: string; readOnly: boolean }
interface Pin { createdAt: string; mountpoint: string; dev: string; ino: string; destination: string; readOnly: boolean }
export interface VolumeMount { argument: string; identity: MountIdentity & { readOnly: boolean } }

/** Only operator-configured local, option-free volumes are eligible. Identity pins
 * live in protected host state, not agent-editable settings, and survive recovery.
 * Replacing/redirecting a volume requires an explicit operator reset of its pin.
 */
export class Volumes {
  private pins: Record<string, Pin> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private config: VolumeConfig, private file: string, private command: (args: string[]) => Promise<string>) {
    for (const entry of Object.values(config)) {
      const path = entry.destination;
      if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.endsWith('/') || /[,\s:\\\0]/.test(path))
        throw new ApiError("INVALID_PARAMS", "Volume destinations must be normalized absolute container paths without mount syntax");
      protect({ readOnlyDirs: [path], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] }, []);

    }
  }
  async initialize(): Promise<void> {
    try {
      this.pins = z.record(z.string(), z.object({ createdAt: z.string(), mountpoint: z.string(), dev: z.string(), ino: z.string(), destination: z.string(), readOnly: z.boolean() }).strict()).parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async inspect(name: string): Promise<Pin> {
    if (!Object.hasOwn(this.config, name)) throw new ApiError("INVALID_PARAMS", `Volume is not eligible: ${name}`);
    const entry = this.config[name]!;
    try {
      const records = JSON.parse(await this.command(["volume", "inspect", name]));
      const v = records[0];
      if (records.length !== 1 || v.Name !== name || v.Driver !== "local" || Object.keys(v.Options ?? {}).length || typeof v.CreatedAt !== "string" || !v.CreatedAt || typeof v.Mountpoint !== "string") throw new Error("Unsupported volume");
      const identity = await mountIdentity(v.Mountpoint);
      return { createdAt: v.CreatedAt, mountpoint: v.Mountpoint, dev: identity.dev, ino: identity.ino, destination: entry.destination, readOnly: entry.readOnly };
    } catch {
      throw new ApiError("FORBIDDEN", `Volume is missing or not a plain local volume: ${name}`);
    }
  }
  private check(name: string, pin: Pin): void {
    if (Object.hasOwn(this.pins, name) && JSON.stringify(this.pins[name]) !== JSON.stringify(pin))
      throw new ApiError("FORBIDDEN", `Volume identity or configuration changed: ${name}; operator reset required`);
  }
  private async pinned(name: string, requirePin: boolean): Promise<Pin> {
    // Serialize first-grant writes so concurrent mutations cannot lose pins.
    const work = this.queue.then(async () => {
      const pin = await this.inspect(name);
      this.check(name, pin);
      if (!Object.hasOwn(this.pins, name)) {
        if (requirePin) throw new ApiError("FORBIDDEN", `Volume has no trusted identity pin: ${name}; update settings through a client`);
        const pins = { ...this.pins, [name]: pin };
        await writeFile(`${this.file}.tmp`, JSON.stringify(pins), { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
        this.pins = pins;
      }
      return pin;
    });
    this.queue = work.catch(() => {});
    return work;
  }
  async list(protectedPaths: string[] = []): Promise<{ volumes: VolumeChoice[] }> {
    const volumes: VolumeChoice[] = [];
    for (const name of Object.keys(this.config).sort()) {
      try {
        protect({ readOnlyDirs: [this.config[name]!.destination], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] }, protectedPaths);
        this.check(name, await this.inspect(name));
      }
      catch { continue; } // Never expose unrelated volumes, host paths or inspect output.
      volumes.push({ name, ...this.config[name]! });
    }
    return { volumes };
  }
  async validate(settings: ContainerSettings, protectedPaths: string[], requirePin: boolean): Promise<VolumeMount[]> {
    const result: VolumeMount[] = [];
    const destinations: string[] = [];
    for (const name of volumeNames(settings)) {
      const entry = this.config[name];
      if (!Object.hasOwn(this.config, name) || !entry) throw new ApiError("INVALID_PARAMS", `Volume is not eligible: ${name}`);
      if (entry.readOnly && volumePermission(settings, name) === 2) throw new ApiError("FORBIDDEN", `Volume permits only read-only access: ${name}`);
      const destination = entry.destination;
      if (destinations.some(p => contains(p, destination) || contains(destination, p)))
        throw new ApiError("INVALID_PARAMS", "Granted volume destinations must not overlap");
      destinations.push(destination);
      protect({ readOnlyDirs: [destination], readWriteDirs: [], readOnlyVolumes: [], readWriteVolumes: [] }, protectedPaths);
      if (roots(settings).some(p => contains(p, destination) || contains(destination, p)))
        throw new ApiError("INVALID_PARAMS", `Volume destination conflicts with a directory grant: ${name}`);
      const pin = await this.pinned(name, requirePin);
      const readOnly = volumePermission(settings, name) === 1;
      result.push({ argument: `${name}:${destination}:${readOnly ? 'ro' : 'rw'},nocopy`, identity: { path: destination, dev: pin.dev, ino: pin.ino, readOnly } });
    }
    return result;
  }
}
