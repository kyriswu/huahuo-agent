#!/usr/bin/env bash
set -euo pipefail
umask 077

region=$1
instance=$2
repository=$3
work=$4

if [[ ! "$region" =~ ^[a-z]{2}-[a-z0-9]+(-[a-z0-9]+)*$ || ! "$instance" =~ ^cri-[a-z0-9]+$ ||
  ! "$repository" =~ ^[a-z0-9-]+-registry-vpc\.$region\.cr\.aliyuncs\.com/[a-z0-9][a-z0-9_-]*/[a-z0-9][a-z0-9._-]*$ ]]; then
  printf '%s\n' AGENT_ACR_CONFIGURATION_INVALID >&2
  exit 1
fi

namespace_and_repo=${repository#*/}
scope=(--endpoint "cr.$region.aliyuncs.com" --RegionId "$region" --InstanceId "$instance")
if ! repository_info=$(aliyun cr GetRepository "${scope[@]}" \
  --RepoNamespaceName "${namespace_and_repo%/*}" --RepoName "${namespace_and_repo#*/}" 2>/dev/null) ||
  ! jq -e '.IsSuccess == true and .RepoStatus == "NORMAL" and .RepoType == "PRIVATE"' \
    <<< "$repository_info" >/dev/null; then
  printf '%s\n' AGENT_ACR_PRIVATE_REPOSITORY_REQUIRED >&2
  exit 1
fi

if ! token=$(aliyun cr GetAuthorizationToken "${scope[@]}" --ExpiresInHours 1 2>/dev/null) ||
  ! jq -e '
    def credential: type == "string" and length > 0 and (test("[\r\n\u0000]") | not);
    .IsSuccess == true and (.ExpireTime | type == "number") and .ExpireTime > (now * 1000)
    and (.TempUsername | credential) and (.AuthorizationToken | credential)
  ' <<< "$token" >/dev/null; then
  printf '%s\n' AGENT_ACR_TEMPORARY_AUTH_FAILED >&2
  exit 1
fi

jq -j '.TempUsername' <<< "$token" > "$work/registry-username"
jq -j '.AuthorizationToken' <<< "$token" > "$work/registry-password"
