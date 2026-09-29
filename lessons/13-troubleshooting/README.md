# 13 — Troubleshooting drills

Ten broken scenarios, each in its own namespace. Diagnose it, fix it in the cluster, and
let the script grade you. Don't read the YAML in `drills/` first. Investigate the way you
would in a real incident.

```bash
cd lessons/13-troubleshooting
./drill.sh list
./drill.sh start 1
# ...investigate and fix...
./drill.sh check 1
./drill.sh reset 1     # start over if you make a mess
```

Tip: `kubectl config set-context --current --namespace=drill-01` saves typing `-n` everywhere.

## The debugging playbook

Work from the outside in, and let the cluster tell you what's wrong:

```
kubectl get pods                    What state? Pending / ImagePullBackOff / CrashLoopBackOff /
                                    CreateContainerConfigError / Running-but-0/1 / OOMKilled
    │
    ├─ kubectl describe pod <p>     Events at the bottom: scheduling, image pulls, probe
    │                               failures, mount errors, OOM kills. The answer is often here.
    ├─ kubectl logs <p> [--previous]  What did the app say before it died?
    ├─ kubectl get events --sort-by=.lastTimestamp
    ├─ kubectl get endpointslices -l kubernetes.io/service-name=<svc>
    │                               Does the Service actually have (ready) backends?
    ├─ kubectl exec / kubectl debug   Test from inside: curl, nslookup, env, files
    └─ kubectl auth can-i ... --as=system:serviceaccount:<ns>:<sa>
```

| Symptom | Usual suspects |
|---|---|
| `Pending` | requests too big, nodeSelector/affinity match nothing, taints, PVC not bound, quota |
| `ImagePullBackOff` / `ErrImagePull` | wrong image/tag, private registry without credentials |
| `CrashLoopBackOff` | app exits: bad command, missing config, can't reach a dependency; check `--previous` logs |
| `CreateContainerConfigError` | referenced ConfigMap/Secret (or a key in it) doesn't exist |
| `Running` but `0/1` | readiness probe failing: wrong path/port, app not actually ready |
| `OOMKilled` (exit 137) | memory limit too low, or a real leak |
| Service unreachable | selector doesn't match pod labels, wrong `targetPort`, NetworkPolicy |
| `Forbidden` from the API | RBAC: missing or misspelled resource/verb/apiGroup, wrong namespace |

Fix things **declaratively** where you can: `kubectl edit`, `kubectl patch`, or
`kubectl get -o yaml > x.yaml` → edit → `kubectl apply -f x.yaml`. Some fields are
immutable, so you'll have to delete and recreate the object. You'll hit one in these drills.

When you're done, or stuck, see [SOLUTIONS.md](SOLUTIONS.md).

## Clean up

```bash
for i in $(seq -w 1 10); do kubectl delete namespace drill-$i --ignore-not-found --wait=false; done
kubectl config set-context --current --namespace=default
```
