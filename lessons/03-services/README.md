# 03 — Services & networking

Pods are ephemeral and their IPs change. A **Service** gives a set of pods (chosen by
label selector) one stable virtual IP and DNS name, and load-balances across the ones that
are **ready**. It's like an internal ALB/NLB plus a Cloud Map entry, except there's no
separate box: `kube-proxy` on every node programs iptables/IPVS rules so the virtual IP
works from anywhere in the cluster.

Kubernetes networking rules:
1. Every pod gets its own IP, and all pods can reach each other without NAT.
2. Services provide stable names/IPs on top.
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

Call it from inside the cluster by name, and watch requests spread across pods:

```bash
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c 'for i in $(seq 8); do curl -s web/ | grep "\"pod\""; done'
```

## 2. DNS

CoreDNS gives every Service a name: `<service>.<namespace>.svc.cluster.local`.
Short names work thanks to the pod's DNS search path:

```bash
kubectl run tmp --rm -it --restart=Never --image=busybox:1.37 -- sh -c \
  'cat /etc/resolv.conf; nslookup web; nslookup web.default.svc.cluster.local; nslookup kubernetes.default'
```

From another namespace you'd use `web.default` (or the full name).

## 3. Endpoints follow the pods

In a second terminal:

```bash
kubectl get endpointslices -l kubernetes.io/service-name=web -w
```

Then scale up and down and watch the endpoint list change:

```bash
kubectl scale deploy/web --replicas=5
kubectl scale deploy/web --replicas=2
```

This is the mechanism behind zero-downtime deploys. Pods only join the endpoints once
they're ready, and they leave when they start terminating (more in lesson 05).

## 4. NodePort and LoadBalancer: getting traffic in

Read [service-lb.yaml](service-lb.yaml):

```bash
kubectl apply -f service-lb.yaml
kubectl get svc web-public -w       # EXTERNAL-IP goes from <pending> to an IP (Ctrl-C)
```

Three layers are at work:
- a **ClusterIP** (always),
- a **NodePort**: the `80:3xxxx/TCP` port opened on *every* node,
- the **LoadBalancer**: an external LB (here, a container made by cloud-provider-kind;
  on EKS, an NLB) that forwards to those node ports or directly to pod IPs.

```bash
LB=$(kubectl get svc web-public -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s $LB/

NODE_PORT=$(kubectl get svc web-public -o jsonpath='{.spec.ports[0].nodePort}')
NODE_IP=$(kubectl get node lab-worker -o jsonpath='{.status.addresses[0].address}')
curl -s $NODE_IP:$NODE_PORT/        # any node works, even one not running the pod
docker ps --filter label=io.x-k8s.cloud-provider-kind.cluster=lab   # the "cloud" LB
```

One LoadBalancer per service gets expensive and doesn't do L7 routing, which is why most
HTTP traffic goes through a shared Gateway or Ingress instead (lesson 09).

## 5. Break it: selector mismatch

```bash
kubectl patch svc web -p '{"spec":{"selector":{"app":"wbe"}}}'
kubectl get endpointslices -l kubernetes.io/service-name=web
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- curl -s -m 3 web/ ; echo "exit: $?"
```

No endpoints, so connections fail. This is one of the most common real-world mistakes:
a Service that "doesn't work" usually has a selector that matches nothing, or the wrong
`targetPort`. Fix it:

```bash
kubectl apply -f service.yaml
```

## Challenge

1. A headless Service (`clusterIP: None`) has no virtual IP, so DNS returns the pod IPs
   directly. Create one called `web-headless` for the same pods and compare
   `nslookup web` with `nslookup web-headless` from a busybox pod. Where is this useful?
   (Lesson 07 uses one.)
2. Write a NetworkPolicy that only allows pods labelled `role: frontend` to reach `app: web`
   on port 8080. Test it from a pod with and without that label.
   **Note:** kind's CNI (kindnet) enforces NetworkPolicy, but not every CNI does. On EKS you
   enable it in the VPC CNI. Where there's no enforcement, the policy is silently ignored.

## Clean up

```bash
kubectl delete -f . -f ../02-deployments/deployment.yaml --ignore-not-found
```
