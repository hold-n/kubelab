#!/usr/bin/env bash
# Break-fix drills. Each drill deploys something broken into its own namespace.
#   ./drill.sh list           show all drills
#   ./drill.sh start <n>      deploy drill n into namespace drill-<n>
#   ./drill.sh check <n>      verify your fix
#   ./drill.sh reset <n>      delete the namespace and start over
set -euo pipefail
cd "$(dirname "$0")"

declare -A TITLE=(
  [01]="The shop won't start after the nginx upgrade"
  [02]="Pods keep restarting"
  [03]="Pods never start, but there's no crash either"
  [04]="The client pod can't reach the shop Service"
  [05]="Pods are stuck and never land on a node"
  [06]="Pods run fine, but are never ready"
  [07]="Works on my laptop; restarts forever in the cluster"
  [08]="The watcher reports errors from the API server"
  [09]="The app is stuck waiting on its storage"
  [10]="Endpoints exist, but requests from the client fail"
)

pad() { printf "%02d" "$((10#$1))"; }

available() { # deployment name, namespace
  kubectl rollout status "deploy/$1" -n "$2" --timeout=45s >/dev/null 2>&1
}

client_curl() { # namespace
  kubectl wait -n "$1" --for=condition=Ready pod/client --timeout=30s >/dev/null 2>&1 &&
    kubectl exec -n "$1" client -- curl -sf --max-time 3 http://shop/ >/dev/null 2>&1
}

check() {
  local n=$1 ns="drill-$1"
  case $n in
    01|02|03|05|06|07) available app "$ns" ;;
    04|10) available app "$ns" && client_curl "$ns" ;;
    08) [ "$(kubectl auth can-i list pods -n "$ns" --as="system:serviceaccount:$ns:pod-watcher")" = yes ] &&
        available watcher "$ns" ;;
    09) available app "$ns" &&
        [ "$(kubectl get pvc data -n "$ns" -o jsonpath='{.status.phase}')" = Bound ] ;;
  esac
}

usage() { sed -n '2,6p' "$0"; exit 1; }
cmd=${1:-list}
if [ "$cmd" != list ]; then
  [ $# -ge 2 ] && [[ $2 =~ ^[0-9]+$ ]] || usage
  [ -f "drills/$(pad "$2").yaml" ] || { echo "No drill $2. Try: $0 list"; exit 1; }
fi
case $cmd in
  list)
    for k in $(printf '%s\n' "${!TITLE[@]}" | sort); do echo "  $k  ${TITLE[$k]}"; done ;;
  start)
    n=$(pad "$2"); ns="drill-$n"
    kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    kubectl apply -n "$ns" -f "drills/$n.yaml" >/dev/null
    echo "Drill $n: ${TITLE[$n]}"
    echo "Namespace: $ns   (tip: kubectl config set-context --current --namespace=$ns)"
    echo "When you think it's fixed: $0 check $n" ;;
  check)
    n=$(pad "$2")
    if check "$n"; then echo "✅ drill $n fixed!"; else echo "❌ drill $n is not fixed yet"; exit 1; fi ;;
  reset)
    n=$(pad "$2")
    kubectl delete namespace "drill-$n" --ignore-not-found --wait=true >/dev/null
    echo "Deleted namespace drill-$n. Run '$0 start $n' to try again." ;;
  *) usage ;;
esac
