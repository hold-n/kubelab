#!/usr/bin/env bash
# Install the CLI tools the lab needs (skips anything already installed).
# Used by .agents/setup (fresh orbs) and cluster/up.sh.
set -euo pipefail

KIND_VERSION=v0.33.0
TTYD_VERSION=1.7.7

install_bin() { # name url
  echo "installing $1"
  curl -fsSLo "/tmp/$1" "$2"
  sudo install -m755 "/tmp/$1" "/usr/local/bin/$1"
  rm -f "/tmp/$1"
}

command -v kubectl >/dev/null || install_bin kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
command -v kind >/dev/null || install_bin kind "https://kind.sigs.k8s.io/dl/$KIND_VERSION/kind-linux-amd64"
command -v ttyd >/dev/null || install_bin ttyd "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.x86_64"
if ! command -v helm >/dev/null; then
  echo "installing helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash >/dev/null
fi
command -v tmux >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq tmux; }

# Let the default user talk to Docker without sudo (cluster/up.sh starts the daemon).
id -nG | grep -qw docker || sudo usermod -aG docker "$(id -un)"
