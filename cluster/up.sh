#!/usr/bin/env bash
# Create the "lab" cluster, the fake cloud load balancer, and load the tutorial app image.
# Idempotent: safe to re-run at any time (e.g. after the orb restarts).
set -euo pipefail
cd "$(dirname "$0")/.."

KIND_VERSION=v0.33.0
CPK_IMAGE=registry.k8s.io/cloud-provider-kind/cloud-controller-manager:v0.11.1

# --- tools -------------------------------------------------------------------
if ! command -v kubectl >/dev/null; then
  v=$(curl -fsSL https://dl.k8s.io/release/stable.txt)
  curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/$v/bin/linux/amd64/kubectl"
  sudo install -m755 /tmp/kubectl /usr/local/bin/kubectl
fi
if ! command -v kind >/dev/null; then
  curl -fsSLo /tmp/kind "https://kind.sigs.k8s.io/dl/$KIND_VERSION/kind-linux-amd64"
  sudo install -m755 /tmp/kind /usr/local/bin/kind
fi
if ! command -v helm >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi

# --- docker ------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  sudo systemctl start docker
  sudo chmod 666 /var/run/docker.sock
fi

# --- cluster -----------------------------------------------------------------
if kind get clusters 2>/dev/null | grep -qx lab; then
  echo "Cluster 'lab' already exists."
  docker start lab-control-plane lab-worker lab-worker2 >/dev/null
else
  kind create cluster --config cluster/kind-config.yaml
fi
kubectl config use-context kind-lab >/dev/null

# cloud-provider-kind plays the role of the AWS cloud controller: it watches for
# Services of type LoadBalancer and provisions a "load balancer" (a container)
# with a reachable IP. Its built-in Gateway/Ingress controllers are disabled
# because you install a real one (Envoy Gateway) yourself in lesson 09.
if ! docker ps -a --format '{{.Names}}' | grep -qx cloud-provider-kind; then
  docker run -d --name cloud-provider-kind --restart unless-stopped --network kind \
    -v /var/run/docker.sock:/var/run/docker.sock "$CPK_IMAGE" \
    --gateway-channel disabled --enable-default-ingress=false >/dev/null
fi
docker start cloud-provider-kind >/dev/null

# --- tutorial app image ------------------------------------------------------
# Build locally and side-load into every node (no registry needed).
for v in v1 v2; do
  docker build -q -t "kubelab/app:$v" --build-arg "VERSION=$v" app >/dev/null 2>&1
  kind load docker-image "kubelab/app:$v" --name lab >/dev/null 2>&1
done
echo "Loaded images kubelab/app:v1 and kubelab/app:v2 into the cluster."

kubectl wait --for=condition=Ready nodes --all --timeout=120s >/dev/null
kubectl get nodes
