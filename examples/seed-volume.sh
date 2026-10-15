#!/bin/sh
# Trusted operator action: minimal Pi auth/preferences, never a whole ~/.pi copy.
# No credential contents are printed or baked into images. The image needs Node.
set -eu
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo 'Usage: sh examples/seed-volume.sh VOLUME TRUSTED_LOCAL_IMAGE [HOST_DIRECTORY]' >&2
  exit 2
fi
podman=${PODMAN:-podman}
volume=$1
image=$2
source=$(realpath "${3:-$HOME/.pi}")
helper=$(realpath "$(dirname -- "$0")/seed-pi-config.mjs")
uid=${CONTAINER_UID:-1000}
gid=${CONTAINER_GID:-1000}
case "$volume" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) echo 'Invalid volume name' >&2; exit 2;; esac
case "$image" in ''|-*) echo 'Invalid image' >&2; exit 2;; esac
[ "${#volume}" -le 128 ] || { echo 'Invalid volume name' >&2; exit 2; }
case "$uid:$gid" in *[!0-9:]*|:*|*:) echo 'UID/GID must be numeric' >&2; exit 2;; esac
case "$source:$helper" in *','*) echo 'Unsupported source path characters' >&2; exit 2;; esac
case "$source" in *':'*) echo 'Unsupported source path characters' >&2; exit 2;; esac
[ -d "$source" ] || { echo 'Source must be an existing directory' >&2; exit 2; }
[ "$("$podman" info --format '{{.Host.Security.Rootless}}')" = true ] || { echo 'Rootless Podman is required' >&2; exit 2; }
"$podman" volume exists "$volume" || { echo 'Create the named volume first' >&2; exit 2; }
[ "$("$podman" volume inspect --format '{{.Driver}}|{{len .Options}}' "$volume")" = 'local|0' ] || { echo 'Only plain local volumes are supported' >&2; exit 2; }
"$podman" run --rm --pull=never --network=none \
  "--userns=keep-id:uid=$uid,gid=$gid" --user "$uid:$gid" \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,src=$source,dst=/seed,ro=true,bind-propagation=rprivate,bind-nonrecursive=true" \
  --mount "type=bind,src=$helper,dst=/run/seed-pi-config.mjs,ro=true,bind-propagation=rprivate,bind-nonrecursive=true" \
  --volume "$volume:/volume:rw,nocopy" --entrypoint node "$image" /run/seed-pi-config.mjs /seed /volume
