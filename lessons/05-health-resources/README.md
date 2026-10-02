# 05 — Health checks, resources, and graceful shutdown

"Running" tells Kubernetes little: the process could be booting, deadlocked, or about to eat
the node's memory. The cluster needs to know when your app is ready, when it's broken, and how
much it needs.

`cd lessons/05-health-resources`

## Part A: probes

The kubelet polls each container with up to three probes:

| Probe | Question | On failure | AWS analogy |
|---|---|---|---|
| `startupProbe` | "Have you finished starting?" | Other probes wait; restart if it never passes | health check grace period |
| `readinessProbe` | "Should you get traffic *right now*?" | Removed from Service endpoints (not restarted) | ALB target health check |
| `livenessProbe` | "Are you wedged beyond recovery?" | Container is killed and restarted in place | ECS/ASG health check replacement |

Read [probes.yaml](probes.yaml). The app sets `STARTUP_DELAY=15`, so `/readyz` fails for
15 seconds. (The startup probe checks `/healthz`, which passes at once, so it only shows the
syntax. Its real job is shielding slow starters from liveness.)

In a second terminal:

```bash
kubectl get pods -l app=probes -w
```

```bash
kubectl apply -f probes.yaml
kubectl get endpointslices -l kubernetes.io/service-name=probes -o yaml | grep -B2 -A3 conditions
```

Pods are `Running` but `0/1` READY for about 15s. They're in the EndpointSlice with
`ready: false`, so the Service knows about them but sends them nothing.

### Readiness: take a pod out of rotation

```bash
POD=$(kubectl get pod -l app=probes -o jsonpath='{.items[0].metadata.name}')
kubectl exec $POD -- curl -s localhost:8080/unready
kubectl get pods -l app=probes                # that pod goes 0/1, but RESTARTS stays 0
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c 'for i in $(seq 6); do curl -s probes/ | grep "\"pod\""; done'   # only the other pod answers
kubectl exec $POD -- curl -s localhost:8080/ready
```

Use readiness for temporary conditions like warming caches, a dependency being down, or overload.

### Liveness: restart a wedged process

```bash
kubectl exec $POD -- curl -s localhost:8080/break   # /healthz now returns 500 forever
kubectl get pods -l app=probes -w                   # ~10s later RESTARTS goes to 1 (Ctrl-C)
kubectl describe pod $POD | tail -8                 # "Container app failed liveness probe, will be restarted"
```

~10s is `periodSeconds: 3` × `failureThreshold: 3`. Only the container is replaced; the pod
keeps its name and IP.

> ⚠️ **Never make liveness depend on anything outside the process.** Suppose liveness checks
> the database and the database dies at 3am. Every pod restarts, then restarts again, and the
> herd stampedes the database the moment it returns. Liveness should only ask "is *this
> process* broken in a way a restart fixes?"

### Crash loops

```bash
kubectl exec $POD -- curl -s localhost:8080/exit
kubectl exec $POD -- curl -s localhost:8080/exit   # wait for it to come back first, then repeat a few times
kubectl get pods -l app=probes                     # CrashLoopBackOff appears between restarts
```

`CrashLoopBackOff` isn't an error in itself. It means the kubelet is waiting before it
restarts again (10s, 20s, 40s… up to 5 min). The cause is in the dead container's logs:
`kubectl logs <pod>` during the back-off, or `kubectl logs <pod> --previous` once a new
container is running.

## Part B: requests and limits

```
requests → what the scheduler reserves on a node   (used for placement/bin-packing)
limits   → hard cap enforced by the kernel         (cpu: throttled, memory: OOM-killed)
```

Read [resources.yaml](resources.yaml), then:

```bash
kubectl apply -f resources.yaml
kubectl get pod hungry -o jsonpath='{.status.qosClass}{"\n"}'     # Burstable (see QoS below)
kubectl describe node $(kubectl get pod hungry -o jsonpath='{.spec.nodeName}') | sed -n '/Allocated resources/,/Events/p'
```

Limits on a node can sum past 100%: they're ceilings, not reservations.

### Exceed the memory limit

```bash
kubectl exec hungry -- curl -s 'localhost:8080/leak?mb=50'    # fine: ~65 MiB total
kubectl exec hungry -- curl -s 'localhost:8080/leak?mb=100'   # over 128Mi: "command terminated with exit code 137"
kubectl get pod hungry                                         # RESTARTS 1
kubectl get pod hungry -o jsonpath='{.status.containerStatuses[0].lastState.terminated}{"\n"}'
```

Exit code 137 = 128 + SIGKILL. The kernel's OOM killer took out the whole container, your
`curl` included, with no warning and no graceful shutdown.

The reason is normally `OOMKilled`, but in this lab expect `Error`. Same kill, different
bookkeeping: the pod-level cap (sum of limits, plus the tiny `pause` container) trips a hair
before the container's own, and the runtime only labels the latter as OOM. The node's kernel
log confirms it:

```bash
docker exec $(kubectl get pod hungry -o jsonpath='{.spec.nodeName}') dmesg | grep -i 'out of memory' | tail -2
```

### Exceed the CPU limit

CPU is *compressible*: going over the limit just throttles you.

```bash
kubectl exec hungry -- curl -s 'localhost:8080/burn?seconds=60'
sleep 20; kubectl exec hungry -- grep throttled /sys/fs/cgroup/cpu.stat
kubectl top pod hungry          # (needs metrics-server, installed in lesson 08 - skip if not yet)
```

The app wants a whole core; the 500m limit gives it half of every 100ms. `nr_throttled`
climbs, `top` sits near `500m`, nothing dies. In production, throttling looks like latency.

### QoS classes

| Class | When | Evicted under node memory pressure |
|---|---|---|
| `Guaranteed` | every container has requests == limits for cpu and memory | last |
| `Burstable` | anything in between | middle |
| `BestEffort` | no requests or limits at all | first |

A common production baseline: memory request = memory limit, since memory can't
be taken back without killing. Always set CPU requests. Many teams leave CPU limits off to
avoid throttling, but opinions differ.

## Part C: graceful shutdown

When a pod is deleted (rollout, scale-down, drain), two tracks start at once:

```
network:  pod marked Terminating → removed from EndpointSlices → kube-proxy/LBs update (~1-2s)
kubelet:  preStop hook (if any) → SIGTERM → SIGKILL once terminationGracePeriodSeconds
          (default 30s, counted from the start) runs out
```

Neither waits for the other, so a pod can get SIGTERM while clients still route to it. Hence
the short `preStop` sleep in most production apps (`lifecycle: {preStop: {sleep: {seconds: 5}}}`):
keep serving while the network catches up. You'll need it in the capstone to get zero failed
requests during a rollout.

```bash
kubectl logs -f $POD &
kubectl delete pod $POD
# "SIGTERM received, shutting down gracefully" then "bye"; the log stream then ends
```

An app that ignored SIGTERM would hang for the full grace period (10s here), then get SIGKILL.

## Challenge

1. Make the startup probe fail: set `STARTUP_DELAY` to a large value and point the
   `startupProbe` at `/readyz` with `failureThreshold: 5`. What happens, and after how long?
2. Create a pod with **no** resources and check its QoS class. Then one with requests == limits.
3. Request more memory than any node has (e.g. `requests.memory: 64Gi`). What's the pod's
   status and what does `kubectl describe` say? (This is the #1 cause of `Pending` pods.)

<details><summary>Answers</summary>

1. After 5 × 2s ≈ 10s the container is killed ("Startup probe failed"), restarts, fails again,
   and settles into `CrashLoopBackOff`.
2. `BestEffort`, then `Guaranteed`. (Limits alone also give `Guaranteed`: requests default to limits.)
3. `Pending`, with `FailedScheduling ... 2 Insufficient memory` (the third node is the tainted
   control plane, lesson 10). The scheduler compares requests with unreserved capacity, not usage.
</details>

## Clean up

```bash
kubectl delete -f .
```
