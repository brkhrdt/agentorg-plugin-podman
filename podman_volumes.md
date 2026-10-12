# Named Podman volumes: implementation plan

This document describes adding persistent Podman named-volume grants alongside the existing host-directory grants. A Containerfile `VOLUME` declaration is not enough: it creates an anonymous volume per container, does not share one volume among agents, and the plugin launches containers with `--rm`. The plugin must explicitly attach persistent named volumes at runtime.

## Goals and terminology

- A **named volume** is a rootless Podman volume managed by the same Podman user as the AgentOrg server. It is not a host-directory grant and agents never receive a Podman socket or control API.
- Agent settings expose two arrays in `settings.extensions.podman`:
  - `readOnlyVolumes: string[]`
  - `readWriteVolumes: string[]`
- Entries are stable volume names, not filesystem paths or arbitrary `source:target` strings. Empty arrays mean no access. Supplying either array replaces the volume grants just as directory grant updates do.
- Directory and volume grants remain separate capabilities. Volume access does not cover `cwd`, and directory access does not imply volume access.
- Named volumes survive container stop/removal. Pi session history continues to use AgentOrg's existing per-agent session mount; it should not be moved into a shared volume by default.

## Volume names, targets, and trusted configuration

A Podman volume name alone does not specify where it appears in a container. The implementation must provide a trusted mapping from each selectable volume to a container destination. Do not accept arbitrary mount destinations, mount options, or Podman flags from agent settings.

Implemented contract (revised to avoid a per-volume server/plugin allowlist):

1. The operator creates/initializes volumes with Podman outside agent settings, using the same rootless Podman user as the server.
2. `podman.volumes` discovers all existing plain local volumes without driver options. No labels, custom plugin modules, per-volume plugin entries or server restarts are required. The client-only catalog includes other applications' volumes; discovery never grants access.
3. A trusted client selects a container destination through `podman.volume.configure({name, destination})`; the TUI prompts for it on first selection. The mapping and inspected identity persist in protected server state. Destination registration is not an agent grant. Agents cannot call this endpoint, choose destinations or redirect existing mappings.
4. Each granted volume is mounted at its registered destination with `ro` or `rw` access. Reject duplicate names, overlapping granted destinations, conflicting directory/volume destinations, invalid names, and protected/runtime destinations.

Optional operator plugin configuration supplies destination defaults and read-only policies, but is not an eligibility allowlist. Do not infer destinations from volume names. Registration is idempotent for the same destination; deliberate replacement or remapping requires an explicit operator reset of the identity pin.

## Authorization and delegation

Use the same grant rules as directory delegation, independently for volumes:

- A child receives no volume grants implicitly; volume arrays are not copied from its parent.
- Adding or escalating a volume grant requires both the calling agent and the target's direct parent to hold sufficient access to that same volume.
- Read/write may delegate read/write or read-only. Read-only may delegate only read-only. Neither grant permits access to an ungranted volume.
- Agents cannot change the image or the trusted volume-to-destination mapping.
- Grant replacement/revocation must use the same checks that prevent leaving existing descendants with more volume access than their ancestor chain permits.
- Client-side create/modify remains trusted to select any eligible volume; agent-initiated child creation/modification is subject to the delegation checks.

Authorization should compare canonical volume identities, not path prefixes or substring matches. Revalidate grants at launch/recovery, including that the volume still exists, is still eligible, and still maps to the same destination and access policy.

## Runtime and lifecycle

- Attach each configured named volume with an explicit `ro` or `rw` mode in the final `podman run` command. Keep the existing private namespaces, UID mapping, dropped capabilities, and no-new-privileges behavior.
- Resolve and inspect volumes through the configured Podman executable. Never mount the Podman graph root directly as a directory grant. Capture enough trusted identity/configuration to detect deletion, replacement, or destination changes before launch.
- Extend the launch validator so later plugins cannot alter, omit, or add volume mounts. Keep volume mount arguments host-owned, like the existing directory bind arguments.
- The startup entrypoint gate currently verifies directory/socket bind identities. Define how configured named-volume mounts are verified before starting the harness; do not weaken the existing gate. The plugin can validate Podman's named-volume identity before launch and pass an expected volume/destination/mode manifest to a gate extension, or use another explicit trusted mechanism.
- `--rm` removes the container, not a named volume. Stopping an agent must not delete a volume. Volume deletion should be a separate trusted operator action and must not happen as part of agent stop/removal or image propagation.
- Multiple agents using the same read/write volume see and can modify the same files concurrently. Document this prominently; use read-only access when agents only need shared configuration. Pi token refresh/config writes may require read/write access.

## Seeding a volume from host `~/.pi`

For Pi configuration, an operator can create an eligible volume mapped to `/home/pi/.pi`, then perform an explicit one-time copy of the host `~/.pi` contents into it using a temporary trusted helper container. Set ownership/permissions for the image's configured UID/GID (default 1000). The seed step must:

- copy directory contents, including dotfiles, without printing credential contents;
- be explicit and idempotent (never overwrite an already initialized volume without confirmation or a deliberate reset option);
- avoid storing the host path or credential contents in the image, build context, logs, or agent settings;
- document that this is a snapshot, not ongoing synchronization with host `~/.pi`;
- document that all containers granted this volume can read its credentials, including their in-container tools; read-only controls writes, not reads.

Image builds should remain credential-free. Rotating host credentials requires reseeding the volume or otherwise updating its contents. If the volume is shared read/write, one agent's changes are visible to all other agents using it.

## API, capabilities, and validation

- Extend the strict Podman settings schema and normalization/launch code with the two volume arrays. Validate names against Podman output and inspected plain-local identities; require a client-registered destination or optional operator default before granting access; never pass unchecked strings to a shell (use argv arrays).
- Advertise volume grant support, volume-list and client-only destination-registration endpoints through Podman's capability descriptor. The endpoint is client-only and returns selectable names plus safe display metadata/destination/access hints, never volume contents, mountpoint host paths, or credentials.
- Add tests for eligible/ineligible volumes, missing/replaced volumes, duplicate/conflicting targets, read-only/read-write mount arguments, persistence after container removal, image inheritance, and RO/RW delegation (including ancestor revocation rules).
- Update API examples and docs to make clear that these are shared persistent stores, not per-agent session storage.

## TUI behavior

Add `readOnlyVolumes` and `readWriteVolumes` fields next to the directory grant fields. Keep their values as string arrays in the API; do not ask users to edit JSON.

Use a reusable volume-list editor similar to the directory list editor:

- Show current grants with add, edit, and remove actions.
- On add/edit, request eligible volume choices from the server-side Podman endpoint, then fuzzy-filter the names as the user types.
- Arrow keys move the highlighted choice; Enter stages it; Escape cancels. Tab may stage/complete the highlighted volume, matching the directory completion interaction.
- Filter and selection operate on server-reported volume names, not the TUI machine's local Podman installation.
- Display registered destination and trusted description where useful without exposing host mountpoint paths. If an existing volume has no destination, prompt the trusted user for an absolute container path and register it through the client-only endpoint before staging the grant.
- Preserve draft values on discovery errors and allow no arbitrary volume names or destinations to bypass server validation.

The TUI must not duplicate plugin-advertised fields: either use specialized Podman fields (as it currently does for directory grants) or fully reusable plugin field descriptors, but not both.

## Acceptance criteria

1. A trusted client can grant an existing eligible named volume read-only or read/write to an agent.
2. The volume is mounted at its trusted destination with the requested mode and survives container restart/removal.
3. An agent can delegate only the same volume permissions it holds and its direct parent permits; RW can be reduced to RO, never the reverse.
4. TUI users can discover, fuzzy-filter, arrow-select, stage, and remove volume grants without entering JSON or arbitrary host paths.
5. Unsupported volume drivers/options, changed volume identities/configuration, invalid destinations, and unauthorized delegation fail closed. Ordinary host-created volumes require neither labels nor plugin configuration.
6. Pi `~/.pi` can be seeded from the host into a named volume without adding credentials to the image or build context, with explicit documentation of shared access and snapshot/rotation behavior.
