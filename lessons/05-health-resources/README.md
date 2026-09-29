# 05 — Health checks, resources, and graceful shutdown

This lesson covers what makes a workload *production-worthy* on Kubernetes: the cluster
has to know when your app is ready, when it's broken, and how much it needs.

`cd lessons/05-health-resources`

## Part A: probes

| Probe | Question | On failure | AWS analogy |
|---|---|---|---|
| `startupProbe` | "Have you finished starting?" | Other probes wait; restart if it never passes | health check grace period |
| `readinessProbe` | "Should you get traffic *right now*?" | Removed from Service endpoints (not restarted) | ALB target health check |
| `livenessProbe` | "Are you wedged beyond recovery?" | Container is killed and restarted | ECS/ASG health check replacement |

Read [probes.yaml](probes.yaml). The app sets `STARTUP_DELAY=15`, so it isn't ready for
15 seconds.

In a second terminal:

```bash
kubectl get pods -l app=probes -w
```

```bash
kubectl apply -f probes.yaml
kubectl get endpointslices -l kubernetes.io/service-name=probes -o yaml | grep -B2 -A3 conditions
```

Pods are `Running` but `0/1` READY for about 15s. They're in the endpoint slice with
`ready: false`, so the Service doesn't send them traffic yet.

### Readiness: take a pod out of rotation

```bash
POD=$(kubectl get pod -l app=probes -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POD -- curl -s localhost:8080/unready
kubectl get pods -l app=probes                # that pod goes 0/1, but RESTARTS stays 0
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c 'for i in $(seq 6); do curl -s probes/ | grep "\"pod\""; done'   # only the other pod answers
kubectl exec $POD -- curl -s localhost:8080/ready
```

Use readiness for temporary conditions like warming caches, a downstream dependency being
down, or overload.

### Liveness: restart a wedged process

```bash
kubectl exec $POD -- curl -s localhost:8080/break   # /healthz now returns 500 forever
kubectl get pods -l app=probes -w                   # ~10s later RESTARTS increments
kubectl describe pod $POD | tail -8                 # "Liveness probe failed ... will be restarted"
```

> ⚠️ **Liveness pitfall:** never make liveness depend on external dependencies (DB, other
> services). If the DB goes down, every pod restarts in a loop and makes things worse.
> Liveness should only check "is this process fundamentally broken?"

### Crash loops

```bash
kubectl exec $POD -- curl -s localhost:8080/exit
kubectl exec $POD -- curl -s localhost:8080/exit   # wait for it to come back first, then repeat a few times
kubectl get pods -l app=probes                     # CrashLoopBackOff appears between restarts
```

`CrashLoopBackOff` isn't an error in itself. It means the kubelet is waiting before it
restarts again (10s, 20s, 40s… up to 5 min). Always check the logs of the dead container:
`kubectl logs <pod>` while it's waiting in back-off, or `kubectl logs <pod> --previous` once a
new container is running.

## Part B: requests and limits

```
requests → what the scheduler reserves on a node   (used for placement/bin-packing)
limits   → hard cap enforced by the kernel         (cpu: throttled, memory: OOMKilled)
```

Read [resources.yaml](resources.yaml), then:

```bash
kubectl apply -f resources.yaml
kubectl get pod hungry -o jsonpath='{.status.qosClass}{"\n"}'     # Burstable
kubectl describe node $(kubectl get pod hungry -o jsonpath='{.spec.nodeName}') | sed -n '/Allocated resources/,/Events/p'
```

### Exceed the memory limit

```bash
kubectl exec hungry -- curl -s 'localhost:8080/leak?mb=50'    # fine: ~70 MiB total
kubectl exec hungry -- curl -s 'localhost:8080/leak?mb=100'   # over 128Mi...
kubectl get pod hungry                                         # RESTARTS 1
kubectl get pod hungry -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}{"\n"}'
```

`OOMKilled`, exit code 137 (128 + SIGKILL). The kernel killed it without warning. There's
no graceful shutdown for OOM.

### Exceed the CPU limit

CPU is *compressible*: going over the limit just throttles you.

```bash
kubectl exec hungry -- curl -s 'localhost:8080/burn?seconds=60'
kubectl top pod hungry          # (needs metrics-server, installed in lesson 08 - skip if not yet)
```

It hovers around 500m (the limit), and the process isn't killed.

### QoS classes

| Class | When | Evicted under node memory pressure |
|---|---|---|
| `Guaranteed` | every container has requests == limits for cpu and memory | last |
| `Burstable` | some requests/limits set | middle |
| `BestEffort` | nothing set | first |

A common production baseline: always set memory request = memory limit (memory can't be
reclaimed without killing), and set CPU requests. Many teams leave CPU limits off to avoid
throttling, but opinions differ.

## Part C: graceful shutdown

When a pod is deleted (rollout, scale-down, drain), roughly the following happens *in parallel*:

```
1. Pod marked Terminating → removed from Service endpoints (propagates to kube-proxy/LBs over ~1-2s)
2. preStop hook runs (if any)
3. SIGTERM sent to the container
4. After terminationGracePeriodSeconds (default 30s): SIGKILL
```

Because 1 and 3 race, a pod can receive requests *after* SIGTERM. That's why production
apps usually add a short `preStop` sleep. You'll need it in the capstone to get zero failed
requests during a rollout.

```bash
kubectl logs -f $POD &
kubectl delete pod $POD
# "SIGTERM received, shutting down gracefully" then "bye"
kill %1
```

## Challenge

1. Make the startup probe fail: set `STARTUP_DELAY` to a large value and point the
   `startupProbe` at `/readyz` with `failureThreshold: 5`. What happens, and after how long?
2. Create a pod with **no** resources and check its QoS class. Then one with requests == limits.
3. Request more memory than any node has (e.g. `requests.memory: 64Gi`). What's the pod's
   status and what does `kubectl describe` say? (This is the #1 cause of `Pending` pods.)

## Clean up

```bash
kubectl delete -f .
```
