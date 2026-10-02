# 02 — Deployments: self-healing, scaling, rolling updates

A bare pod that dies stays dead, and changing one means replacing it (lesson 01). A
**Deployment** handles both. It manages **ReplicaSets**, which manage **Pods**:

```
Deployment web  (strategy, revision history)
  └─ ReplicaSet web-7c4c44fcd7   (one per pod-template version; keeps N copies)
       ├─ Pod web-7c4c44fcd7-4phlz
       ├─ Pod web-7c4c44fcd7-5dqt5
       └─ Pod web-7c4c44fcd7-f7gqv
```

The ReplicaSet is the ASG (keep N copies of one template); the Deployment is the ECS service
or CodeDeploy on top (move from one version to the next). Why two layers? During a rollout,
old and new versions run side by side, each with its own count. One ReplicaSet per template
(`7c4c44fcd7` is a hash of it) turns a rollout into "scale new up, old down".

The glue is **labels and selectors**: a Deployment keeps no list of pods, it owns whatever
matches `spec.selector` right now.

`cd lessons/02-deployments` and keep `kubectl get pods -o wide -w` running in a second terminal.

## 1. Deploy

Read [deployment.yaml](deployment.yaml), then:

```bash
kubectl apply -f deployment.yaml
kubectl rollout status deploy/web
kubectl get deploy,rs,pods -l app=web -o wide
```

The scheduler spreads the pods across both workers (by preference, not promise), and each
pod is named `<replicaset>-<random>`.

## 2. Self-healing

```bash
kubectl delete pod -l app=web --wait=false   # delete ALL of them
kubectl get pods -l app=web
```

Three new pods are `ContainerCreating` while the old three are still `Terminating`. The
ReplicaSet doesn't count terminating pods, so it saw 0 of 3 and replaced them at once.

Now a harder failure: a whole node dies. Kind nodes are containers, so stop one:

```bash
docker stop lab-worker2
kubectl get nodes -w          # after ~a minute: NotReady (Ctrl-C to stop watching)
```

In your watch terminal, the pods on `lab-worker2` still say `Running` (their kubelet's last
report), but `0/1` ready. They aren't replaced: a dead node and a network partition look
identical from outside, and replacing pods that may still be running risks two copies of
something meant to be one. So the node gets a `node.kubernetes.io/unreachable` taint, pods
tolerate it for 300s by default, and only then are they evicted and recreated. Skip the wait:

```bash
docker start lab-worker2
kubectl get nodes
```

## 3. Scale

```bash
kubectl scale deploy/web --replicas=6
kubectl get pods -l app=web
kubectl scale deploy/web --replicas=3
```

Imperative `scale` is fine for experiments, but the next `kubectl apply` resets `replicas`
to whatever the file says. (In lesson 12 an autoscaler takes over this field.)

## 4. Rolling update

Keep the watch terminal visible, then:

```bash
kubectl set image deploy/web app=kubelab/app:v2
kubectl annotate deploy/web kubernetes.io/change-cause="upgrade to v2"
kubectl rollout status deploy/web
```

With `maxSurge: 1, maxUnavailable: 0`, Kubernetes adds one v2 pod, waits until it's
**ready**, removes one v1 pod, and repeats: never fewer than 3 ready pods, never more than 4
in total. Now look at what's left behind:

```bash
kubectl get rs -l app=web      # old RS scaled to 0 but kept, for rollback
kubectl rollout history deploy/web
kubectl exec deploy/web -- curl -s localhost:8080/ | grep version
```

The old ReplicaSet is the rollback plan (`revisionHistoryLimit`, default 10, caps how many
are kept). `CHANGE-CAUSE` is copied from the annotation when each revision is created, and
nothing updates it for you: annotate every release or the history lies.

> In real life you'd edit the image tag in `deployment.yaml` and `kubectl apply`, so git stays
> the source of truth. `set image` keeps the lesson moving.

## 5. A bad release, and a rollback

```bash
kubectl set image deploy/web app=kubelab/app:v3   # this image doesn't exist
kubectl annotate deploy/web kubernetes.io/change-cause="v3 (broken)" --overwrite
kubectl get pods -l app=web
```

The new pod is stuck in `ErrImageNeverPull` (with a real registry instead of
`imagePullPolicy: Never`: `ErrImagePull`, then `ImagePullBackOff`). Since
`maxUnavailable: 0`, **all three v2 pods keep serving**. The rollout just stalls:

```bash
kubectl rollout status deploy/web --timeout=10s
kubectl describe deploy web | grep -A5 Conditions
```

`rollout status` exits non-zero, which is what a deploy pipeline checks. The Deployment
still says `Progressing True`; only after `progressDeadlineSeconds` (default 600s) does it
flip to `False` (`ProgressDeadlineExceeded`). It never rolls back on its own. That's your
pipeline's job, or a tool like Argo Rollouts or Flagger. Roll back by hand:

```bash
kubectl rollout undo deploy/web
kubectl rollout status deploy/web
kubectl rollout history deploy/web
```

Revision 2 became revision 4: rollback re-applies an old template as a new revision. The
`last-applied-configuration` warning means the cluster now disagrees with your YAML, and
the next `kubectl apply` wins. After a real rollback, fix the file in git too.

## 6. Labels are the glue

```bash
POD=$(kubectl get pod -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl label pod $POD app=quarantine --overwrite
kubectl get pods -L app
```

The relabelled pod no longer matches, so the ReplicaSet sees 2 of 3 and makes a replacement.
The old pod keeps running, orphaned. That's a real debugging technique: pull a misbehaving
pod out of rotation (Services select by label too) but keep it alive to poke at. Clean up:

```bash
kubectl delete pod -l app=quarantine
```

## Challenge

1. Change the strategy to `maxSurge: 0, maxUnavailable: 1`, apply, then roll to `v2` and back.
   How does the rollout differ? When would you want each setting?
2. Try `strategy: { type: Recreate }`. What happens during an update, and why would anyone
   choose that? (Hint: think about schema migrations or a single-writer volume.)
3. Edit the file, then preview the change with `kubectl diff -f deployment.yaml` before applying.

<details><summary>Hints and answers</summary>

1. Old pods die first, then new ones start: capacity dips to 2 of 3, but no room is needed
   for an extra pod. Use it when the cluster is full or each pod holds something exclusive
   (a host port, a licence). Surge-first is the safe default for serving traffic. (Applying
   the file also resets the image to `v1`, since that's what the file says.)
2. Delete the `rollingUpdate:` block too, or the API rejects the change. Recreate kills every
   old pod before starting new ones: guaranteed downtime, but v1 and v2 never run at once.
   You want that when they can't coexist: an incompatible schema migration, or a volume only
   one writer may use.
3. `kubectl diff` shows live vs. file and exits 1 if they differ. It also exposes drift: after
   `set image`, the diff shows the file would move the image back to `v1`.
</details>

## Clean up

```bash
kubectl delete -f deployment.yaml
```
