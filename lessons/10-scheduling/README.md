# 10 — Scheduling: where pods run

For each new pod, the scheduler **filters** out nodes that can't run it (not enough
unreserved CPU/memory, taints, affinity rules) and then **scores** the rest (spreading,
bin-packing, image locality). You influence it with:

| Tool | Effect | AWS analogy |
|---|---|---|
| `resources.requests` | must fit in the node's unreserved capacity | ECS task CPU/memory reservation |
| `nodeSelector` / node affinity | *attract* pods to labelled nodes | ECS placement constraints |
| pod (anti-)affinity | co-locate with / keep away from other pods | ECS `distinctInstance` |
| `topologySpreadConstraints` | spread evenly over zones/nodes | ASG AZ balancing, ECS spread strategy |
| taints + tolerations | nodes *repel* pods unless tolerated | dedicated hosts / capacity reservations |
| cordon / drain + PDB | take nodes out of service safely | ASG instance refresh with min healthy % |

Our workers are labelled `zone=zone-a` and `zone=zone-b` (see
[cluster/kind-config.yaml](../../cluster/kind-config.yaml)). Real clusters use the
well-known label `topology.kubernetes.io/zone`, which EKS sets automatically.

`cd lessons/10-scheduling`

```bash
kubectl get nodes -L zone
kubectl describe node lab-control-plane | grep Taints   # why your pods never land there
```

## 1. nodeSelector

```bash
kubectl apply -f pinned.yaml
kubectl get pod pinned -o wide      # always lab-worker2 (zone-b)
```

Change `zone-b` to `zone-c` in a copy and apply it. The pod stays `Pending`. Read
`kubectl describe pod` to see the scheduler's reasoning. That `Events` section is where
every "why is my pod Pending" investigation starts.

## 2. Spread across zones

Read [spread.yaml](spread.yaml):

```bash
kubectl apply -f spread.yaml
kubectl get pods -l app=spread -o wide
kubectl scale deploy/spread --replicas=5
kubectl get pods -l app=spread -o wide --no-headers | awk '{print $7}' | sort | uniq -c   # 3/2 at most (maxSkew 1)
kubectl scale deploy/spread --replicas=4
```

## 3. Taints and tolerations

Dedicate `lab-worker` to "GPU" work:

```bash
kubectl taint nodes lab-worker dedicated=gpu:NoSchedule
kubectl rollout restart deploy/spread
kubectl get pods -l app=spread -o wide
```

Some `spread` pods are stuck `Pending`. Why? `kubectl describe` one of them. Two rules
collide: the taint keeps them off zone-a, and `whenUnsatisfiable: DoNotSchedule` won't let
zone-b get more than 1 ahead. Hard constraints can leave pods unschedulable, which is
why `ScheduleAnyway` (a soft preference) is common.

Now a workload that *tolerates* the taint. Read [gpu-workload.yaml](gpu-workload.yaml):

```bash
kubectl apply -f gpu-workload.yaml
kubectl get pod gpu-job -o wide     # lands on lab-worker
kubectl taint nodes lab-worker dedicated=gpu:NoSchedule-   # the trailing "-" removes the taint
kubectl get pods -l app=spread -o wide                     # pending pods schedule now
kubectl delete pod gpu-job pinned
```

On EKS, this is how GPU node groups, Spot-only pools and system node groups are kept separate.

## 4. Drain a node safely

Node maintenance (AMI upgrades, instance refresh, Karpenter consolidation) works by
**cordoning** (no new pods) and **draining** (evicting existing pods). A
**PodDisruptionBudget** stops a drain from taking out too many replicas at once.

Read [pdb.yaml](pdb.yaml): at least 3 of the 4 `spread` pods must stay up.

```bash
kubectl apply -f pdb.yaml
kubectl get pdb            # ALLOWED DISRUPTIONS: 1

kubectl drain lab-worker --ignore-daemonsets --delete-emptydir-data
kubectl get nodes          # lab-worker: SchedulingDisabled
kubectl get pods -l app=spread -o wide
```

The evicted pod's replacement is `Pending`, because the spread constraint won't pile
everything onto zone-b. Now try draining the other worker:

```bash
kubectl drain lab-worker2 --ignore-daemonsets --delete-emptydir-data --timeout=30s
```

It keeps retrying with `Cannot evict pod as it would violate the pod's disruption budget`
until it times out. The PDB protected your availability. An unconstrained drain would have
taken the app down completely. Undo:

```bash
kubectl uncordon lab-worker lab-worker2
kubectl get pods -l app=spread -o wide
```

> PDBs only guard *voluntary* disruptions (evictions). A node that crashes doesn't ask
> permission. That's why you also spread across zones.

## Challenge

1. Replace the topology spread in `spread.yaml` with **pod anti-affinity** so that no two
   `spread` pods share a node (`topologyKey: kubernetes.io/hostname`). Scale to 3 replicas.
   What happens to the third one, and why?
2. Change `DoNotSchedule` to `ScheduleAnyway` and repeat the taint experiment. Any pending pods now?
3. Create a PDB with `maxUnavailable: 0` and try to drain. Why is that a bad idea in real
   clusters? (Hint: think about what your platform team's node upgrades will do.)

## Clean up

```bash
kubectl delete -f . --ignore-not-found
kubectl uncordon lab-worker lab-worker2
```
