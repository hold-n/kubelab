# 13 — Troubleshooting drills

Ten broken scenarios, each in its own namespace. Your job: find what's wrong, fix it in the
cluster, and let the script grade you.

Don't read the YAML in `drills/` first. In a real incident nobody hands you the diff that
broke things; you get a symptom and a cluster. Practise that. (Reading the *live* objects
with `kubectl get deploy app -o yaml` is fair game. That's investigating, not cheating.)

```bash
cd lessons/13-troubleshooting
./drill.sh list
./drill.sh start 1
# ...investigate and fix...
./drill.sh check 1
./drill.sh reset 1     # start over if you make a mess
```

Each drill lives in namespace `drill-NN`. Make it your default so you can drop `-n`:
`kubectl config set-context --current --namespace=drill-01`.

## The debugging playbook

Work from the outside in. Kubernetes almost always knows what's wrong and has written it
down somewhere; your job is mostly knowing where to look.

```
kubectl get pods                    What state? Pending / ImagePullBackOff / CrashLoopBackOff /
                                    CreateContainerConfigError / Running-but-0/1
    │
    ├─ kubectl describe pod <p>     Events at the bottom: scheduling, image pulls, probe
    │                               failures, mount errors. The answer is usually here.
    ├─ kubectl logs <p> [--previous]  What did the app say before it died?
    ├─ kubectl get events --sort-by=.lastTimestamp
    ├─ kubectl get endpointslices -l kubernetes.io/service-name=<svc>
    │                               Does the Service actually have (ready) backends?
    ├─ kubectl exec / kubectl debug   Test from inside: curl, nslookup, env, files
    └─ kubectl auth can-i ... --as=system:serviceaccount:<ns>:<sa>
```

`describe` is the one people skip and shouldn't. A pod that never started has no logs, but
it has Events explaining why it never started.

| Symptom | Usual suspects |
|---|---|
| `Pending` | requests too big, nodeSelector/affinity match nothing, taints, PVC not bound, quota |
| `ImagePullBackOff` / `ErrImagePull` | wrong image/tag, private registry without credentials |
| `CrashLoopBackOff` | app exits: bad command, missing config, can't reach a dependency; check `--previous` logs |
| `CreateContainerConfigError` | referenced ConfigMap/Secret (or a key in it) doesn't exist |
| `Running` but `0/1` | readiness probe failing: wrong path/port, app not actually ready |
| Last state `OOMKilled`, or `Error` with exit code 137 | memory limit too low, or a real leak (137 = 128 + SIGKILL) |
| Service unreachable | selector doesn't match pod labels, wrong `targetPort`, NetworkPolicy |
| `Forbidden` from the API | RBAC: missing or misspelled resource/verb/apiGroup, wrong namespace |

About that OOM row: you'd hope a memory kill always says `OOMKilled`. In this lab it usually
says `Error` instead. The kernel enforces the limit on the pod's cgroup as well as the
container's, the pod-level one trips first, and the runtime only reports `OOMKilled` when it
sees the kill in the container's own cgroup. So treat exit code 137 plus a memory limit as
an OOM until proven otherwise.

Fix things **declaratively** where you can: `kubectl edit`, `kubectl patch`, `kubectl set`,
or `kubectl get -o yaml > x.yaml` → edit → `kubectl apply -f x.yaml`. Some fields are
immutable, and the API server will refuse to change them; the only way forward is to delete
the object and recreate it. You'll hit one of those.

When you're done, or stuck, see [SOLUTIONS.md](SOLUTIONS.md).

## Clean up

```bash
for i in $(seq -w 1 10); do kubectl delete namespace drill-$i --ignore-not-found --wait=false; done
kubectl config set-context --current --namespace=default
```
