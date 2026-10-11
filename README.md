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

`child_create` and `descendant_modify` gain top-level arrays `readOnlyDirs` and
`readWriteDirs`. The two arrays replace the target's grants; an omitted array is
empty when either array is supplied. No mounts are inferred from `cwd`.

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
`readOnlyDirs` and `readWriteDirs` editor fields. Directory fields are JSON arrays;
a blank image means inherit. Provider/model entry is manual in container mode:
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

## Operator configuration

Create a trusted plugin module:

```ts
import { createPodmanPlugin } from "./agentorg-plugin-podman/src/index.ts";
export default createPodmanPlugin({
  defaultImage: "localhost/agentorg-pi:latest",
  podmanExecutable: "podman",
  network: "pasta", // or "slirp4netns" (must be installed), "none"
  containerUid: 1000,
  containerGid: 1000,
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

## Isolation and lifecycle

Containers use private PID/IPC/mount namespaces, a non-root mapped user, dropped
capabilities, no-new-privileges, and no privileged mode or Podman socket. Network
is enabled by default for provider APIs. Each agent gets only its
own session directory (an internal writable mount, not a delegable grant), its
private relay socket, and explicitly granted workspace/configuration directories.
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
bun run test:podman          # real rootless Podman; builds a temporary fixture image
# After building the example image (startup + native MCP only; no model calls):
ORG_PODMAN_PI_IMAGE=localhost/agentorg-pi:latest bun test tests/pi-image.test.ts
```

The real test verifies RO/RW enforcement, unmounted host files and sibling sessions,
native MCP delegation, independent containers, removal, and rejection of a mount
substitution before harness execution. It uses `debian:unstable` by default;
`ORG_PODMAN_BASE_IMAGE` can select another compatible local image.
