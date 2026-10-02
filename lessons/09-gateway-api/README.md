# 09 — Gateway API: HTTP routing into the cluster

A `LoadBalancer` Service (lesson 03) is L4: one cloud load balancer per Service, blind to
HTTP. Twenty services means twenty NLBs, and still no path routing, no central TLS
termination, no way to send 10% of traffic to a new version. You want one shared entry
point (think ALB) that routes by host, path and header. That's the **Gateway API**, the
successor to the older **Ingress** resource.

> **Ingress vs Gateway API:** you'll still see `kind: Ingress` everywhere, and the AWS Load
> Balancer Controller supports both. But the popular ingress-nginx controller was retired in
> 2026, and new work targets the Gateway API. Learn Gateway API; if you ever need to read
> an Ingress, the concepts carry over.

The API is split by role, which maps neatly onto how AWS orgs divide the work:

```
GatewayClass   "which implementation"            platform team      ≈ choosing ALB vs NLB
   └─ Gateway  "a load balancer + listeners"     platform/infra     ≈ an ALB and its listeners
        └─ HTTPRoute "routing rules → Services"  app teams          ≈ listener rules + target groups
```

Why split it? So app teams can edit their routes without touching the shared load
balancer, and RBAC (lesson 06) can enforce that line.

These objects are just data. A **controller** reads them and builds a real proxy, and
there are many to choose from (AWS's, Istio, Cilium, NGINX…). We'll use **Envoy Gateway**,
which turns each Gateway into an Envoy proxy Deployment behind a `LoadBalancer` Service.
It installs with Helm, so you get more practice.

`cd lessons/09-gateway-api`

## 1. Install the controller with Helm

This chart lives in an OCI registry, so there's no `helm repo add`; install straight from
the `oci://` URL.

```bash
helm install eg oci://docker.io/envoyproxy/gateway-helm --version v1.9.2 \
  -n envoy-gateway-system --create-namespace --wait
kubectl get pods -n envoy-gateway-system
kubectl get crd | grep gateway       # the chart added new API types to the cluster
kubectl explain httproute.spec.rules # ...and they're first-class, documented API objects
```

(The `Completed` `certgen` pod is a one-off Job that made the controller's internal TLS
certificates.)

That CRD list is a key Kubernetes idea. Gateway API isn't built in; it's a set of
**CustomResourceDefinitions (CRDs)** that extend the API with new object types, after which
`kubectl get httproute` works just like `kubectl get pods`. Envoy Gateway is a controller
watching those types. (More in lesson 15.)

## 2. Deploy two versions of the app

Read [apps.yaml](apps.yaml): `web-v1` and `web-v2`, each with its own Service.

```bash
kubectl apply -f apps.yaml
kubectl get deploy,svc -l app=web
```

The Services are plain `ClusterIP`: the Gateway will be the only way in.

## 3. Create the GatewayClass and Gateway

Read [gatewayclass.yaml](gatewayclass.yaml) and [gateway.yaml](gateway.yaml), then:

```bash
kubectl apply -f gatewayclass.yaml -f gateway.yaml
kubectl get gatewayclass
kubectl wait --for=condition=Programmed gateway/web-gateway --timeout=120s
kubectl get gateway web-gateway
kubectl get deploy,svc -n envoy-gateway-system   # the controller created an Envoy deployment + LB service
kubectl wait -n envoy-gateway-system --for=condition=Ready pods \
  -l gateway.envoyproxy.io/owning-gateway-name=web-gateway --timeout=120s
```

What happened:

- `ACCEPTED True` on the GatewayClass: Envoy Gateway recognised its `controllerName`.
- Your Gateway lives in your namespace, but the proxy implementing it (a Deployment and a
  `LoadBalancer` Service named `envoy-<namespace>-web-gateway-<hash>`) appeared in
  `envoy-gateway-system`.
- `PROGRAMMED True` plus an `ADDRESS`: the proxy got an external IP from
  cloud-provider-kind, like any `LoadBalancer` Service.

With no routes yet, the Gateway answers everything with a 404.

## 4. Route traffic

Read [routes.yaml](routes.yaml). It has three kinds of rule: a header match, path prefixes
with a rewrite, and a weighted default.

```bash
kubectl apply -f routes.yaml
kubectl get httproute web -o jsonpath='{range .status.parents[*].conditions[*]}{.type}={.status}  {.message}{"\n"}{end}'
GW=$(kubectl get gateway web-gateway -o jsonpath='{.status.addresses[0].value}')

curl -s $GW/v1/ | grep version                 # path routing
curl -s $GW/v2/ | grep version
curl -s -H 'x-canary: true' $GW/ | grep version  # header routing

for i in $(seq 100); do curl -s $GW/ | grep '"version"'; done | sort | uniq -c   # ~90/10 split
```

Check the route's status first whenever a route "doesn't work". You want `Accepted=True`
(the Gateway took it) and `ResolvedRefs=True` (every Service it names exists). A typo'd
Service name shows up here as `ResolvedRefs=False`; `kubectl apply` won't complain.

The split won't be exactly 90/10 (89/11 is typical): each request is an independent
weighted coin flip.

### Which rule wins?

Try this:

```bash
curl -s -H 'x-canary: true' $GW/v1/ | grep version
```

v1, despite the canary header. Unlike ALB listener rules there's no priority number, and
rule order in the file doesn't matter. Gateway API picks the most specific match: longest
path first, then most header matches. The canary rule has no path match, which counts as
`PathPrefix /`, so it loses to `/v1` and beats only the catch-all.

The upside: routes from many teams merge onto one Gateway without anyone negotiating
priority numbers. The downside: you have to know the precedence rules (summarised in
[routes.yaml](routes.yaml)).

### A canary rollout by hand

Edit the weights in `routes.yaml` to 50/50, `kubectl apply -f routes.yaml`, and measure
again. Then 0/100. That's a canary release. Argo Rollouts and Flagger automate exactly
these steps, and roll back on their own when metrics degrade.

## 5. See it in your browser (optional)

The Gateway IP is only reachable inside this orb, so the course portal includes a proxy for
it. Open **Tool UIs → Gateway** in the course header (or **Gateway (lesson 09)** in the Portal
tab). Try `/v1/`, `/v2/`, and refreshing `/` a few times to see the 90/10 split.

Behind the scenes it's a `kubectl port-forward` to the Envoy pods that Envoy Gateway created
for `web-gateway` (see [portal/server.mjs](../../portal/server.mjs), `forward` mode).

## Challenge

1. Route a hostname: make a new HTTPRoute with `hostnames: ["admin.kubelab.local"]` that
   sends everything to `web-v2`, and test with `curl -H 'Host: admin.kubelab.local' $GW/`.
   Does `curl $GW/` (no Host header) change?
2. Add a response header `x-served-by: kubelab` to all responses from the `/v1` rule using a
   `ResponseHeaderModifier` filter (`kubectl explain httproute.spec.rules.filters`). Check
   with `curl -si $GW/v1/`.
3. Scale `web-v2` to 0 while the 90/10 split is active. What do clients see for the 10%?
   What would you want to happen? (This is why canaries need automated analysis.)
4. Go back to the Helm chart from lesson 08 and add an optional HTTPRoute template.

<details>
<summary>Hints and answers</summary>

1. Copy `parentRefs` from `routes.yaml`, add `hostnames`, and use one rule whose only
   `backendRefs` entry is `web-v2`. Hostname specificity outranks everything else, so for
   `Host: admin.kubelab.local` this route wins even for `/v1/` (which v2 answers with a
   404: the app has no `/v1/` path). Other hosts still hit the `web` route, which has no
   `hostnames` and so matches every host.
2. Add a second filter next to the `URLRewrite` in the `/v1` rule:
   ```yaml
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            add:
              - name: x-served-by
                value: kubelab
   ```
3. About 10% of requests to `/` get an empty `503 Service Unavailable`: Envoy keeps
   sending v2 its share even with no ready endpoints. You'd want the weight shifted back
   to v1 automatically, which is what Argo Rollouts/Flagger do when the error rate rises.
   Restore with `kubectl scale deploy web-v2 --replicas=2`.

</details>

## Clean up

Keep Envoy Gateway and the GatewayClass. The capstone uses them.

```bash
kubectl delete -f routes.yaml -f gateway.yaml -f apps.yaml
```

Deleting the Gateway also removes the Envoy Deployment and Service created for it.
