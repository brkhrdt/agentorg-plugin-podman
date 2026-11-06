#!/bin/sh
set -eu
# Credentials stay out of the image/build context. Seeding is a separate opt-in.
volume=
if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
  echo 'Usage: sh examples/pi/build.sh [--seed-volume NAME] [podman build options...]'
  echo 'Optional seeding copies only ~/.pi/agent/auth.json and portable settings.'
  exit 0
fi
if [ "${1:-}" = --seed-volume ]; then
  [ "$#" -ge 2 ] || { echo '--seed-volume requires a name' >&2; exit 2; }
  volume=$2; shift 2
  case "$volume" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) echo 'Invalid volume name' >&2; exit 2;; esac
  [ "${#volume}" -le 128 ] || { echo 'Invalid volume name' >&2; exit 2; }
fi
podman=${PODMAN:-podman}
image=${AGENTORG_PODMAN_IMAGE:-localhost/agentorg-pi:latest}
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
(cd "$root" && npm ci && npm run build)
(cd "$root/../agentorg-plugin-pi-agent" && npm ci && npm run build)
cp "$root/dist/agentorg-podman-mcp" "$root/examples/pi/agentorg-podman-mcp"
cp "$root/dist/agentorg-podman-exec" "$root/examples/pi/agentorg-podman-exec"
cp "$root/../agentorg-plugin-pi-agent/dist/pi-acp" "$root/examples/pi/agentorg-pi-acp"
"$podman" build --tag "$image" "$@" "$root/examples/pi"
if [ -n "$volume" ]; then
  if ! "$podman" volume exists "$volume"; then "$podman" volume create "$volume"; fi
  sh "$root/examples/seed-volume.sh" "$volume" "$image"
fi
