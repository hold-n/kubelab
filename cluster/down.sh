#!/usr/bin/env bash
# Delete the cluster entirely. Run cluster/up.sh to get a fresh one.
set -euo pipefail
kind delete cluster --name lab
docker rm -f cloud-provider-kind >/dev/null 2>&1 || true
# Remove any load balancer containers cloud-provider-kind created.
docker ps -aq --filter "label=io.x-k8s.cloud-provider-kind.cluster=lab" | xargs -r docker rm -f >/dev/null
