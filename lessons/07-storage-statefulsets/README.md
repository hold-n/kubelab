# 07 — Storage and StatefulSets

Container filesystems are ephemeral, and so is `emptyDir`: it lives only as long as the
pod. For data that has to outlive a pod you need **persistent volumes**:

```
PersistentVolumeClaim (PVC)   "I need 1Gi, ReadWriteOnce"          ← you write this
        │ bound to
PersistentVolume (PV)         an actual disk                       ← created on demand
        ▲ provisioned by
StorageClass                  "how to make disks" (driver + params) ← platform team
```

On EKS the `gp3` StorageClass uses the EBS CSI driver: a PVC becomes an EBS volume that
follows the pod between nodes *in the same AZ*. In this lab, kind's `local-path`
provisioner creates a directory on a node.

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

`WaitForFirstConsumer` means the volume isn't created until a pod using it is
scheduled, so the disk lands in the right zone/node. (With EBS, an eagerly created volume
in the wrong AZ would make the pod unschedulable.)

Delete the pod and recreate it. The data survives:

```bash
kubectl delete pod writer
kubectl apply -f pvc.yaml
kubectl logs writer          # two timestamps
```

Where does it physically live?

```bash
kubectl get pv -o custom-columns=NAME:.metadata.name,CLAIM:.spec.claimRef.name,NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0],PATH:.spec.hostPath.path
```

Note the node affinity on the PV. Pods using this volume can only run on that node, just as
an EBS-backed pod is pinned to one AZ.

## 2. StatefulSets

Deployments treat pods as interchangeable cattle with random names, all sharing one PVC
(if any). Databases, queues and consensus systems need:

- **stable identity**: `redis-0`, `redis-1`, … that keep their names across restarts
- **stable storage**: each replica gets *its own* PVC that follows it
- **ordered** startup, scaling and rolling updates
- **stable DNS** through a headless Service: `redis-0.redis.<ns>.svc.cluster.local`

Read [redis.yaml](redis.yaml), then:

```bash
kubectl apply -f redis.yaml
kubectl rollout status statefulset/redis
kubectl get pods,pvc -l app=redis      # pod redis-0, pvc data-redis-0
```

Point the app at it. Read [web.yaml](web.yaml):

```bash
kubectl apply -f web.yaml
kubectl rollout status deploy/web
for i in 1 2 3; do kubectl exec deploy/web -- curl -s localhost:8080/ | grep -E '"pod"|visits'; done
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
kubectl get pods -l app=redis -w       # redis-1 only starts after redis-0 is ready, then redis-2
kubectl get pvc                        # data-redis-1, data-redis-2
kubectl run tmp --rm -it --restart=Never --image=busybox:1.37 -- nslookup redis   # headless: one A record per pod
kubectl scale statefulset redis --replicas=1
kubectl get pvc                        # PVCs are NOT deleted on scale-down - data safety first
```

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

## Clean up

```bash
kubectl delete -f .
kubectl delete pvc --all      # StatefulSet PVCs outlive the StatefulSet
```
