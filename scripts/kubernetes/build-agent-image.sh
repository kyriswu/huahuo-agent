#!/usr/bin/env bash
set -euo pipefail

work=$1
source_sha=$(cat "$work/source-sha")
repository=$(cat "$work/image-repository")
registry=${repository%%/*}
builder=huahuo-agent-${work##*/}

case "$(uname -s)/$(uname -m)" in
  Linux/aarch64 | Linux/arm64) ;;
  *) printf '%s\n' AGENT_BUILD_HOST_PLATFORM_MISMATCH >&2; exit 1 ;;
esac

export DOCKER_CONFIG="$work/docker"
export DOCKER_HOST=${DOCKER_HOST:-unix:///var/run/docker.sock}
unset DOCKER_CONTEXT
case "$DOCKER_HOST" in
  unix:///*) ;;
  *) printf '%s\n' AGENT_BUILD_DOCKER_SOCKET_REQUIRED >&2; exit 1 ;;
esac
install -d -m 0700 "$DOCKER_CONFIG" "$work/source"
case "$(docker info --format '{{.OSType}}/{{.Architecture}}')" in
  linux/aarch64 | linux/arm64) ;;
  *) printf '%s\n' AGENT_BUILD_DOCKER_PLATFORM_MISMATCH >&2; exit 1 ;;
esac
tar -xzf "$work/source.tar.gz" -C "$work/source"

jq -n --arg registry "$registry" \
  --rawfile username "$work/registry-username" --rawfile password "$work/registry-password" \
  '{auths: {($registry): {auth: ("\($username):\($password)" | @base64)}}}' > "$DOCKER_CONFIG/config.json"
rm -f -- "$work/registry-username" "$work/registry-password"
trap 'docker buildx rm "$builder" >/dev/null 2>&1 || true' EXIT
docker buildx create --name "$builder" --driver docker-container >&2
docker buildx build --builder "$builder" --platform linux/arm64 \
  --build-arg MASTRA_BUILD_STUDIO=true \
  --tag "$repository:$source_sha" \
  --label org.opencontainers.image.source=https://github.com/kyriswu/huahuo-agent \
  --label "org.opencontainers.image.revision=$source_sha" \
  --annotation "manifest:org.opencontainers.image.revision=$source_sha" \
  --metadata-file "$work/metadata.json" --push "$work/source" >&2
jq -er '."containerimage.digest" | select(type == "string" and test("^sha256:[0-9a-f]{64}$"))' "$work/metadata.json"
