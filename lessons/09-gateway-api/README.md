# 09 — Gateway API: HTTP routing into the cluster

A `LoadBalancer` Service per app (lesson 03) is L4-only and gives you one cloud LB per
service. For HTTP you want one shared entry point with host/path/header routing, TLS
termination and traffic splitting. That's the job of the **Gateway API**, the successor to
the older **Ingress** resource.

> **Ingress vs Gateway API:** you'll still see `kind: Ingress` everywhere, and the AWS Load
> Balancer Controller supports both. But the popular ingress-nginx controller was retired in
> 2026, and new work targets the Gateway API. Learn Gateway API. If you ever need to read
> an Ingress, you'll recognise the concepts.

The API is split by role, which maps well onto how AWS orgs work:

```
GatewayClass   "which implementation"            platform team      ≈ choosing ALB vs NLB
   └─ Gateway  "a load balancer + listeners"     platform/infra     ≈ an ALB and its listeners
        └─ HTTPRoute "routing rules → Services"  app teams          ≈ listener rules + target groups
```

Like everything else, Gateway API objects are just data. A **controller** implements them.
We'll use **Envoy Gateway** (installed with Helm, so you get more practice), which turns each
Gateway into an Envoy proxy Deployment behind a `LoadBalancer` Service.

`cd lessons/09-gateway-api`

## 1. Install the controller with Helm

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.2 \
  -n envoy-gateway-system --create-namespace --wait
kubectl get pods -n envoy-gateway-system
kubectl get crd | grep gateway       # the chart added new API types to the cluster
kubectl explain httproute.spec.rules # ...and they're first-class, documented API objects
```

That's a key Kubernetes idea: **CustomResourceDefinitions (CRDs)** extend the API. Envoy
Gateway is a controller that watches those custom resources. (More in lesson 15.)

## 2. Deploy two versions of the app

Read [apps.yaml](apps.yaml): `web-v1` and `web-v2`, each with its own Service.

```bash
kubectl apply -f apps.yaml
kubectl get deploy,svc -l app=web
```

## 3. Create the GatewayClass and Gateway

Read [gatewayclass.yaml](gatewayclass.yaml) and [gateway.yaml](gateway.yaml):

```bash
kubectl apply -f gatewayclass.yaml -f gateway.yaml
kubectl get gatewayclass
kubectl wait --for=condition=Programmed gateway/web-gateway --timeout=120s
kubectl get gateway web-gateway
kubectl get deploy,svc -n envoy-gateway-system   # the controller created an Envoy deployment + LB service
kubectl wait -n envoy-gateway-system --for=condition=Ready pods \
  -l gateway.envoyproxy.io/owning-gateway-name=web-gateway --timeout=120s
```

## 4. Route traffic

Read [routes.yaml](routes.yaml). It has three rule types: header match, path prefix with
rewrite, and a weighted default.

```bash
kubectl apply -f routes.yaml
kubectl get httproute web -o yaml | grep -A8 'status:'   # Accepted / ResolvedRefs conditions
GW=$(kubectl get gateway web-gateway -o jsonpath='{.status.addresses[0].value}')

curl -s $GW/v1/ | grep version                 # path routing
curl -s $GW/v2/ | grep version
curl -s -H 'x-canary: true' $GW/ | grep version  # header routing

for i in $(seq 100); do curl -s $GW/ | grep '"version"'; done | sort | uniq -c   # ~90/10 split
```

### A canary rollout by hand

Edit the weights in `routes.yaml` to 50/50, `kubectl apply`, and measure again. Then 0/100.
That's a canary release. Tools like Argo Rollouts or Flagger automate exactly these steps
and roll back automatically when metrics degrade.

## 5. See it in your browser (optional)

The Gateway IP is only reachable inside this orb. To expose it through an Amp portal URL,
run this from the repo root:

```bash
amp orb service start gateway --port 8088 --portal --title 'kubelab gateway' --command \
  'kubectl port-forward -n envoy-gateway-system $(kubectl get svc -n envoy-gateway-system -l gateway.envoyproxy.io/owning-gateway-name=web-gateway -o name) $PORT:80'
```

It prints a URL you can open. Stop it with `amp orb service stop gateway`.

## Challenge

1. Add a second listener hostname: make a new HTTPRoute with `hostnames: ["admin.kubelab.local"]`
   that sends everything to `web-v2`, and test with `curl -H 'Host: admin.kubelab.local' $GW/`.
2. Add a response header `x-served-by: kubelab` to all responses from the `/v1` rule using a
   `ResponseHeaderModifier` filter (`kubectl explain httproute.spec.rules.filters`).
3. Scale `web-v2` to 0 while the 90/10 split is active. What do clients see for the 10%?
   What would you want to happen? (This is why canaries need automated analysis.)
4. Go back to the Helm chart from lesson 08 and add an optional HTTPRoute template.

## Clean up

Keep Envoy Gateway and the GatewayClass. The capstone uses them.

```bash
kubectl delete -f routes.yaml -f gateway.yaml -f apps.yaml
```
