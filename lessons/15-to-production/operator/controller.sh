#!/usr/bin/env bash
# A (deliberately naive) operator for Greeter resources, in bash.
# Real operators are written in Go (controller-runtime / Kubebuilder) and use watches,
# work queues and status updates - but the core idea is exactly this loop:
#   observe desired state → compare with actual → act → repeat.
set -euo pipefail
NS=${NS:-default}
echo "greeter-controller watching namespace $NS (Ctrl-C to stop)"
while true; do
  for name in $(kubectl get greeters -n "$NS" -o jsonpath='{.items[*].metadata.name}'); do
    gr=$(kubectl get greeter "$name" -n "$NS" -o json 2>/dev/null) || continue # deleted meanwhile
    uid=$(jq -r .metadata.uid <<<"$gr")
    msg=$(jq -r .spec.message <<<"$gr")
    replicas=$(jq -r '.spec.replicas // 1' <<<"$gr")
    # Desired state for this Greeter: a Deployment, owned by the Greeter.
    # The ownerReference means deleting the Greeter garbage-collects the Deployment.
    cat <<YAML | kubectl apply -n "$NS" -f - | grep -v unchanged || true
apiVersion: apps/v1
kind: Deployment
metadata:
  name: greeter-$name
  ownerReferences:
    - apiVersion: kubelab.dev/v1
      kind: Greeter
      name: $name
      uid: $uid
      controller: true
spec:
  replicas: $replicas
  selector:
    matchLabels: { greeter: $name }
  template:
    metadata:
      labels: { greeter: $name }
    spec:
      containers:
        - name: app
          image: kubelab/app:v1
          imagePullPolicy: Never
          env:
            - name: GREETING
              value: "$msg"
YAML
  done
  sleep 3
done
