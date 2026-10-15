import { z } from "zod";
import type { ServerSettingsField } from "agent-organization/plugin";
import { containerRuntimeSchema, harnessEnvSchema, networkSchema, parseSettings } from "./policy.ts";

export const containerProfileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).max(128), name: z.string().trim().min(1).max(128),
  image: z.string().min(1).max(4096).refine(value => !value.startsWith("-") && !/[\s\0]/.test(value), "Invalid image reference"),
  network: networkSchema, containerUid: containerRuntimeSchema.shape.containerUid, containerGid: containerRuntimeSchema.shape.containerGid,
  harnessEnv: harnessEnvSchema,
  harness: z.string().max(128), provider: z.string().max(256), model: z.string().max(256), cwd: z.string().max(4096),
  readOnlyDirs: z.array(z.string().min(1)).max(128), readWriteDirs: z.array(z.string().min(1)).max(128),
  readOnlyVolumes: z.array(z.string().min(1)).max(128), readWriteVolumes: z.array(z.string().min(1)).max(128),
}).strict().superRefine((profile, ctx) => {
  try { parseSettings({ image: profile.image, readOnlyDirs: profile.readOnlyDirs, readWriteDirs: profile.readWriteDirs,
    readOnlyVolumes: profile.readOnlyVolumes, readWriteVolumes: profile.readWriteVolumes }); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid or conflicting container grants" }); }
});
export type ContainerProfile = z.output<typeof containerProfileSchema>;
export const profilesSchema = z.array(containerProfileSchema).max(128).refine(profiles => new Set(profiles.map(p => p.id)).size === profiles.length, "Duplicate container configuration IDs");
const field = (key: string, label: string, editor: ServerSettingsField['editor'], extra: Partial<ServerSettingsField> = {}): ServerSettingsField => ({ key, label, editor, effect: "future-launch", ...extra });
export const profileFields: ServerSettingsField[] = [
  field("name", "Name", "text"), field("image", "Image", "text", { choicesEndpoint: "podman.choices.images" }),
  field("network", "Network", "select", { choices: ["pasta", "slirp4netns", "none"] }),
  field("containerUid", "Container UID", "number", { min: 1, max: 65535 }), field("containerGid", "Container GID", "number", { min: 1, max: 65535 }),
  field("harness", "Harness", "text", { choicesEndpoint: "podman.choices.harnesses", description: "Optional default harness; blank retains the agent draft's harness." }),
  field("provider", "Provider (manual)", "text"), field("model", "Model (manual)", "text"), field("cwd", "Default working directory", "text"),
  field("readOnlyDirs", "Read-only directory defaults", "list"), field("readWriteDirs", "Read/write directory defaults", "list"),
  field("readOnlyVolumes", "Read-only volumes", "list", { choicesEndpoint: "podman.choices.volumes.ro" }),
  field("readWriteVolumes", "Read/write volumes", "list", { choicesEndpoint: "podman.choices.volumes.rw" }),
  field("harnessEnv", "Harness variable names", "list"),
  field("id", "Stable ID", "text"),
];
