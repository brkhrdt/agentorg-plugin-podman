#!/bin/sh
# Trusted operator action. No credential contents are printed or baked into images.
set -eu
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo 'Usage: sh examples/seed-volume.sh VOLUME TRUSTED_LOCAL_IMAGE [HOST_DIRECTORY]' >&2
  exit 2
fi
podman=${PODMAN:-podman}
volume=$1
image=$2
source=$(realpath "${3:-$HOME/.pi}")
uid=${CONTAINER_UID:-1000}
gid=${CONTAINER_GID:-1000}
case "$volume" in ''|[!a-zA-Z0-9]*|*[!a-zA-Z0-9_.-]*) echo 'Invalid volume name' >&2; exit 2;; esac
case "$image" in ''|-*) echo 'Invalid image' >&2; exit 2;; esac
case "$source" in *','*|*':'*) echo 'Unsupported source path characters' >&2; exit 2;; esac
[ -d "$source" ] || { echo 'Source must be an existing directory' >&2; exit 2; }
[ "$("$podman" info --format '{{.Host.Security.Rootless}}')" = true ] || { echo 'Rootless Podman is required' >&2; exit 2; }
"$podman" volume exists "$volume" || { echo 'Create the named volume first' >&2; exit 2; }
[ "$("$podman" volume inspect --format '{{.Driver}}|{{len .Options}}' "$volume")" = 'local|0' ] || { echo 'Only plain local volumes are supported' >&2; exit 2; }
"$podman" run --rm --pull=never --network=none \
  "--userns=keep-id:uid=$uid,gid=$gid" --user "$uid:$gid" \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,src=$source,dst=/seed,ro=true,bind-propagation=rprivate,bind-nonrecursive=true" \
  --volume "$volume:/volume:rw,nocopy" --entrypoint /bin/sh "$image" -eu -c '
    if [ -f /volume/.agentorg-seeded ]; then
      echo "Volume already initialized; nothing copied."
      exit 0
    fi
    # Includes dotfiles. Never overwrite preexisting or partially seeded contents.
    [ -z "$(find /volume -mindepth 1 -maxdepth 1 -print -quit)" ] || {
      echo "Volume is not empty; refusing to overwrite it." >&2; exit 1;
    }
    mkdir /volume/.agentorg-seeding
    cp -a /seed/. /volume/
    chmod 700 /volume
    touch /volume/.agentorg-seeded
    rmdir /volume/.agentorg-seeding
    echo "Volume initialized from snapshot."
  '
