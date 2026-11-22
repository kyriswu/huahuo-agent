#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

if [[ $# != 2 ]]; then
  printf '%s\n' 'Usage: deploy.sh <test|production> <sha256:digest>' \
    'Set KUBECONFIG, AGENT_K8S_CONTEXT, AGENT_K8S_NAMESPACE and AGENT_IMAGE_REPOSITORY.' >&2
  exit 2
fi

target=$1
digest=$2
namespace=${AGENT_K8S_NAMESPACE:-}
context=${AGENT_K8S_CONTEXT:-}
repository=${AGENT_IMAGE_REPOSITORY:-}
kubeconfig=${KUBECONFIG:-}
registry_part='[a-z0-9]+([.-][a-z0-9]+)*'
path_part='[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*'

[[ $target == test || $target == production ]] || fail AGENT_K8S_TARGET_INVALID
[[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || fail AGENT_K8S_DIGEST_INVALID
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || fail AGENT_K8S_NAMESPACE_INVALID
[[ $context =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$ ]] || fail AGENT_K8S_CONTEXT_INVALID
[[ ${#repository} -le 255 && $repository =~ ^${registry_part}(:[0-9]{1,5})?/${path_part}(/${path_part})*$ ]] || fail AGENT_K8S_REPOSITORY_INVALID
registry=${repository%%/*}
[[ $registry == localhost || $registry == *.* || $registry == *:* ]] || fail AGENT_K8S_REPOSITORY_INVALID
[[ -n $kubeconfig && -f $kubeconfig && -r $kubeconfig && -s $kubeconfig ]] || fail AGENT_K8S_KUBECONFIG_REQUIRED
command -v kubectl >/dev/null 2>&1 || fail AGENT_K8S_KUBECTL_REQUIRED

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
umask 077
stage=$(mktemp -d "${TMPDIR:-/tmp}/huahuo-agent-deploy.XXXXXX") || fail AGENT_K8S_TEMP_FAILED
trap 'rm -rf -- "$stage"' EXIT

kube() {
  KUBECTL_KUBERC=false kubectl --kubeconfig="$kubeconfig" --context="$context" \
    --namespace="$namespace" --cache-dir="$stage/cache" "$@"
}

found_context=$(kube config get-contexts -o name -- "$context" 2>/dev/null) || fail AGENT_K8S_CONTEXT_UNKNOWN
[[ $found_context == "$context" ]] || fail AGENT_K8S_CONTEXT_UNKNOWN

cp -R "$repo_root/k8s" "$stage/k8s" || fail AGENT_K8S_RENDER_FAILED
overlay="$stage/k8s/overlays/$target"
kustomization="$overlay/kustomization.yaml"
[[ -f $kustomization ]] || fail AGENT_K8S_OVERLAY_MISSING
if grep -Eq '^(images|namespace):' "$kustomization"; then
  fail AGENT_K8S_OVERLAY_ALREADY_BOUND
fi
printf '\nnamespace: %s\nimages:\n  - name: example.invalid/huahuo-agent\n    newName: %s\n    digest: %s\n' \
  "$namespace" "$repository" "$digest" >> "$kustomization"
image="$repository@$digest"
kube kustomize "$overlay" > "$stage/rendered.yaml" 2>/dev/null || fail AGENT_K8S_RENDER_FAILED

# Kustomize writes one resource per YAML document. Separate the policy so it
# reaches the API server before the Service and Deployment are created.
awk -v policy="$stage/policy.yaml" -v workload="$stage/workload.yaml" \
    -v image="$image" -v namespace="$namespace" '
  function emit() {
    if (resource !~ /[^[:space:]]/) return
    expected_name = kind == "NetworkPolicy" ? "huahuo-agent-ingress" : "huahuo-agent"
    if (name != expected_name || declared_namespace != namespace) invalid = 1
    if (kind == "NetworkPolicy") print "---\n" resource > policy
    else if (kind == "Deployment" || kind == "Service" || kind == "ServiceAccount")
      print "---\n" resource > workload
    else invalid = 1
    count[kind]++
    kind = resource = name = declared_namespace = ""
    metadata = 0
  }
  /^---[[:space:]]*$/ { emit(); next }
  /^kind: / { kind = $2 }
  /^[^[:space:]]/ { metadata = ($0 == "metadata:") }
  metadata && /^  name: / { name = $2 }
  metadata && /^  namespace: / { declared_namespace = $2 }
  $1 == "image:" {
    if ($2 == image) images++
    else invalid = 1
  }
  { resource = resource $0 "\n" }
  END {
    emit()
    if (invalid || count["NetworkPolicy"] != 1 || count["Deployment"] != 1 ||
        count["Service"] != 1 || count["ServiceAccount"] != 1 || images != 2) exit 1
  }
' "$stage/rendered.yaml" || fail AGENT_K8S_RENDER_UNEXPECTED

apply=(apply --server-side --field-manager=huahuo-agent-release --request-timeout=30s)
kube "${apply[@]}" --dry-run=server -f "$stage/policy.yaml" >/dev/null 2>&1 || fail AGENT_K8S_POLICY_INVALID
kube "${apply[@]}" --dry-run=server -f "$stage/workload.yaml" >/dev/null 2>&1 || fail AGENT_K8S_WORKLOAD_INVALID
printf '%s\n' 'Kubernetes server validation passed.'
kube "${apply[@]}" -f "$stage/policy.yaml" >/dev/null 2>&1 || fail AGENT_K8S_POLICY_APPLY_FAILED
kube "${apply[@]}" -f "$stage/workload.yaml" >/dev/null 2>&1 || fail AGENT_K8S_WORKLOAD_APPLY_FAILED

verify_images() {
  local applied_images
  local image_paths='{.spec.template.spec.initContainers[?(@.name=="preflight")].image}{"\n"}{.spec.template.spec.containers[?(@.name=="agent")].image}'
  applied_images=$(kube get deployment/huahuo-agent --request-timeout=15s -o "jsonpath=$image_paths" 2>/dev/null) || fail AGENT_K8S_DEPLOYMENT_READ_FAILED
  [[ $applied_images == "$image"$'\n'"$image" ]] || fail AGENT_K8S_DEPLOYED_IMAGES_MISMATCH
}

verify_images
kube rollout status deployment/huahuo-agent --timeout=360s --request-timeout=370s >/dev/null 2>&1 || fail AGENT_K8S_ROLLOUT_FAILED
verify_images
kube exec deployment/huahuo-agent --container=agent --pod-running-timeout=20s --request-timeout=30s \
  -- node /app/release/runtime-check.mjs >/dev/null 2>&1 || fail AGENT_K8S_RUNTIME_SMOKE_FAILED
verify_images
printf 'Agent rollout and runtime smoke passed for %s in namespace %s using %s\n' "$target" "$namespace" "$image"
