# @agentorg/plugin-podman

Run **every agent in its own rootless Podman container**. Children inherit their
nearest ancestor's image, not its container or filesystem grants. Grants default
to empty. There is no host-harness fallback if container startup fails.

## Example Pi image

Requires Linux, Bun 1.4.3+, rootless Podman with `pasta` networking, and the adjacent
`agentorg` and `agentorg-plugin-pi-agent` repositories. Set up rootless Podman's
subuid/subgid mappings first. The server itself must run as a non-root user.

```sh
cd agentorg-plugin-podman
sh examples/pi/build.sh
# Optional: sh examples/pi/build.sh --build-arg PI_VERSION=1.0.2
# Build, then create/seed a minimal Pi config volume (credentials never enter the image):
# sh examples/pi/build.sh --seed-volume agentorg-pi-config

cd ../agentorg
bun start --data-dir /tmp/my-agentorg-data \
          --plugin ../agentorg-plugin-pi-agent/src/index.ts \
          --plugin ../agentorg-plugin-podman/src/index.ts
```

The example [Containerfile](examples/pi/Containerfile) is based on your
`debian:unstable` image: Node/npm, Pi, bash, build tools, ripgrep and fd, with a
non-root `pi` user. It additionally installs three native binaries:

* `agentorg-pi-acp`: the Pi harness plugin's adapter;
* `agentorg-podman-mcp`: a stdio MCP client for the private relay;
* `agentorg-podman-exec`: the mount-identity gate that runs before the harness.

Build binaries for the image's CPU architecture. The example does not bake in
credentials. No Bun installation inside the image is necessary. Images must
already exist locally (`--pull=never`). Other ACP harnesses can be used if their
command and runtime are installed in the image; the host never mounts their
executables or source automatically.

Load Podman **after other launch-transforming plugins**. The final launch
validator rejects wrappers that bypass/alter Podman. For compiled deployments,
`bun run build` creates `dist/index.js` and the two helper binaries; load the
external `dist/index.js` and install the helpers in each image.

## Directory grants and client API

Use `settings.extensions.podman`:

```json
{
  "harness": "pi",
  "cwd": "/tmp/project",
  "env": {"PI_CODING_AGENT_DIR": "/home/alice/.pi/agent"},
  "extensions": {
    "podman": {
      "image": "localhost/agentorg-pi:latest",
      "readOnlyDirs": ["/home/alice/.pi"],
      "readWriteDirs": ["/tmp/project"]
    }
  }
}
```

Send this as `agent.create.params.settings`. Modify with `agent.modify` and a
complete `settings.extensions.podman` value. Supplying that namespace **replaces**
it; other plugin namespaces are preserved. `image: null` (or omission) inherits
from the nearest explicit ancestor, falling back to the configured default.

* `cwd` must be explicit, existing, and covered by a grant. Read-only cwd is valid.
* All granted directories must already exist. Create subdirectories through
  container filesystem tools, inside writable mounts, before granting them.
* Paths are canonicalized through symlinks and persisted as absolute paths.
  Relative paths resolve from the direct parent's cwd, or server cwd for roots;
  `~/` resolves from the server user's home. Host and container mount paths are
  identical, preserving relationships between mounted directories.
* A more-specific mount takes precedence: a read-only directory can be nested
  within a writable workspace. Nonrecursive binds do not expose host submounts.
* There are **no implicit workspace or credential grants**, and grants are never
  automatically copied to children.
* Named volumes are separate grants (`readOnlyVolumes` / `readWriteVolumes`), never
  inferred from directories or cwd. See [Persistent harness volumes](#persistent-harness-volumes).
* Trusted clients can grant an agent an external directory independently of its
  ancestors. That agent can subsequently delegate it to children. Client changes
  do not automatically propagate/revoke subtree grants.
* Keep the organization data directory/socket **outside granted workspaces**. A
  workspace containing the default `.org` directory cannot be mounted; choose a
  separate `--data-dir` as above. Existing records need explicit grants before
  recovery can launch them; enabling the plugin never automatically grants access.
* Host organization data/socket, Podman storage/config/runtime state, private relays, and
  system paths such as `/proc`, `/run`, `/usr` and `/etc` cannot be workspace grants.
  This prevents mounting the public socket/database or replacing image helpers.

Credentials may be baked into a trusted image, or explicitly mounted as above.
Set `PI_CODING_AGENT_DIR` when the mounted configuration path differs from the
image's default `/home/pi/.pi/agent`. Read-only credentials may prevent token
refresh or configuration updates; if necessary grant that configuration directory
read/write explicitly. Do not bake credentials into an image you distribute.

## Agent MCP tools and delegation

`child_create` and `descendant_modify` gain top-level arrays `readOnlyDirs`,
`readWriteDirs`, `readOnlyVolumes` and `readWriteVolumes`. Each pair independently
replaces that kind of grant; an omitted array is empty when its partner is supplied.
No mounts are inferred from `cwd` or inherited from parents. Volume names use exact
identity matching, with the same caller/direct-parent RO/RW delegation and dependent
child revocation checks as directories. Only trusted clients can discover volumes.

```json
{
  "name": "reviewer",
  "settings": {"harness": "pi", "cwd": "src"},
  "readOnlyDirs": ["src"],
  "readWriteDirs": []
}
```

When an agent adds access, **both the caller and the target's direct parent**
must cover it with sufficient permissions. Equal directories and subdirectories
are allowed. Read-only can delegate only read-only; writable can delegate either.
Checks include nested permission boundaries, symlink resolution, and launch-time
revalidation, not just string prefixes. Unchanged client-provided target grants
may be retained without reauthorizing them. Agents cannot reduce parent grants
while leaving formerly dependent children with greater access. Agents cannot
choose/change images. Core's existing strict-descendant authorization still
applies; agents cannot modify themselves, ancestors, or siblings.

The container sees only a generation-specific, MCP-only Unix relay, not the
public organization socket. The host supplies its own capability for every
forwarded request and ignores model-supplied identity/token fields. Stale tokens
are rejected by core, and relays are closed when the generation stops. The relay
bounds records, outstanding requests, connections, and output buffering.

## TUI and image propagation

The TUI discovers `capabilities.plugins.podman` and adds `containerImage`,
`readOnlyDirs`, `readWriteDirs`, `readOnlyVolumes` and `readWriteVolumes` editor fields.
Volumes use the same add/edit/remove list workflow, with server-discovered choices:
text fuzzy-filters names, ↑/↓ selects, Tab completes, Enter stages and Escape cancels.
Destinations/descriptions are displayed, never host storage paths. Discovery failures
preserve drafts; arbitrary typed volume names cannot be staged through the picker. Directory grants use a reusable
list editor with add/edit/remove, filtering and server-side cwd-like completion
(↑/↓ select, Tab inserts/descends, Enter stages). They are still arrays in the API,
not JSON prompts in the UI. Completion uses the parent/server startup base, never
client-local paths, and requires existing directories rather than creating grants.
The plugin also advertises these generic `directories` descriptors under
`capabilities.settingsEditors.podman` for other clients; the TUI avoids duplicate
fields. A blank image means inherit. Provider/model entry is manual in container mode:
image-based catalog discovery is not implemented, and the TUI does not use the
host's potentially different credentials/catalog. Trusted clients can still
explicitly query the separate host discovery API. Saving an image change asks for:

1. **This node only**: pin directly inheriting child branches to the old image.
2. **Inheriting descendants**: restart descendants following this image, stopping
   traversal at explicit overrides.
3. **All descendants**: clear descendant overrides and restart active descendants
   with the new image.

Clients can explicitly choose the same behavior using `podman.modify`:

```json
{
  "agentId": "node-id",
  "expectedRevision": 4,
  "imageScope": "inherited",
  "settings": {
    "extensions": {
      "podman": {
        "image": "localhost/agentorg-pi:v2",
        "readOnlyDirs": ["/tmp/project"],
        "readWriteDirs": []
      }
    }
  }
}
```

This client-only endpoint also accepts `name` and `metadata` and returns
`{operations, errors}` after the individual operations finish. Updates are
revision-fenced, but multi-node orchestration is **not atomic**. Errors report
partial completion; clients must refresh and must not blindly retry. Stopped or
failed descendants remain stopped/failed. "Node only" may restart active direct
children while pinning their image; their descendants keep their old effective
image. Raw `agent.modify` does not offer propagation scopes: inherited descendants
observe a changed ancestor image on their next explicit restart.

## Named container configurations

Configure reusable containers through **v → s → Podman containers → Container
configurations**. Press **a** to add, Enter to edit, or **d** to remove a named
configuration. The entry opens a field form—no raw JSON object is required.
Choose an image from the server's local Podman store, choose network, UID/GID,
harness defaults, working directory and explicit RO/RW directory/volume defaults.
New entries seed runtime defaults from the current settings draft, not stale
startup values. Environment values/credentials and arbitrary secret-bearing
harness options are deliberately not configuration fields.

Images and volumes are discovered **on the server**, never on the TUI machine.
Volumes without a destination prompt for an absolute **container** path before
selection. This trusted registration persists independently of the draft, but
never grants an agent access by itself. RW choices exclude RO-only volumes.
**pasta**, **slirp4netns**, and **none** are the supported network modes; network
is a bounded selector, not arbitrary text. The appropriate pasta/slirp4netns
helper must be installed on the server. `slirp4netns` disables host loopback.

Press **S** to stage the entry into its list, **S** to stage the list into the
server draft, then **S** and confirm the server-wide save. Names, IDs, public
values and grant syntax are validated before saving. Changed catalogs also check
that image references exist **locally** (without pulling) and any explicit
harness names are loaded. This is not a mount test or an in-container capability
probe: provider/model defaults remain manual, and image/runtime/adapter
compatibility is still ultimately checked on launch. Capability-driven model and
option discovery remains a follow-up.

When creating an agent (**n**), open **Container configuration** and select the
saved entry. Its image, runtime settings, cwd and grant defaults populate the
**draft** for review. Selecting a different entry clears/replaces stale provider/
model choices. Review cwd coverage and every grant before saving; the usual
launch-time protection, normalization and delegation checks remain authoritative.
The image field also has a live local-image picker (`m` for manual/inherited
entry). Older servers without these capabilities retain manual editing.

Creation persists a detached runtime/image/grant snapshot plus configuration ID,
name and catalog revision in `settings.extensions.podman`. A stale/deleted
selection before creation returns `CONFLICT`: select it again, don't blindly
retry. Editing/resetting/deleting a catalog entry never rewrites or restarts
existing agents. Their snapshots remain usable even after the entry disappears;
per-agent grant edits preserve those snapshots. Children inherit an ancestor's
explicit image/runtime, **never its filesystem or volume grants**. Configuration
selection and runtime changes are client-only, with no MCP management tool.

API discovery advertises `plugins.podman.endpoints.profiles` and `.images`:
`podman.profiles {}` returns `{revision, profiles}`. Catalog entries live in the
shared core-owned `organization.settings.get/update` group `podman`, field
`containers`, with version-1/2 settings migrated to version 3. Each entry has
`id`, `name`, `image`, `network`, `containerUid`, `containerGid`, `harnessEnv`
(variable names only), `harness`, `provider`, `model`, `cwd`, `readOnlyDirs`,
`readWriteDirs`, `readOnlyVolumes`, and `readWriteVolumes`. The core still owns
persistence, revisions, reset, authorization and atomic change events.

## Server-wide Podman settings

The default settings now use the **same four lists** as named configurations:
**Read-only directory defaults**, **Read/write directory defaults**, **Read-only
volumes**, and **Read/write volumes**. Volume lists use server-discovered pickers
on **a**; unknown destinations prompt for a path **inside the container**. Known
destinations are reused and RW choices exclude RO-only volumes.

Saved lists seed **new client-created agent drafts** and **new configurations**
(the latter use the current settings draft, including unsaved edits). Review and
save explicitly. They apply without a server restart and never rewrite existing
agents or saved configurations. Agent/MCP-created children and raw API requests
still supply explicit grants: these defaults never silently expand authority.
Reset/deletion does not delete host data or registrations/pins. Explicit volume
destination registration persists independently of the settings draft.

The old `volumes` destination-policy map is retained as a deprecated public API/
operator compatibility setting, omitted from the normal TUI form. Version-1/2
migrations preserve it, including existing RO restrictions and pins; its entries
are **not** silently converted into grants. Legacy policy edits still require a
server restart and cannot remap or weaken an existing identity pin.

Requires an AgentOrg server with the public server-settings framework. Podman
opts in under namespace **`podman`**; the TUI discovers its fields automatically.
Open **v → s → Podman containers**, stage changes, then **S** and confirm the
server-wide save. These are not per-agent grants or client preferences. Every
trusted socket client sees the same persisted configuration; agents cannot read
or edit the settings API, and no settings MCP tool is provided.

| Setting | Effect |
| --- | --- |
| `defaultImage` | Future launches/restarts without an explicit ancestor image |
| `network` (`pasta`, `slirp4netns`, `none`) | Future launches |
| `containerUid`, `containerGid` (integers 1–65535) | Future launches |
| `harnessEnv` (unique variable **names**, not values) | Future launches |
| `containers` (named configurations) | Newly selected agent drafts; existing snapshots unchanged |
| `readOnlyDirs`, `readWriteDirs` | New agent drafts / new configurations |
| `readOnlyVolumes`, `readWriteVolumes` | New agent drafts / new configurations |
| `volumes` (deprecated compatibility destination policy; omitted from TUI) | Server restart |
| `podmanExecutable` (trusted host path/PATH command) | Server restart |
| `mcpExecutable`, `entrypointExecutable` (trusted image helpers) | Server restart |

Saves never automatically restart agents or change their revisions/grants. Each
launch captures one detached configuration snapshot across its asynchronous
preparation/wrapping hooks. Restart-only fields retain their old effective values
and display a restart-required indicator until the server reopens. The resolved
Podman executable, cleanup commands, protected helper paths, and legacy volume
destination policy stay consistent throughout the current server lifetime.

`defaultImage` changes the fallback for **subsequent** launches, including new
children of a running ancestor whose image is not explicitly set. Explicit agent
or ancestor images still win. Running containers keep their current image/network/
UID/GID/environment until an explicit lifecycle operation creates a new container.
Changing the server fallback is not a subtree image-propagation operation.

Use `organization.settings.get {namespace: "podman"}` to get descriptors, revision,
startup defaults, desired values, effective values, and pending restarts. Update
with the current revision, for example:

```json
{"namespace":"podman","expectedRevision":0,"patch":{"defaultImage":"localhost/agentorg-pi:v2","network":"none"}}
```

Reset removes overrides, restoring the current plugin-module startup defaults:

```json
{"namespace":"podman","expectedRevision":1,"reset":["defaultImage","network"]}
```

Core owns SQLite persistence, atomic change events and revision checks. Saved
overrides survive restart and override module options. Stale saves fail with
`CONFLICT`; the TUI retains the draft without retrying. Values are authoritative
in `organization.settings.get/list`; `capabilities.plugins.podman.defaultImage`
remains a legacy **startup hint**, and `serverSettingsNamespace: "podman"` points
to the editable configuration. Per-agent `settingsNamespace` remains separate.

Validation before saving checks image-reference syntax, integer bounds, network
choices, executable syntax, variable-name uniqueness, strict volume mapping
shape/destination policy, and named-configuration schema. Unknown/nested
credential fields are rejected. Ordinary reads and unrelated/no-op saves do not
execute availability checks. Changed configuration catalogs inspect local images
before committing; they never pull images or test mounts. Host executable
existence/rootless checks run at initialization; image/helper compatibility is
checked on launch. In-container capability probes are not implemented yet.
No environment values, credentials, volume contents or host volume mountpoints
are settings fields. `harnessEnv` names
select values from trusted harness specs only, never ambient host variables; the
generation token is always stripped.

The four defaults are independent lists. For example, a settings patch can contain:

```json
{"readOnlyDirs":["/srv/config"],"readWriteDirs":["/srv/work"],"readOnlyVolumes":["pi-config"],"readWriteVolumes":[]}
```

`plugins.podman.endpoints.defaults` advertises `podman.defaults {}`, which returns
these four effective lists to trusted clients (no I/O or agent/MCP access). TUI
new-agent creation reads a fresh, detached copy before opening the draft; failure
or canceled navigation never silently falls back to missing defaults.

Legacy `volumes` policy remains an object map through module options/API only,
for example `{"pi-config":{"destination":"/home/pi/.pi","readOnly":true}}`.
It is **not** an eligibility allowlist or a grant list. Use the legacy settings
API to remove its overrides; `{}` empties that policy, while reset restores
operator policy defaults.
Deleting/resetting an entry does **not** delete a host volume, revoke any agent
grant, or erase its trusted destination/identity pin. Previously registered/pinned
volumes keep their mappings and RO-only policy even after removal from defaults.
Changing a pinned destination or policy fails closed after restart; deliberate
remapping still requires the explicit operator reset described below. Use agent
grant editors to revoke access and `podman volume rm` separately to delete data.

## Operator configuration

Module options define startup/reset defaults, not locks. A trusted module is
still useful for deployment defaults; ordinary edits no longer require one:

```ts
import { createPodmanPlugin } from "./agentorg-plugin-podman/src/index.ts";
export default createPodmanPlugin({
  defaultImage: "localhost/agentorg-pi:latest",
  podmanExecutable: "podman",
  network: "pasta", // or "slirp4netns" (must be installed), "none"
  containerUid: 1000,
  containerGid: 1000,
  // Optional destination defaults, not required to discover/use host volumes:
  // volumes: { "agentorg-pi-config": { destination: "/home/pi/.pi", readOnly: true } },
});
```

`keep-id:uid=1000,gid=1000` maps the non-root server user's UID/GID to the image's
user, so bind mounts retain that user's host access. Change these numbers for
images with another non-root user. The image's ACP harness uses its own environment
plus explicit `settings.env`; host HOME, provider tokens, and other ambient
variables are not copied. Trusted harness environment contracts default to
`ORG_PI_CONFIG`, `ORG_PI_MCP_SERVERS`, `ORG_PI_EXTENSION` and `AGENTORG_SKILL_FILES`;
custom adapters can configure `harnessEnv`. Plugin-provided launch environment is
also trusted. Optional `mcpExecutable`/`entrypointExecutable` configure image
helper locations. No arbitrary Podman flags are accepted from agent settings.

## Persistent harness volumes

Create volumes as the **same rootless Podman user** that runs the server. Any
existing plain `local` volume without driver options is automatically discoverable,
including volumes created after the server starts. **No per-volume plugin entry,
labels, custom plugin module or server restart is needed.** Host bind devices,
NFS drivers and arbitrary storage plugins remain unsupported.

A volume name alone does not tell the server where to mount it. The trusted client
or TUI chooses its container destination once; that mapping is saved in protected
server state. Agents can delegate grants but cannot discover volumes or choose or
redirect their destinations. Optional `volumes` plugin options provide defaults
and RO-only policies for operators who want them; they are not an allowlist.

```sh
podman volume create agentorg-pi-config
# Explicit, one-time minimal snapshot; use a trusted local image with Node:
sh examples/seed-volume.sh agentorg-pi-config localhost/agentorg-pi:latest
# Optional third argument selects a host directory other than ~/.pi.
# CONTAINER_UID / CONTAINER_GID default to 1000; match the plugin/image user.
```

The helper deliberately copies **only**:

```text
agent/auth.json       # Exact credentials, when present
agent/settings.json   # Filtered portable preferences, when present
```

Portable preferences include provider/model/thinking selection, model patterns,
transport/timeouts, retry/compaction/branch-summary preferences and telemetry
choices. Unknown settings, package/resource declarations, shell commands, proxies,
host paths and trust decisions are omitted. The settings allowlist is explicit in
[`examples/seed-pi-config.mjs`](examples/seed-pi-config.mjs). `models.json`,
`models-store.json`, MCP configuration, instructions, sessions, installed packages,
extensions, skills, caches and todo databases are **not copied**. Supply custom
model configuration separately if your provider needs it. At least one of auth or
settings must exist. Symlinked agent directories/files and malformed JSON are
rejected without printing credential contents.

It runs a temporary network-disabled, no-pull container with read-only source/
helper mounts and the configured UID/GID mapping; credentials never enter an
image/build context or agent settings. Volume/agent directories are mode 0700;
files are mode 0600. An internal `.agentorg-seeded` marker records initialization.
It refuses nonempty uninitialized volumes and does nothing if already initialized,
including older full-directory snapshots: **it never silently prunes or replaces
existing data**. Recreate an old volume explicitly using the operator reset
procedure below to switch to the minimal layout. Partial copies remain
uninitialized and require operator cleanup. Host changes are never synchronized
or overwritten automatically.

`sh examples/pi/build.sh --seed-volume NAME [podman build options...]` builds the
image first, creates the named volume if absent, then runs this same minimal seed
helper. Without `--seed-volume`, image builds never read/copy host credentials.
`PODMAN` selects the engine command; `AGENTORG_PODMAN_IMAGE` selects the image tag.

In the TUI, add the volume to `readOnlyVolumes` or `readWriteVolumes`. For a newly
discovered volume it asks for an absolute **container** destination, e.g.
`/home/pi/.pi`. No host path or JSON entry is needed. Registration persists even
if you discard the agent draft, but grants no agent access by itself.

API clients first call the client-only `podman.volume.configure` endpoint:

```json
{"name": "agentorg-pi-config", "destination": "/home/pi/.pi"}
```

This inspects the existing volume and pins its identity and mapping. Repeating the
same registration is idempotent. Then grant it via `agent.create` or `agent.modify`:

```json
{
  "harness": "pi",
  "cwd": "/tmp/project",
  "extensions": {
    "podman": {
      "readWriteDirs": ["/tmp/project"],
      "readOnlyVolumes": ["agentorg-pi-config"],
      "readWriteVolumes": []
    }
  }
}
```

For Codex/Claude or other harnesses, configure appropriate destinations such as
`/home/pi/.codex` or `/home/pi/.claude`, matching the image user's HOME. A volume
does not authorize cwd. Duplicate names, overlapping granted destinations,
directory/volume overlaps, and protected helper/runtime/session destinations are
rejected. Multiple volumes may be registered at the same destination,
but an agent may select only one. Empty arrays revoke access; supplying the entire
Podman settings namespace replaces all grants as usual.

**These stores are shared, persistent capabilities, not private session storage.**
All agents granted a volume (and their in-container tools) can read its credentials.
Read-only prevents writes, not disclosure. RW grants allow concurrent token refresh,
configuration edits and other writes visible to every consumer; prefer RO whenever
possible. Pi sessions still use AgentOrg's private per-agent session bind, even
when `.pi` is shared. The plugin never deletes volumes on stop/removal or image changes.

The client-only `podman.volumes` endpoint accepts `{}` and returns
`{volumes: [{name, destination?, description?, readOnly}]}` for existing plain local,
unchanged volumes. Unregistered volumes have no destination yet. The catalog
includes volumes from other applications belonging to this Podman user; **select
only stores you intend to share with agents**. It exposes no contents, credentials
or host mountpoints. Capabilities advertise discovery at
`plugins.podman.endpoints.volumes` and registration at
`plugins.podman.endpoints.configureVolume`, and advertise both
volume fields as generic `list` editors (the TUI uses specialized pickers without
duplicating these descriptors).

On client registration (or the first grant using an operator default) the plugin
records creation timestamp, root device/inode and
trusted mapping/access policy in `<data-dir>/podman-volume-pins.json`. Recovery and
every launch re-inspect through the configured Podman executable. The native
startup gate checks volume root identity, exact mount destination and RO/RW mode
before running any harness code. Later plugins cannot add, omit or alter mounts.
**Rebuild images/helpers** to use volumes; old gates reject volume manifests.

For credential rotation, stop all consumers and explicitly update the volume
contents, or create/seed a new volume. To deliberately replace/redirect a pinned
volume: stop the server and consumers, remove only that name's entry from the
protected pin file, update optional operator defaults if needed, restart the server,
register the destination again and re-save affected settings through a trusted
client before launching them. Ordinary volume creation/registration never needs
a restart; this reset is only for deliberately replacing or remapping a pinned
volume. Without it, deletion/replacement/configuration changes fail closed.
Deleting volumes is always a
separate trusted operator action (`podman volume rm`), never an agent operation.

## Isolation and lifecycle

Containers use private PID/IPC/mount namespaces, a non-root mapped user, dropped
capabilities, no-new-privileges, and no privileged mode or Podman socket. Network
is enabled by default for provider APIs. Each agent gets only its
own session directory (an internal writable mount, not a delegable grant), its
private relay socket, and explicitly granted directories and named volumes.
The image's own writable overlay and temporary files are not host workspace grants.

A startup gate verifies the device/inode identity of every mounted directory and
socket **before running the harness**. Host-side directory opens are no-follow and
verified through their pinned file descriptors; post-validation source substitutions
fail the gate instead of granting access to the replacement directory. Untrusted
runtime/loader variables such as `LD_PRELOAD` are applied only to the harness after
verification, never to the gate or host Podman process. Symlinks
inside a mount resolve in the container namespace, not against unmounted host files.

Stopping uses Podman stop and force-removal, not just killing the CLI. Containers
are labeled per organization data directory; startup removes that organization's
orphan containers before core recovery. Session files/workspaces survive stops and
removals. Containers are ephemeral; put durable task output in explicit mounts.

This is an OS filesystem isolation layer, **not a VM or hostile multi-user
platform**. Images/helpers/plugins and clients are trusted; Podman/kernel bugs,
network services, and sensitive sockets/device nodes intentionally placed in a
granted directory remain concerns. Do not grant directories containing other
host service sockets. RW credentials give agents access to those credentials.
The writable session mount is intentionally private to that agent. Other plugins'
host resource paths (e.g. skills) are not implicitly made visible; bake resources
into the image or grant supported external resource directories explicitly.

## Tests

```sh
bun install --frozen-lockfile
bun run check
bun test                    # deterministic ACP + fake Podman, no model calls
bun run test:seed:podman     # real rootless minimal seeding; requires the local example image
bun run test:podman          # real rootless Podman; builds a temporary fixture image
bun run test:tui             # requires adjacent agentorg_tui + its dependencies, script and stty
# After building the example image (startup + native MCP only; no model calls):
ORG_PODMAN_PI_IMAGE=localhost/agentorg-pi:latest bun test tests/pi-image.test.ts
```

Minimal-seeding tests verify the file/settings allowlists, private modes,
credential-safe errors, symlink/malformed-input rejection, idempotence, no-pull/
offline mounts and opt-in build/seed orchestration. `test:seed:podman` repeats the
seed with fake credentials in a disposable **real rootless** volume; it never
reads host credentials. `ORG_PODMAN_IMAGE` selects its trusted local image.

Server-settings tests cover client/agent authorization, schema/policy validation,
no probes on reads, local-image checks before changed catalog saves, named
configuration snapshots/deletion/stale selection, live future-launch changes without agent restarts,
shared revisions/events, persistence/reset, pending server restarts, executable
and helper activation, and fail-closed volume pin behavior. The optional TUI test
runs a real socket server and terminal client against fake rootless Podman,
exercising image/volume/network discovery, destination registration, named
configuration editing/confirmation, new-agent selection/launch, deletion and reset.

The real Podman test verifies RO/RW enforcement for directories and volumes, shared volume
contents and persistence after agent removal, idempotent credential-free image seeding,
unmounted host files and sibling sessions,
native MCP delegation, independent containers, removal, and rejection of a mount
substitution before harness execution. It uses `debian:unstable` by default;
`ORG_PODMAN_BASE_IMAGE` can select another compatible local image.
