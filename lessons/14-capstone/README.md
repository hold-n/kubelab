# 14 — Capstone: ship a production-shaped service

Build this yourself from the requirements, without copying from earlier lessons wholesale
(referring back is fine). A reference solution is in [solution/](solution/). Try not to
look until `verify.sh` passes or you're truly stuck.

**Prerequisites:** metrics-server (lesson 08), and Envoy Gateway plus the `envoy`
GatewayClass (lesson 09). Check with:

```bash
kubectl top nodes && kubectl get gatewayclass envoy
```

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

## Requirements

Put your manifests in `lessons/14-capstone/mine/` (or build a Helm chart, see the stretch goals).

1. Everything lives in namespace **`capstone`**, which has a **ResourceQuota** limiting
   total CPU/memory requests.
2. **Redis** runs as a StatefulSet named `redis` (`redis:8-alpine`, with `--appendonly yes`),
   behind a headless Service `redis`, storing `/data` on a PVC via `volumeClaimTemplates`.
   Its data must survive the pod being deleted.
3. The **app** is a Deployment named `web` with label `app: web`, image `kubelab/app:v1`:
   - `GREETING` and `REDIS_HOST` come from a **ConfigMap**
   - readiness **and** liveness probes
   - CPU and memory requests, and a memory limit, on every container
   - pods spread across both worker nodes
4. A **Service** `web`, and a **Gateway** + **HTTPRoute** in `capstone` routing `/` to it.
   `curl http://<gateway-ip>/` returns JSON with an incrementing `visits` count.
5. A **PodDisruptionBudget** keeps at least 2 `web` pods during voluntary disruptions.
6. An **HPA** scales `web` between 3 and 6 replicas on CPU.
7. **Zero-downtime rollouts:** a rolling restart of `web` under continuous traffic must not
   fail a single request. (Hint: probes, rollout strategy, and lesson 05 Part C.)

## Grade yourself

```bash
cd lessons/14-capstone
kubectl apply -f mine/
./verify.sh
```

`verify.sh` checks the structure, sends traffic through the Gateway, deletes `redis-0` to
test persistence, and does a rolling restart under load while counting failures.

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
