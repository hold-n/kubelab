# 08 — Helm (and a taste of Kustomize)

By now you've felt the pain: piles of YAML, staging and prod as near-copies that drift
apart, and nothing in the cluster that knows these six objects are "the shop app,
version 7".

Two tools dominate:

- **Helm** is a package manager. A *chart* is a bundle of templated YAML plus default
  *values*. Installing a chart creates a *release*, which Helm versions so you can upgrade
  and roll back. Nearly every piece of infrastructure software ships a chart (AWS Load
  Balancer Controller, Karpenter, Argo CD, Prometheus…). If you know CloudFormation:
  chart ≈ template with parameters, release ≈ stack, revision ≈ stack update.
- **Kustomize** has no templates at all. You keep plain YAML (a *base*) and layer patches
  on top per environment (*overlays*). It's built into kubectl (`kubectl apply -k`).

Most teams use Helm to install other people's software, and Helm or Kustomize for their own.

`cd lessons/08-helm`

## Part A: install someone else's chart

We'll install **metrics-server**, which collects CPU and memory usage from every kubelet.
It powers `kubectl top` and the autoscaler in lesson 12.

Charts live in repositories, like apt or npm packages:

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm search repo metrics-server
helm show values metrics-server/metrics-server | less     # every knob the chart exposes
```

kind's kubelets serve self-signed certificates, which metrics-server rightly refuses to
trust, so on this lab cluster we tell it not to check:

```bash
helm install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --set 'args={--kubelet-insecure-tls}' \
  --wait
```

(`{a,b}` is `--set`'s syntax for a list. `--wait` blocks until the pods are ready.)

What Helm knows about it:

```bash
helm list -A
helm status metrics-server -n kube-system
helm get values metrics-server -n kube-system          # only what you overrode
helm get manifest metrics-server -n kube-system | less # the rendered YAML Helm applied
kubectl get secrets -n kube-system -l owner=helm       # release state is stored as Secrets in-cluster
```

That last line answers "where does Helm keep state?" Not on your laptop and not on a
server: each revision is a Secret named `sh.helm.release.v1.<release>.v<N>` in the
release's namespace, so everyone with cluster access sees the same history.

After ~30s (metrics-server needs a couple of samples):

```bash
kubectl top nodes
kubectl top pods -A
```

## Part B: write your own chart

The [kubelab/](kubelab/) directory is a chart for our app. Read it in this order:

1. [Chart.yaml](kubelab/Chart.yaml): name and versions
2. [values.yaml](kubelab/values.yaml): the defaults. This file is the chart's API.
3. [templates/_helpers.tpl](kubelab/templates/_helpers.tpl): reusable named snippets (names, labels)
4. [templates/deployment.yaml](kubelab/templates/deployment.yaml): `{{ .Values.x }}`, `include`,
   `with`, `toYaml | nindent`, and the `checksum/config` trick from lesson 04
5. [templates/NOTES.txt](kubelab/templates/NOTES.txt): printed after install

The templates are Go `text/template`, which knows nothing about YAML. It's string
substitution, so indentation is your problem; that's what `nindent` is for.

Render locally, without touching the cluster. This is the most useful Helm debugging tool:

```bash
helm lint ./kubelab
helm template demo ./kubelab | less
helm template demo ./kubelab --set replicaCount=5 --set image.tag=v2 | grep -E 'replicas|image:'
```

Install one release into `default`, and a "prod" release with its own values file into
its own namespace:

```bash
helm install demo ./kubelab --wait
helm install shop ./kubelab -n prod --create-namespace -f values-prod.yaml --wait
helm list -A
kubectl get deploy -A -l app.kubernetes.io/managed-by=Helm
kubectl exec -n prod deploy/shop-kubelab -- curl -s localhost:8080/
```

Same chart, two independent releases; objects are named `<release>-kubelab`, so they
never collide. The `shop` response shows `v2` and `hello from PROD`, both from
[values-prod.yaml](values-prod.yaml).

Now upgrade, then roll back:

```bash
helm upgrade demo ./kubelab --set greeting="upgraded" --set image.tag=v2 --wait
helm history demo
kubectl exec deploy/demo-kubelab -- curl -s localhost:8080/ | grep -E 'version|greeting'

helm rollback demo 1 --wait
helm history demo                    # rollback is a *new* revision (3), not a rewind
kubectl exec deploy/demo-kubelab -- curl -s localhost:8080/ | grep -E 'version|greeting'
```

You'll see v2/"upgraded", then v1/"hello from Helm". In `helm history`, revision 3 says
`Rollback to 1`: history only grows, like `git revert` rather than `reset --hard`. The APP
VERSION column says `v1` throughout because it's the chart's `appVersion`, not the image
tag you overrode.

### The values trap

`helm upgrade` doesn't merge with last time's values. Pass *any* values (`--set` or `-f`)
and everything you didn't pass reverts to chart defaults. Suppose revision 2 set
`image.tag=v2` and a colleague runs `helm upgrade demo ./kubelab --set replicaCount=3`:
the image silently goes back to v1. (An upgrade with *no* values reuses the previous ones,
a surprise of its own.) `--reuse-values` is usually a trap too: on a new chart version it
ignores the new chart's defaults.

The boring fix: `--set` is for experiments. Pipelines keep one values file per environment
in git and always run `helm upgrade --install <release> <chart> -f values-<env>.yaml`,
which installs or upgrades as needed and always gives the same result.

## Part C: Kustomize in five minutes

[kustomize/base](kustomize/base) is plain YAML you could apply on its own. The
[staging overlay](kustomize/overlays/staging/kustomization.yaml) sets a namespace, a name
prefix, an `env: staging` label and the image tag, and patches the replica count and an
env var.

```bash
kubectl kustomize kustomize/overlays/staging     # render
kubectl apply -k kustomize/overlays/staging
kubectl get all -n staging
kubectl exec -n staging deploy/staging-web -- curl -s localhost:8080/ | grep -E 'version|greeting'
kubectl delete -k kustomize/overlays/staging
```

Unlike Helm, Kustomize understands objects, not just text: in the render, the label also
went into the Service and Deployment selectors (`includeSelectors: true`), so everything
still lines up. The catch: Deployment selectors are immutable, so adding such a label to
an already-running app means recreating the Deployment.

| | Helm | Kustomize |
|---|---|---|
| Model | templates + values | base YAML + patches |
| Packaging/distribution | charts in repos / OCI registries | directories in git |
| Release tracking & rollback | yes (`helm history/rollback`) | no (use git / GitOps) |
| Learning curve | Go templates get hairy | stays plain YAML |
| Typical use | installing third-party software; also your own apps | per-environment config for your own apps |

They combine, too: Kustomize can inflate a Helm chart and patch the result, and Argo CD
handles both.

## Challenge

1. Add an optional `HTTPRoute` (or `Ingress`) template to the chart that's only rendered
   when `route.enabled: true` (hint: wrap the whole file in `{{- if .Values.route.enabled }}`).
   Come back to this after lesson 09.
2. Add a `values.schema.json` that requires `replicaCount` to be an integer ≥ 1, then try
   `helm install bad ./kubelab --set replicaCount=zero`.
3. Package the chart (`helm package ./kubelab`) and look inside the `.tgz` with `tar tzf`.
   Charts are usually published to an OCI registry (e.g. ECR) with `helm push`.

<details>
<summary>Answer to 2</summary>

Save this as `kubelab/values.schema.json`. Helm validates values against it on `install`,
`upgrade`, `lint` and `template`.

```json
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["replicaCount"],
  "properties": {
    "replicaCount": { "type": "integer", "minimum": 1 }
  }
}
```

`--set replicaCount=zero` now fails before touching the cluster, with
`at '/replicaCount': got string, want integer`; `--set replicaCount=0` fails the minimum
check. A schema turns typos in values files into errors instead of silently-wrong YAML.

</details>

## Clean up

Keep metrics-server installed, since later lessons use it.

```bash
helm uninstall demo
helm uninstall shop -n prod && kubectl delete namespace prod
rm -f kubelab-*.tgz                  # if you did challenge 3
```
