#!/bin/bash
set +x
set -euo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
exec 2>/dev/null

install_dir=/opt/huahuo-agent-build
repository=kyriswu/huahuo-agent
github_api=https://api.github.com/repos/$repository
metadata_api=http://100.100.100.200/latest
work=''
phase=HOST_CONFIG_INVALID

cleanup() {
  local status=$?
  if [[ -n "$work" ]] && ! rm -rf -- "$work"; then
    phase=HOST_CLEANUP_FAILED
    status=1
  fi
  if (( status != 0 )); then
    printf 'AGENT_BUILD_ERROR %s\n' "$phase"
  else
    printf 'AGENT_BUILD_RESULT %s %s %s\n' "$image_repository" "$sha" "$digest"
  fi
  exit "$status"
}

root_owned() {
  local owner mode
  [[ ! -L "$1" ]] && read -r owner mode < <(stat -c '%u %a' -- "$1") &&
    [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 022) == 0 ))
}

github_get() {
  curl --disable --fail --silent --proto '=https' --connect-timeout 10 --max-time 20 \
    --max-filesize 1048576 --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' "$github_api/$1"
}

with_ram_role() {
  ALIBABA_CLOUD_ACCESS_KEY_ID="$access_key_id" ALIBABA_CLOUD_ACCESS_KEY_SECRET="$access_key_secret" \
    ALIBABA_CLOUD_SECURITY_TOKEN="$security_token" ALIBABA_CLOUD_IGNORE_PROFILE=TRUE \
    ALIBABA_CLOUD_CLI_PLUGIN_AUTO_INSTALL=false "$@"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM
[[ $# == 2 && "$1" =~ ^t-[a-zA-Z0-9]{5,80}$ && "$2" =~ ^c-[a-zA-Z0-9]{5,80}$ ]] || exit 1
invoke_id=$1
command_id=$2
if [[ ! -d "$install_dir" ]] || ! root_owned /opt || ! root_owned "$install_dir"; then
  exit 1
fi
for name in config.json acr-auth.sh build-agent-image.sh; do
  if [[ ! -f "$install_dir/$name" ]] || ! root_owned "$install_dir/$name"; then
    exit 1
  fi
done

config="$install_dir/config.json"
region=$(jq -er '.region | strings' "$config")
instance=$(jq -er '.instanceId | strings' "$config")
ecs_instance=$(jq -er '.ecsInstanceId | strings' "$config")
image_repository=$(jq -er '.imageRepository | strings | select(length > 0 and length <= 255)' "$config")
ram_role=$(jq -er '.ramRoleName | strings' "$config")
[[ "$region" =~ ^[a-z]{2}-[a-z0-9]+(-[a-z0-9]+)*$ && "$instance" =~ ^cri-[a-z0-9]+$ &&
  "$ecs_instance" =~ ^i-[a-zA-Z0-9]{5,80}$ &&
  "$image_repository" =~ ^[a-z0-9][a-z0-9._/-]+$ &&
  "$ram_role" =~ ^[a-zA-Z0-9.-]{1,64}$ && "$ram_role" != . && "$ram_role" != .. ]] || exit 1

aliyun_path=$PATH
if [[ -e "$install_dir/bin" || -L "$install_dir/bin" ]]; then
  aliyun_cli="$install_dir/bin/aliyun"
  if [[ ! -d "$install_dir/bin" || ! -f "$aliyun_cli" || ! -x "$aliyun_cli" ]] ||
    ! root_owned "$install_dir/bin" || ! root_owned "$aliyun_cli"; then
    exit 1
  fi
  aliyun_path="$install_dir/bin:$PATH"
else
  aliyun_cli=$(command -v aliyun)
fi

phase=HOST_BUSY
exec 9<"$install_dir"
flock -n 9

phase=SOURCE_NOT_VERIFIED
sha=$(github_get 'branches/test' | jq -er '
  select(.name == "test" and .protected == true) |
  .commit.sha | strings | select(length == 40 and test("^[0-9a-f]{40}$"))
')
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
github_get "actions/workflows/agent-ci.yml/runs?branch=test&event=push&status=success&head_sha=$sha&per_page=10" |
  jq -e --arg sha "$sha" --arg repository "$repository" '
    (.workflow_runs | type == "array") and any(.workflow_runs[];
      .head_sha == $sha and .head_branch == "test" and .event == "push"
      and .status == "completed" and .conclusion == "success"
      and .path == ".github/workflows/agent-ci.yml" and .head_repository.full_name == $repository)
  ' >/dev/null

phase=RAM_AUTH_FAILED
metadata_curl=(curl --disable --fail --silent --noproxy '*' --proto '=http' --connect-timeout 2 --max-time 5 --max-filesize 65536)
metadata_token=$("${metadata_curl[@]}" --request PUT --header 'X-aliyun-ecs-metadata-token-ttl-seconds: 60' "$metadata_api/api/token")
[[ -n "$metadata_token" && ${#metadata_token} -le 4096 && ! "$metadata_token" =~ [[:cntrl:]] ]] || exit 1
ram_credentials=$(printf 'X-aliyun-ecs-metadata-token: %s\n' "$metadata_token" |
  "${metadata_curl[@]}" --header @- "$metadata_api/meta-data/ram/security-credentials/$ram_role")
unset metadata_token
jq -e '
  def credential: type == "string" and length > 0 and (test("[\r\n\u0000]") | not);
  .Code == "Success" and (.Expiration | fromdateiso8601 > now)
  and (.AccessKeyId | credential) and (.AccessKeySecret | credential) and (.SecurityToken | credential)
' <<< "$ram_credentials" >/dev/null
access_key_id=$(jq -r '.AccessKeyId' <<< "$ram_credentials")
access_key_secret=$(jq -r '.AccessKeySecret' <<< "$ram_credentials")
security_token=$(jq -r '.SecurityToken' <<< "$ram_credentials")
unset ram_credentials

phase=INVOCATION_NOT_VERIFIED
invocation_sha=$(with_ram_role timeout --kill-after=5s 15s "$aliyun_cli" ecs DescribeInvocations \
  --region "$region" --RegionId "$region" --InvokeId "$invoke_id" --CommandId "$command_id" \
  --InstanceId "$ecs_instance" --RepeatMode Once --IncludeOutput false --MaxResults 2 --retry-count 0 --yes |
  jq -er --arg invoke "$invoke_id" --arg command "$command_id" --arg instance "$ecs_instance" '
    select((.NextToken // "") == "") |
    .Invocations.Invocation | arrays | select(length == 1) | first |
    select(.InvokeId == $invoke and .CommandId == $command and .RepeatMode == "Once") |
    select((.InvokeInstances.InvokeInstance | arrays | length) == 1
      and .InvokeInstances.InvokeInstance[0].InstanceId == $instance) |
    .Tags.Tag | arrays | select(length == 1) | first |
    select(.TagKey == "source-sha") | .TagValue | strings | select(length == 40 and test("^[0-9a-f]{40}$"))
  ')
[[ "$invocation_sha" == "$sha" ]] || exit 1

phase=SOURCE_ARCHIVE_FAILED
work=$(mktemp -d /tmp/huahuo-agent-build.XXXXXX)
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_CONFIG_PARAMETERS
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0 GIT_TERMINAL_PROMPT=0
git init --quiet --template= "$work/git"
timeout --kill-after=5s 120s git -C "$work/git" fetch --quiet --depth=1 --no-tags \
  "https://github.com/$repository.git" refs/heads/test
[[ "$(git -C "$work/git" rev-parse FETCH_HEAD)" == "$sha" ]] || exit 1
git -C "$work/git" archive --format=tar.gz --output="$work/source.tar.gz" "$sha"
rm -rf -- "$work/git"
printf '%s\n' "$sha" > "$work/source-sha"
printf '%s\n' "$image_repository" > "$work/image-repository"

phase=ACR_AUTH_FAILED
PATH="$aliyun_path" with_ram_role \
  timeout --kill-after=5s 45s /bin/bash "$install_dir/acr-auth.sh" "$region" "$instance" "$image_repository" "$work" >/dev/null || exit 1
unset access_key_id access_key_secret security_token

phase=IMAGE_BUILD_FAILED
digest=$(/bin/bash "$install_dir/build-agent-image.sh" "$work")
phase=IMAGE_DIGEST_INVALID
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
