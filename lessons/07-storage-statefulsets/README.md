# 07 — Storage and StatefulSets

So far every pod has been disposable. A database isn't: a container's filesystem dies with
the container, and an `emptyDir` with the pod. Data that must outlive a pod needs a
**persistent volume**:

```
PersistentVolumeClaim (PVC)   "I need 1Gi, ReadWriteOnce"          ← you write this
        │ bound to
PersistentVolume (PV)         an actual disk                       ← created on demand
        ▲ provisioned by
StorageClass                  "how to make disks" (driver + params) ← platform team
```

The split keeps app manifests cloud-agnostic: you ask for "1Gi"; the cluster decides what a
disk is. On EKS you'd typically use a `gp3` StorageClass backed by the EBS CSI driver: a PVC
becomes an EBS volume that can follow the pod between nodes *in the same AZ*. In this lab,
kind's `local-path` provisioner creates a directory on a node.

`cd lessons/07-storage-statefulsets`

## 1. A PVC and a pod

```bash
kubectl get storageclass            # "standard (default)", VOLUMEBINDINGMODE WaitForFirstConsumer
```

Read [pvc.yaml](pvc.yaml). The pod appends a timestamp to a file on the volume each time it starts.

```bash
kubectl apply -f pvc.yaml
kubectl get pvc,pv
kubectl logs writer
```

If you're quick, the PVC is still `Pending` with no PV. That's `WaitForFirstConsumer`: the
volume isn't created until a pod using it is scheduled, so the disk lands where the pod is.
(With EBS, a volume created eagerly in the wrong AZ would make the pod unschedulable.) Seconds
later it's `Bound`.

Delete the pod and recreate it. The data survives:

```bash
kubectl delete pod writer
kubectl apply -f pvc.yaml
kubectl logs writer          # two timestamps
```

Where does it physically live?

```bash
kubectl get pv -o custom-columns=NAME:.metadata.name,CLAIM:.spec.claimRef.name,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0],PATH:.spec.hostPath.path
NODE=$(kubectl get pod writer -o jsonpath='{.spec.nodeName}')
docker exec $NODE sh -c 'cat /var/local-path-provisioner/*_notes/log.txt'   # the file, read straight off the "disk"
```

Note the node affinity on the PV: pods using this volume can only run on that node, just as
an EBS-backed pod is pinned to one AZ.

## 2. StatefulSets

A Deployment's pods are interchangeable cattle with random names, and they all mount the
*same* PVC (with `ReadWriteOnce`, which means one *node*, they'd all have to share a node).
Databases, queues and consensus systems need:

- **stable identity**: `redis-0`, `redis-1`, … that keep their names across restarts
- **stable storage**: each replica gets *its own* PVC that follows it
- **ordered** startup, scaling and rolling updates
- **stable DNS** through a headless Service: `redis-0.redis.<ns>.svc.cluster.local`

That's a **StatefulSet**. Read [redis.yaml](redis.yaml), then:

```bash
kubectl apply -f redis.yaml
kubectl rollout status statefulset/redis   # "partitioned roll out complete" just means done
kubectl get pods,pvc -l app=redis          # pod redis-0, pvc data-redis-0
```

The PVC is named `<template>-<pod>`, which is how a recreated `redis-0` finds its old disk.

Point the app at it. Read [web.yaml](web.yaml):

```bash
kubectl apply -f web.yaml
kubectl rollout status deploy/web
for i in 1 2 3; do kubectl exec deploy/web -- curl -s localhost:8080/ | grep visits; done
```

Kill Redis. The same identity and the same disk come back:

```bash
kubectl delete pod redis-0
kubectl get pods -l app=redis -w       # recreated as redis-0 (Ctrl-C)
kubectl exec deploy/web -- curl -s localhost:8080/ | grep visits   # count continues
```

Scale it and watch the ordering:

```bash
kubectl scale statefulset redis --replicas=3
kubectl get pods -l app=redis -w       # redis-1 only starts after redis-0 is ready, then redis-2 (Ctrl-C)
kubectl get pvc                        # data-redis-1, data-redis-2
kubectl exec deploy/web -- python -c "import socket; print(socket.gethostbyname_ex('redis'))"
```

The headless Service has no virtual IP, so `redis` resolves to every pod's IP (try
`'redis-1.redis'` for just one). Now scale back down:

```bash
kubectl scale statefulset redis --replicas=1   # removes redis-2, then redis-1: reverse order
kubectl get pvc                        # PVCs are NOT deleted on scale-down - data safety first
```

A scale-down is a routine typo away; a deleted disk is forever. So a later scale-up gets the
old data back, and cleanup is your job.

> These three replicas are *independent* Redis servers, not a replicated cluster. A
> StatefulSet gives you identity and storage, and the database still has to handle
> replication. In practice you'd use an **operator** (lesson 15) or, on AWS, often just a
> managed service (ElastiCache/RDS). Running stateful systems on Kubernetes is very doable,
> but it's a real commitment.

## Challenge

1. Delete the StatefulSet (`kubectl delete sts redis`) but keep the PVC. Re-apply
   `redis.yaml`. Is the visit count still there? Why?
2. Try to increase the `notes` PVC to 2Gi with `kubectl edit pvc notes`. What error do you
   get? Look at `ALLOWVOLUMEEXPANSION` on the StorageClass. (EBS's gp3 class allows expansion.)
3. Clean up the orphaned `data-redis-1` and `data-redis-2` PVCs. Then think about
   `persistentVolumeClaimRetentionPolicy` in `kubectl explain statefulset.spec`: when would
   you want `whenScaled: Delete`?

<details><summary>Answers</summary>

1. Yes. Deleting a StatefulSet keeps its PVCs (`whenDeleted: Retain` is the default), and the
   new `redis-0` reattaches `data-redis-0` by name; Redis reloads its append-only file.
2. `...the storageclass that provisions the pvc must support resize`: `standard` has
   `ALLOWVOLUMEEXPANSION false`. (No class lets you shrink a PVC.)
3. `kubectl delete pvc data-redis-1 data-redis-2`. `whenScaled: Delete` suits data that's
   disposable or re-synced from peers when a member joins (caches, replicated databases),
   where stale disks only cost money.
</details>

## Clean up

```bash
kubectl delete -f .
kubectl delete pvc --all      # StatefulSet PVCs outlive the StatefulSet
```

The StorageClass's reclaim policy is `Delete`, so deleting a PVC deletes the PV and its data
too (on EKS, the EBS volume itself).
