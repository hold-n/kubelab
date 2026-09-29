# 02 — Deployments: self-healing, scaling, rolling updates

A **Deployment** manages a **ReplicaSet**, which manages **Pods**:

```
Deployment web  (strategy, revision history)
  └─ ReplicaSet web-7c4c44fcd7   (one per pod-template version; keeps N copies)
       ├─ Pod web-7c4c44fcd7-4phlz
       ├─ Pod web-7c4c44fcd7-5dqt5
       └─ Pod web-7c4c44fcd7-f7gqv
```

Loosely, the ReplicaSet is the ASG (keeps N running) and the Deployment is the ECS service
or CodeDeploy (manages the move from one version to the next). The link between them is
**labels and selectors**: the Deployment owns every pod whose labels match
`spec.selector`.

`cd lessons/02-deployments` and keep `kubectl get pods -o wide -w` running in a second terminal.

## 1. Deploy

Read [deployment.yaml](deployment.yaml), then:

```bash
kubectl apply -f deployment.yaml
kubectl rollout status deploy/web
kubectl get deploy,rs,pods -l app=web -o wide
```

Notice how the scheduler spread the pods across the two workers, and that pod names are
`<replicaset>-<random>`.

## 2. Self-healing

```bash
kubectl delete pod -l app=web --wait=false   # delete ALL of them
kubectl get pods -l app=web
```

The ReplicaSet controller saw 0 of 3 and created replacements immediately. Now simulate a
node failure. Kind nodes are containers, so stop one:

```bash
docker stop lab-worker2
kubectl get nodes -w          # after a minute or so: NotReady (Ctrl-C to stop watching)
```

Pods on a `NotReady` node are evicted after a timeout (5 min by default, via the
`node.kubernetes.io/unreachable` taint with `tolerationSeconds: 300`), then recreated elsewhere.
Don't wait for it, just bring the node back:

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

Imperative `scale` is fine for experiments, but the source of truth should be the YAML.
Otherwise your next `kubectl apply` resets it. (In lesson 12, an autoscaler takes over this field.)

## 4. Rolling update

Keep the watch terminal visible, then:

```bash
kubectl set image deploy/web app=kubelab/app:v2
kubectl annotate deploy/web kubernetes.io/change-cause="upgrade to v2"
kubectl rollout status deploy/web
```

With `maxSurge: 1, maxUnavailable: 0`, Kubernetes adds one v2 pod, waits until it's
**ready**, removes one v1 pod, and repeats. Look at the ReplicaSets:

```bash
kubectl get rs -l app=web      # old RS scaled to 0 but kept, for rollback
kubectl rollout history deploy/web
kubectl exec deploy/web -- curl -s localhost:8080/ | grep version
```

> In real life you'd edit the image tag in `deployment.yaml` and `kubectl apply`, so git stays
> the source of truth. `set image` is used here to keep the lesson moving.

## 5. A bad release, and a rollback

```bash
kubectl set image deploy/web app=kubelab/app:v3   # this image doesn't exist
kubectl get pods -l app=web
```

The new pod is stuck in `ErrImageNeverPull`. We set `imagePullPolicy: Never`, and with a
registry you'd see `ErrImagePull` / `ImagePullBackOff` instead. Because `maxUnavailable: 0`,
**all three v2 pods keep serving**. The rollout just stalls:

```bash
kubectl rollout status deploy/web --timeout=10s
kubectl describe deploy web | grep -A5 Conditions
```

After `progressDeadlineSeconds` (default 600s) the Deployment is marked
`Progressing=False`. It does **not** roll back on its own. That's your pipeline's job (or a
progressive-delivery tool like Argo Rollouts or Flagger). Roll back manually:

```bash
kubectl rollout undo deploy/web
kubectl rollout status deploy/web
kubectl rollout history deploy/web
```

## 6. Labels are the glue

```bash
POD=$(kubectl get pod -l app=web -o jsonpath='{.items[0].metadata.name}')
kubectl label pod $POD app=quarantine --overwrite
kubectl get pods -L app
```

The relabelled pod no longer matches the selector, so the ReplicaSet created a replacement.
The old pod keeps running, orphaned. That's a real debugging technique: pull a misbehaving
pod out of rotation and keep it around for inspection. Clean it up:
`kubectl delete pod -l app=quarantine`.

## Challenge

1. Change the strategy to `maxSurge: 0, maxUnavailable: 1`, apply, then roll to `v2` and back.
   How does the rollout differ? When would you want each setting?
2. Try `strategy: { type: Recreate }`. What happens during an update, and why would anyone
   choose that? (Hint: think about schema migrations or a single-writer volume.)
3. Use `kubectl diff -f deployment.yaml` after editing the file to preview a change before applying.

## Clean up

```bash
kubectl delete -f deployment.yaml
```
