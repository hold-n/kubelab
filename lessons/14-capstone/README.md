# 14 — Capstone: ship a production-shaped service

Until now every lesson handed you manifests to read. This time you get requirements, the
way a ticket would, and write the manifests yourself. Referring back to earlier lessons is
expected; copying them wholesale mostly teaches you how to copy. A reference solution is in
[solution/](solution/). Try not to look until `verify.sh` passes or you're truly stuck.

**Prerequisites:** metrics-server (lesson 08), and Envoy Gateway plus the `envoy`
GatewayClass (lesson 09). Check with:

```bash
kubectl top nodes && kubectl get gatewayclass envoy
```

If `kubectl top` says `Metrics API not available` or the GatewayClass is missing, go back
and run the install steps from those lessons.

## The system

```
            client (curl from the orb)
                     │ HTTP :80
                     ▼
        Gateway "capstone" (class: envoy)
                     │ HTTPRoute  /  →  Service web
                     ▼
   Deployment web (kubelab/app, 3–6 replicas, HPA)
                     │ REDIS_HOST
                     ▼
     StatefulSet redis (1 replica, PVC)
```

The app increments a `visits` counter in Redis on every `GET /` once `REDIS_HOST` is set
(see the docstring in [app/server.py](../../app/server.py)).

## Requirements

Put your manifests in `lessons/14-capstone/mine/` (or build a Helm chart; see the stretch
goals). Give every object `namespace: capstone` in its metadata, so `kubectl apply -f mine/`
puts it in the right place no matter what your current namespace is.

1. Everything lives in namespace **`capstone`**, which has a **ResourceQuota** limiting
   total CPU and memory requests.
2. **Redis** runs as a StatefulSet named `redis` (`redis:8-alpine`, with `--appendonly yes`),
   behind a headless Service `redis`, storing `/data` on a PVC via `volumeClaimTemplates`.
   Its data must survive the pod being deleted.
3. The **app** is a Deployment named `web` with label `app: web`, image `kubelab/app:v1`:
   - `GREETING` and `REDIS_HOST` come from a **ConfigMap**
   - readiness **and** liveness probes
   - CPU and memory requests, and a memory limit, on every container (Redis's too)
   - pods spread across both worker nodes
4. A **Service** `web`, and a **Gateway** + **HTTPRoute** in `capstone` routing `/` to it.
   `curl http://<gateway-ip>/` returns JSON with an incrementing `visits` count.
5. A **PodDisruptionBudget** keeps at least 2 `web` pods during voluntary disruptions.
6. An **HPA** scales `web` between 3 and 6 replicas on CPU.
7. **Zero-downtime rollouts:** a rolling restart of `web` under continuous traffic must not
   fail a single request. (Hint: probes, rollout strategy, and lesson 05 Part C.)

Requirement 7 is the hard one. A naive Deployment passes everything else, then drops a few
requests on every deploy: in production, the steady trickle of 502s nobody can explain.

## Grade yourself

```bash
cd lessons/14-capstone
kubectl apply -f mine/
./verify.sh
```

`verify.sh` checks the structure, sends traffic through the Gateway, deletes `redis-0` to
test persistence, then does a rolling restart of `web` while firing requests at it,
counting every non-200. It takes under a minute; run it as often as you like.

## Stretch goals

- **Helm:** package your solution as a chart with an `environment` value that changes
  replica counts and resources. Install it as a release, `helm upgrade` it to `kubelab/app:v2`
  under load (watch for failed requests), then `helm rollback`.
- **Canary:** run v1 and v2 side by side and use HTTPRoute weights to move traffic 90/10 → 50/50 → 0/100.
- **Security hardening:** add a `securityContext` (`runAsNonRoot: true`,
  `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, drop all capabilities),
  and label the namespace to enforce the **restricted** Pod Security Standard:
  `kubectl label ns capstone pod-security.kubernetes.io/enforce=restricted`. What breaks, and why?
- **NetworkPolicy:** only `web` pods may connect to Redis on 6379. Prove it by
  trying from another pod.
- **Chaos:** while `verify.sh` runs, `kubectl drain` a worker. Does everything hold? What does the PDB do?

## Clean up

```bash
kubectl delete namespace capstone
```
