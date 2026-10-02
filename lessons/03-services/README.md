# 03 — Services & networking

Every new pod gets a new IP, so how does anything find them? A **Service** gives a set of
pods (chosen by label selector) one stable virtual IP and DNS name, and spreads connections
across the ones that are **ready**.

Think internal NLB plus a Cloud Map entry, minus the box in the middle. There's no load
balancer process: `kube-proxy` on every node writes iptables (or nftables) rules that
rewrite packets for the virtual IP into packets for a real pod IP. The load balancer is
smeared across every node's kernel: there's no box to fail or to outgrow.

The network model, in three rules:

1. Every pod gets its own IP, and every pod can reach every other pod directly, without NAT.
2. Services put stable names and IPs on top.
3. Nothing is isolated by default. NetworkPolicies add isolation (like security groups).

`cd lessons/03-services`. You need the Deployment from lesson 02:

```bash
kubectl apply -f ../02-deployments/deployment.yaml
```

## 1. ClusterIP: internal service discovery

Read [service.yaml](service.yaml), then:

```bash
kubectl apply -f service.yaml
kubectl get svc web
kubectl get endpointslices -l kubernetes.io/service-name=web   # the pod IPs behind it
```

`CLUSTER-IP` is the virtual IP. The EndpointSlice lists the pod IPs behind it, kept current
by a controller watching pods that match the selector. Call the Service by name from a
throwaway pod:

```bash
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c 'for i in $(seq 8); do curl -s web/ | grep "\"pod\""; done'
```

(Ignore `If you don't see a command prompt`; that's `kubectl run` attaching, and it may eat
the first line or two of output.)

The spread is random, not round-robin, and per **connection**, not per request. Each `curl`
is a new connection, so it gets a fresh pick. A client holding one long-lived connection
(gRPC, HTTP keep-alive, a DB pool) sticks to one pod, which is why freshly scaled-up pods
sometimes sit idle.

## 2. DNS

CoreDNS gives every Service the name `<service>.<namespace>.svc.cluster.local`. Short names
work because of the `search` line in each pod's `/etc/resolv.conf`:

```bash
kubectl run tmp --rm -it --restart=Never --image=busybox:1.37 -- sh -c \
  'cat /etc/resolv.conf; nslookup -type=a web; nslookup -type=a kubernetes.default.svc.cluster.local'
```

The search list starts with your namespace, so `web` becomes `web.default.svc.cluster.local`.
From another namespace you'd write `web.default`, which works in normal apps. Busybox's
`nslookup` is quirkier: it only uses the search list for names with no dots (hence the
full name for `kubernetes.default`), and it reports every miss. Ignore the `NXDOMAIN` lines
and find the `Address`.

`ndots:5` means any name with fewer than five dots goes through the search list *first*, so
looking up `api.github.com` costs a few failed queries before the real one. At scale that's
real DNS load, which is why some teams write external names with a trailing dot
(`api.github.com.`).

## 3. Endpoints follow the pods

In a second terminal, watch which pods are behind the Service and whether they're ready:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web -w \
  -o custom-columns='PODS:.endpoints[*].targetRef.name,READY:.endpoints[*].conditions.ready'
```

Scale up and down and watch the list change:

```bash
kubectl scale deploy/web --replicas=5
kubectl scale deploy/web --replicas=2
```

New pods appear as soon as they have an IP, `false` until their readiness probe passes.
Deleted pods flip to `false` the moment they start terminating, then vanish. Only ready
endpoints get traffic.

Now make a running pod unready, using the app's `/unready` knob:

```bash
POD=$(kubectl get pod -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POD -- curl -s localhost:8080/unready
sleep 8
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c 'for i in $(seq 6); do curl -s web/ | grep "\"pod\""; done'
kubectl exec $POD -- curl -s localhost:8080/ready
```

After three failed probes two seconds apart, the watch shows that pod `false` and every
request goes to the other one. The pod wasn't restarted or removed; it just stopped getting
traffic. That's the mechanism behind zero-downtime deploys: a pod gets traffic only while it
says it can handle it (more in lesson 05).

## 4. NodePort and LoadBalancer: getting traffic in

A ClusterIP is only reachable from inside the cluster. Read
[service-lb.yaml](service-lb.yaml), then:

```bash
kubectl apply -f service-lb.yaml
kubectl get svc web-public -w       # EXTERNAL-IP goes from <pending> to an IP (Ctrl-C)
```

The `PORT(S)` column says something like `80:32310/TCP`. Three layers are stacked here:

- a **ClusterIP**, as before;
- a **NodePort**: port `32310` (random, from 30000–32767) opened on *every* node, even
  nodes with no matching pod, since every node's kube-proxy can forward across the cluster;
- a **LoadBalancer**: an external LB that forwards to those node ports. Here,
  cloud-provider-kind runs an Envoy container for it. On EKS, the AWS Load Balancer
  Controller creates an NLB that targets either the node ports (instance mode) or pod IPs
  directly (IP mode).

Try each layer from your terminal (outside the cluster):

```bash
LB=$(kubectl get svc web-public -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s $LB/

NODE_PORT=$(kubectl get svc web-public -o jsonpath='{.spec.ports[0].nodePort}')
NODE_IP=$(kubectl get node lab-worker -o jsonpath='{.status.addresses[0].address}')
curl -s $NODE_IP:$NODE_PORT/        # any node works, even one not running the pod
docker ps --filter label=io.x-k8s.cloud-provider-kind.cluster=lab   # the "cloud" LBs
```

One LoadBalancer per Service gets expensive and can't route by URL path or hostname, which
is why most HTTP traffic goes through a shared Gateway or Ingress instead (lesson 09).

## 5. Break it: selector mismatch

```bash
kubectl patch svc web -p '{"spec":{"selector":{"app":"wbe"}}}'
kubectl get endpointslices -l kubernetes.io/service-name=web
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- curl -sS -m 3 web/ ; echo "exit: $?"
```

The EndpointSlice is empty (`<unset>`). DNS still resolves, since the Service exists; it's
just hollow. The connection is refused instantly (curl exit 7), because kube-proxy rejects
traffic to Services with no endpoints.

This is one of the most common real-world mistakes. When a Service "doesn't work", check its
endpoints first: empty means the selector matches no ready pods; populated but failing
usually means the wrong `targetPort`. Fix it:

```bash
kubectl apply -f service.yaml
```

## Challenge

1. A headless Service (`clusterIP: None`) has no virtual IP, so DNS returns the pod IPs
   directly. Create one called `web-headless` for the same pods and compare
   `nslookup -type=a web` with `nslookup -type=a web-headless` from a busybox pod. Where is
   this useful? (Lesson 07 uses one.)
2. Write a NetworkPolicy called `web-allow-frontend` that only allows pods labelled
   `role: frontend` to reach `app: web` on port 8080. Test it from a pod with and without
   that label (`kubectl run` takes `--labels role=frontend`).
   **Note:** kind's CNI (kindnet) enforces NetworkPolicy, but not every CNI does. On EKS you
   enable it in the VPC CNI. Where nothing enforces it, the policy is silently ignored.

<details><summary>Hints and answers</summary>

1. Copy `service.yaml`, rename it, add `clusterIP: None`. `web` returns one virtual IP;
   `web-headless` returns one A record per ready pod, and clients connect straight to the
   pod on 8080 (no virtual IP, no port translation). Use it when the client must pick the
   pod: client-side load balancing (gRPC), or replicas with identities, like a database
   primary and its replicas. StatefulSets use one to give each pod a name like `redis-0.redis`.
2. `podSelector: {matchLabels: {app: web}}`, `policyTypes: [Ingress]`, and one ingress rule
   `from: [{podSelector: {matchLabels: {role: frontend}}}]`, `ports: [{port: 8080}]`. The
   port is the pod's, not the Service's 80: policy applies after the address translation.
   Without the label, curl times out (exit 28): packets are dropped, not refused. Once a
   policy selects a pod, everything not allowed is denied, so the LoadBalancer from
   section 4 is cut off too.
</details>

## Clean up

```bash
kubectl delete svc/web-headless networkpolicy/web-allow-frontend --ignore-not-found
kubectl delete -f . -f ../02-deployments/deployment.yaml --ignore-not-found
```
