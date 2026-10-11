#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
(cd "$root" && bun install --frozen-lockfile && bun run build)
(cd "$root/../agentorg-plugin-pi-agent" && bun install --frozen-lockfile && bun run build)
cp "$root/dist/agentorg-podman-mcp" "$root/examples/pi/agentorg-podman-mcp"
cp "$root/dist/agentorg-podman-exec" "$root/examples/pi/agentorg-podman-exec"
cp "$root/../agentorg-plugin-pi-agent/dist/pi-acp" "$root/examples/pi/agentorg-pi-acp"
podman build --tag "${AGENTORG_PODMAN_IMAGE:-localhost/agentorg-pi:latest}" "$@" "$root/examples/pi"
