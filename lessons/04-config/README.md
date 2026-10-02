# 04 — Configuration: ConfigMaps, Secrets, the Downward API

Build the image once, configure it per environment. Kubernetes has three sources of config:

- **ConfigMap**: non-sensitive keys/values or whole files (≈ SSM Parameter Store)
- **Secret**: the same shape, for sensitive data (≈ Secrets Manager, with a big caveat below)
- **Downward API**: facts about the pod itself (name, namespace, node, IP, resource limits)

Each can reach the container as **environment variables** or **files in a mounted volume**,
and the two behave very differently when the config changes.

`cd lessons/04-config`

## 1. Create config and consume it

Read [configmap.yaml](configmap.yaml), [secret.yaml](secret.yaml) and
[deployment.yaml](deployment.yaml), then:

```bash
kubectl apply -f configmap.yaml -f secret.yaml -f deployment.yaml
kubectl rollout status deploy/web
kubectl exec deploy/web -- curl -s localhost:8080/
```

`greeting` came from an env var and `configFile` from the mounted file. (`node`, `podIP`
and `namespace` are `null` because this Deployment doesn't inject them; that's challenge 1.)

```bash
kubectl exec deploy/web -- printenv GREETING API_TOKEN
kubectl exec deploy/web -- ls -la /etc/kubelab/
```

The listing is odd: `message.txt` links to `..data/message.txt`, and `..data` links to a
timestamped directory. That's for atomic updates: the kubelet writes a complete new
directory, then swaps the `..data` link in one rename, so the app never sees half an update.

## 2. Secrets are not encrypted by default

```bash
kubectl get secret web-secret -o yaml                        # .data is base64
kubectl get secret web-secret -o jsonpath='{.data.API_TOKEN}' | base64 -d; echo
```

Base64 is encoding, not encryption; it's there so Secrets can hold binary data. Worse, the
`last-applied-configuration` annotation holds your whole manifest, `stringData` in plain
text, courtesy of `kubectl apply`. What actually protects a Secret:

- **RBAC.** Anyone who can `get secrets` in the namespace can read them all (lesson 06), and
  so can anyone who can create pods there, since a pod can mount any Secret in its namespace.
- **Encryption at rest.** etcd stores Secrets unencrypted by default. On EKS, turn on KMS
  envelope encryption.
- **A source of truth elsewhere**, usually Secrets Manager, synced in by the External Secrets
  Operator or mounted by the Secrets Store CSI Driver.

Never commit real Secret manifests to git (this lab's token is fake); if you must, encrypt
them with Sealed Secrets or SOPS.

## 3. Updates: env vars vs files

Change both values:

```bash
kubectl patch configmap web-config --type merge \
  -p '{"data":{"GREETING":"updated greeting","message.txt":"updated file contents\n"}}'
```

Poll for a couple of minutes (Ctrl-C to stop):

```bash
watch -n5 "kubectl exec deploy/web -- curl -s localhost:8080/ | grep -E 'greeting|configFile'"
```

- The **file** changes in place within a minute or so (the kubelet re-syncs mounted
  ConfigMaps periodically). This app re-reads it on every request, so no restart needed.
- The **env var** never changes. A process's environment is fixed at start; nothing outside
  can edit it.

Gotcha: a ConfigMap mounted with `subPath` (one file dropped into an existing directory) is
copied once at container start and never updates.

To pick up env changes, replace the pods with a rolling restart (no downtime):

```bash
kubectl rollout restart deploy/web
kubectl rollout status deploy/web
kubectl exec deploy/web -- curl -s localhost:8080/ | grep greeting
```

`rollout restart` just stamps a `restartedAt` annotation into the pod template; the template
changed, so a normal rolling update follows. That restart is easy to forget, so two patterns
make it automatic:

- Put a hash of the config in a pod-template annotation (`checksum/config`). New config, new
  hash, new template, rollout. The Helm chart in lesson 08 does exactly this.
- Use immutable, versioned ConfigMaps (`web-config-v2`, `immutable: true`) and point the
  Deployment at the new name, so config changes get the same rollout and rollback as code.

## 4. Missing config breaks startup

```bash
kubectl patch deploy web --type json -p \
  '[{"op":"add","path":"/spec/template/spec/containers/0/envFrom","value":[{"configMapRef":{"name":"does-not-exist"}}]}]'
kubectl get pods -l app=web          # CreateContainerConfigError on the new pod
kubectl describe pod -l app=web --show-events | grep -i 'not found'
kubectl rollout undo deploy/web
```

The kubelet can't build the new pod's environment: `configmap "does-not-exist" not found`.
(`describe` hides events when it matches several objects, hence `--show-events`.) The old
pods keep serving: the default strategy (25% surge, 25% unavailable) rounds to "1 extra, 0
down" for 2 replicas, so nothing old goes away until something new is ready. You'll meet
this error again in the troubleshooting drills.

## 5. The Downward API

You met it in lesson 01: [deployment.yaml](deployment.yaml) sets `POD_NAME` from
`fieldRef: metadata.name`. Other useful fields: `metadata.namespace`,
`metadata.labels['app']`, `spec.nodeName`, `status.podIP`, and the container's own
requests/limits via `resourceFieldRef`, handy for sizing a heap or thread pool to the limit
the container actually got.

## Challenge

1. Add `NODE_NAME` and `POD_IP` to the Deployment with the Downward API, and check they show up on `/`.
2. Replace the individual `env` entries with `envFrom` to import *every* key of a ConfigMap
   as env vars. What happens to `message.txt`?
3. Create a ConfigMap from a local file imperatively, and look at the YAML it would produce:
   `kubectl create configmap from-file --from-file=../../app/server.py --dry-run=client -o yaml | head`.
   `--dry-run=client -o yaml` is the fastest way to scaffold *any* manifest.

<details><summary>Hints and answers</summary>

1. Two more `env` entries, `valueFrom: { fieldRef: { fieldPath: spec.nodeName } }` and
   `status.podIP`, then `kubectl apply -f deployment.yaml`. `/` now shows `node` and `podIP`.
2. `envFrom: [{configMapRef: {name: web-config}}]` imports `GREETING` *and* `message.txt`,
   dot and all (`kubectl exec deploy/web -- env`). Env var names may contain any printable
   ASCII except `=` (since v1.34; dots were allowed even before). A shell can't expand
   `$message.txt`, but the process sees it. Add `prefix:` to the `envFrom` entry to
   namespace the imported keys.
3. The file becomes one key, `server.py`, holding the whole file. Redirect the output to a
   file and you have a manifest to commit.
</details>

## Clean up

```bash
kubectl delete -f .
```
