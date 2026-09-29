# 12 — Autoscaling

Kubernetes autoscales at two levels:

```
Pods:   HorizontalPodAutoscaler (HPA)   more/fewer replicas based on metrics   ≈ ASG target tracking
        VerticalPodAutoscaler (VPA)     right-size requests/limits
        KEDA                            scale on queue depth, events, cron (even to zero)
Nodes:  Cluster Autoscaler / Karpenter  add nodes when pods are Pending, remove idle nodes
```

They chain together. Load goes up, the HPA adds pods, pods go `Pending` because nodes are
full, and Karpenter launches EC2 instances. This lesson covers the HPA. Node autoscaling
needs a cloud (lesson 15).

**Prerequisite:** metrics-server, installed with Helm in lesson 08. Check that
`kubectl top nodes` works.

`cd lessons/12-autoscaling`

## 1. Deploy an app with CPU requests

Read [app.yaml](app.yaml). The HPA computes utilisation as a percentage **of requests**, so
requests are mandatory.

```bash
kubectl apply -f app.yaml
kubectl rollout status deploy/autoscale
```

## 2. Create the HPA

Read [hpa.yaml](hpa.yaml):

```bash
kubectl apply -f hpa.yaml
kubectl get hpa autoscale -w     # TARGETS goes from <unknown> to ~1%/50% (Ctrl-C)
```

## 3. Add load

[load.yaml](load.yaml) calls `/burn?seconds=1` twice a second, and each request makes a
pod burn CPU for a second.

In one terminal:

```bash
kubectl get hpa autoscale -w
```

In another:

```bash
kubectl apply -f load.yaml
watch kubectl top pods -l app=autoscale
```

Over 2–3 minutes you'll see utilisation spike (well over 100%, since it's relative to the
100m request) and replicas climb to around 8. Then check the reasoning:

```bash
kubectl describe hpa autoscale | tail -15
```

## 4. Remove load

```bash
kubectl delete -f load.yaml
```

With `stabilizationWindowSeconds: 30` it scales back to 1 within about a minute. The default
is 5 minutes, to avoid flapping. Tuning `behavior` (how fast to scale up and down) is most of
the real-world HPA work.

## Things to know for production

- The HPA owns `spec.replicas`. **Remove `replicas` from your Deployment YAML** (or Helm
  values) once an HPA manages it. Otherwise every `kubectl apply` resets the count.
- CPU is a lagging, indirect signal. For web services, requests-per-second or latency
  (custom metrics via Prometheus Adapter), or queue depth (KEDA), often work better.
- Scale-out takes time: metrics scrape (~15s) + HPA loop (15s) + pod startup + readiness.
  Add node provisioning if the cluster is full. Keep some headroom.

## Challenge

1. Add a second metric to the HPA: memory at 70% average utilisation. With multiple metrics,
   the HPA picks the one that yields the *most* replicas.
2. Limit scale-up to at most 2 pods per 30 seconds with `behavior.scaleUp.policies`, then
   rerun the load test and compare.
3. Set `maxReplicas: 20` and scale the load generator to 4 replicas. Do all the pods fit on
   the nodes? What would happen on EKS with Karpenter?

## Clean up

```bash
kubectl delete -f . --ignore-not-found
```
