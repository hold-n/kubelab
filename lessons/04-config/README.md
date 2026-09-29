# 04 — Configuration: ConfigMaps, Secrets, the Downward API

Build the image once and configure it per environment (12-factor). Kubernetes gives you:

- **ConfigMap**: non-sensitive key/value data or whole files (≈ SSM Parameter Store)
- **Secret**: the same shape, for sensitive data (≈ Secrets Manager, but see the caveat below)
- **Downward API**: facts about the pod itself (name, namespace, node, IP, resource limits)

Each can be consumed as **environment variables** or **files in a mounted volume**, and
the two behave differently on updates.

`cd lessons/04-config`

## 1. Create config and consume it

Read [configmap.yaml](configmap.yaml), [secret.yaml](secret.yaml) and
[deployment.yaml](deployment.yaml), then:

```bash
kubectl apply -f configmap.yaml -f secret.yaml -f deployment.yaml
kubectl rollout status deploy/web
kubectl exec deploy/web -- curl -s localhost:8080/
```

`greeting` came from an env var, and `configFile` came from the mounted file.

```bash
kubectl exec deploy/web -- printenv GREETING API_TOKEN
kubectl exec deploy/web -- ls -la /etc/kubelab/    # note the ..data symlink - used for atomic updates
```

## 2. Secrets are not encrypted by default

```bash
kubectl get secret web-secret -o yaml                        # .data is base64
kubectl get secret web-secret -o jsonpath='{.data.API_TOKEN}' | base64 -d; echo
```

Anyone who can `get secrets` in the namespace can read them, so protect them with RBAC
(lesson 06). On EKS you'd turn on KMS envelope encryption for etcd, and usually keep the
source of truth in Secrets Manager, synced in by the External Secrets Operator or the
Secrets Store CSI Driver. Never commit plain Secret manifests to git. Look at Sealed
Secrets or SOPS if you need secrets in git.

## 3. Updates: env vars vs files

Change both values:

```bash
kubectl patch configmap web-config --type merge \
  -p '{"data":{"GREETING":"updated greeting","message.txt":"updated file contents\n"}}'
```

Poll for a couple of minutes:

```bash
watch -n5 "kubectl exec deploy/web -- curl -s localhost:8080/ | grep -E 'greeting|configFile'"
```

- The **file** updates in place within about 1–2 minutes (kubelet sync period + cache TTL).
  Apps that re-read or watch their config files pick up changes without a restart.
- The **env var** never changes. Environment is fixed at process start.

To pick up env changes, restart the pods with a rolling restart (no downtime):

```bash
kubectl rollout restart deploy/web
kubectl rollout status deploy/web
kubectl exec deploy/web -- curl -s localhost:8080/ | grep greeting
```

A common pattern is to put a hash of the config in a pod-template annotation, so any config
change automatically triggers a rollout. The Helm chart in lesson 08 does exactly this.
Another is immutable, versioned ConfigMaps (`web-config-v2`, `immutable: true`) that you
switch to in the Deployment. That makes config changes go through the same
rollout/rollback flow as code.

## 4. Missing config breaks startup

```bash
kubectl patch deploy web --type json -p \
  '[{"op":"add","path":"/spec/template/spec/containers/0/envFrom","value":[{"configMapRef":{"name":"does-not-exist"}}]}]'
kubectl get pods -l app=web          # CreateContainerConfigError on the new pod
kubectl describe pod -l app=web | grep -i 'not found'
kubectl rollout undo deploy/web
```

The old pods keep serving because the new one never becomes ready. (You'll meet this error
again in the troubleshooting drills.)

## 5. The Downward API

The app shows `pod` and `node`. Look at how [deployment.yaml](deployment.yaml) gets
`POD_NAME` with `fieldRef`. Other useful fields are `metadata.namespace`,
`metadata.labels['app']`, `spec.nodeName`, `status.podIP`, and container resources via
`resourceFieldRef`.

## Challenge

1. Add `NODE_NAME` and `POD_IP` to the Deployment with the Downward API, and check they show up on `/`.
2. Replace the individual `env` entries with `envFrom` to import *every* key of a ConfigMap
   as env vars. What happens to `message.txt`? (Keys that aren't valid env var names get skipped.)
3. Create a ConfigMap from a local file imperatively, and look at the YAML it would produce:
   `kubectl create configmap from-file --from-file=../../app/server.py --dry-run=client -o yaml | head`.
   `--dry-run=client -o yaml` is the fastest way to scaffold *any* manifest.

## Clean up

```bash
kubectl delete -f .
```
