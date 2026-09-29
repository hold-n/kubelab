# 08 — Helm (and a taste of Kustomize)

By now you've noticed the pain: lots of YAML, near-duplicates per environment, and no
notion of "this group of objects is one app, at version N". Two tools dominate:

- **Helm**: a package manager. A *chart* is a bundle of Go-templated YAML plus default
  *values*. Installing a chart creates a *release*, which Helm versions so you can upgrade
  and roll back. There's a huge public ecosystem: nearly every piece of infrastructure
  software ships a chart (the AWS Load Balancer Controller, Karpenter, Argo CD,
  Prometheus…).
  Roughly: chart ≈ CloudFormation template with parameters, release ≈ stack, revision ≈ stack update.
- **Kustomize**: no templates. Start from plain YAML (a *base*) and layer patches per
  environment (*overlays*). It's built into kubectl (`kubectl apply -k`).

Most teams use Helm to install third-party software, and either Helm or Kustomize for
their own services.

`cd lessons/08-helm`

## Part A: install someone else's chart

We'll install **metrics-server**, which collects CPU/memory usage from kubelets. It powers
`kubectl top` and the autoscaler in lesson 12.

```bash
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm search repo metrics-server
helm show values metrics-server/metrics-server | less     # every knob the chart exposes
```

kind's kubelets use self-signed certificates, so we need one override:

```bash
helm install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --set 'args={--kubelet-insecure-tls}' \
  --wait
```

Look at what you got:

```bash
helm list -A
helm status metrics-server -n kube-system
helm get values metrics-server -n kube-system          # only what you overrode
helm get manifest metrics-server -n kube-system | less # the rendered YAML Helm applied
kubectl get secrets -n kube-system -l owner=helm       # release state is stored as Secrets in-cluster
```

After ~30s:

```bash
kubectl top nodes
kubectl top pods -A
```

## Part B: write your own chart

The [kubelab/](kubelab/) directory is a chart for our app. Read it in this order:

1. [Chart.yaml](kubelab/Chart.yaml): name and versions
2. [values.yaml](kubelab/values.yaml): the defaults, i.e. the chart's "API"
3. [templates/_helpers.tpl](kubelab/templates/_helpers.tpl): reusable named snippets (names, labels)
4. [templates/deployment.yaml](kubelab/templates/deployment.yaml): `{{ .Values.x }}`, `include`,
   `with`, `toYaml | nindent`, and the `checksum/config` trick from lesson 04
5. [templates/NOTES.txt](kubelab/templates/NOTES.txt): printed after install

Render it locally without touching the cluster. This is the most useful Helm debugging tool:

```bash
helm lint ./kubelab
helm template demo ./kubelab | less
helm template demo ./kubelab --set replicaCount=5 --set image.tag=v2 | grep -E 'replicas|image:'
```

Install one release in `default`, and a "prod" release with different values into its own namespace:

```bash
helm install demo ./kubelab --wait
helm install shop ./kubelab -n prod --create-namespace -f values-prod.yaml --wait
helm list -A
kubectl get deploy -A -l app.kubernetes.io/managed-by=Helm
kubectl exec -n prod deploy/shop-kubelab -- curl -s localhost:8080/
```

Same chart, two independent releases. Now upgrade and roll back:

```bash
helm upgrade demo ./kubelab --set greeting="upgraded" --set image.tag=v2 --wait
helm history demo
kubectl exec deploy/demo-kubelab -- curl -s localhost:8080/ | grep -E 'version|greeting'

helm rollback demo 1 --wait
helm history demo                    # rollback is a *new* revision (3), not a rewind
kubectl exec deploy/demo-kubelab -- curl -s localhost:8080/ | grep -E 'version|greeting'
```

> **`--set` vs values files:** `--set` is for experiments. In real pipelines, keep a values
> file per environment in git and run `helm upgrade --install <release> <chart> -f values-<env>.yaml`
> (install-or-upgrade, idempotent).

Watch out for one thing: after `helm upgrade`, values you *don't* pass revert to chart
defaults (`--reuse-values` changes that, but it's usually a trap). Explicit values files
avoid the surprise.

## Part C: Kustomize in five minutes

[kustomize/base](kustomize/base) is plain YAML. The
[staging overlay](kustomize/overlays/staging/kustomization.yaml) sets a namespace, a
name prefix, labels, the image tag, and patches the replica count and an env var.

```bash
kubectl kustomize kustomize/overlays/staging     # render
kubectl apply -k kustomize/overlays/staging
kubectl get all -n staging
kubectl exec -n staging deploy/staging-web -- curl -s localhost:8080/ | grep -E 'version|greeting'
kubectl delete -k kustomize/overlays/staging
```

| | Helm | Kustomize |
|---|---|---|
| Model | templates + values | base YAML + patches |
| Packaging/distribution | charts in repos / OCI registries | directories in git |
| Release tracking & rollback | yes (`helm history/rollback`) | no (use git / GitOps) |
| Learning curve | Go templates get hairy | stays plain YAML |
| Typical use | installing third-party software; also your own apps | per-environment config for your own apps |

You can combine them (Kustomize can inflate a Helm chart, and Argo CD handles both).

## Challenge

1. Add an optional `ingress`/`HTTPRoute` template to the chart that's only rendered when
   `route.enabled: true` (hint: wrap the whole file in `{{- if .Values.route.enabled }}`).
   Come back to this after lesson 09.
2. Add a `values.schema.json` that requires `replicaCount` to be an integer ≥ 1, then try
   `helm install bad ./kubelab --set replicaCount=zero`.
3. Package the chart (`helm package ./kubelab`) and look at what you get. Charts are usually
   published to an OCI registry (e.g. ECR) with `helm push`.

## Clean up

Keep metrics-server installed, since later lessons use it.

```bash
helm uninstall demo
helm uninstall shop -n prod && kubectl delete namespace prod
```
