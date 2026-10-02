# 06 — Namespaces, quotas and RBAC

Real clusters are shared by many teams. Two questions follow: how do teams stay out of each
other's way, and who may do what?

- **Namespace**: a scope for names, permissions, quotas and policies. Most objects are
  namespaced; some (Nodes, PersistentVolumes, StorageClasses, ClusterRoles, CRDs) are
  cluster-wide. It's a *soft* boundary: namespaces share nodes, the network and the control
  plane. For hard isolation, companies use separate clusters (often one per AWS account).
- **RBAC**: who can do what *to the Kubernetes API*. Not pod-to-pod traffic (that's
  NetworkPolicy), not AWS (that's IAM).

```
Subject (User | Group | ServiceAccount)
   └── bound by RoleBinding / ClusterRoleBinding to
         Role / ClusterRole = list of rules: apiGroups × resources × verbs
```

RBAC is purely additive: no deny rules, and everything not granted is denied. (So unlike
IAM, there's never a question of which policy wins.)

`cd lessons/06-namespaces-rbac`

## 1. Namespaces

```bash
kubectl get namespaces
kubectl api-resources --namespaced=false | head     # cluster-scoped kinds
kubectl apply -f namespace.yaml
kubectl get quota,limitrange -n team-a
```

[namespace.yaml](namespace.yaml) gives `team-a` a **ResourceQuota** (at most 5 pods, 1 CPU
and 1Gi of requests, 2Gi of memory limits) and a **LimitRange** (defaults for containers that
don't declare resources). The LimitRange matters: once a quota covers `requests.cpu`, pods
that don't set it are rejected outright.

Work in it:

```bash
kubectl create deployment demo -n team-a --image=kubelab/app:v1 --replicas=2
kubectl get pods -n team-a
kubectl get pod -n team-a -o jsonpath='{.items[0].spec.containers[0].resources}{"\n"}'  # defaults from the LimitRange
kubectl describe quota -n team-a
```

You asked for no resources, yet each pod requests 100m CPU, and the quota shows 2/5 pods, 200m/1 CPU.

Tired of `-n`? Switch your default namespace (and remember to switch back):

```bash
kubectl config set-context --current --namespace=team-a
kubectl get pods
kubectl config set-context --current --namespace=default
```

## 2. Hit the quota

```bash
kubectl scale deploy/demo -n team-a --replicas=8
kubectl get deploy,rs -n team-a       # Deployment READY 5/8; ReplicaSet DESIRED 8, CURRENT 5
kubectl describe rs -n team-a | grep -m1 forbidden
kubectl scale deploy/demo -n team-a --replicas=2
```

Your `scale` succeeded; it's the ReplicaSet controller's pod creations that were rejected at
admission (`exceeded quota ... limited: pods=5`). So the only visible symptom is a Deployment
stuck at 5/8. It's like hitting an AWS service quota, but per namespace and set by you.

## 3. ServiceAccounts and RBAC

A **ServiceAccount** is an identity for software rather than a person. Read
[rbac.yaml](rbac.yaml): a `deployer` ServiceAccount that can manage Deployments and read pods
and logs in `team-a`. Nothing else.

```bash
kubectl apply -f rbac.yaml
```

Test permissions by **impersonating** it with `--as` (you're cluster-admin, so you're allowed to):

```bash
SA=system:serviceaccount:team-a:deployer
kubectl auth can-i create deployments -n team-a --as=$SA     # yes
kubectl auth can-i delete pods -n team-a --as=$SA            # no
kubectl auth can-i get secrets -n team-a --as=$SA            # no
kubectl auth can-i list pods -n default --as=$SA             # no - a Role only covers its own namespace
kubectl auth can-i --list -n team-a --as=$SA
kubectl get pods -n team-a --as=$SA                          # works
kubectl get secrets -n team-a --as=$SA                       # Forbidden
```

`--list` also shows things every authenticated identity gets, like the `selfsubject...`
reviews that make `can-i` work and URLs like `/healthz`.

## 4. Call the API from inside a pod

Workloads authenticate with their ServiceAccount's token, which Kubernetes mounts
automatically. It's short-lived and rotated, conceptually like instance-profile credentials
from IMDS. Read [api-client.yaml](api-client.yaml):

```bash
kubectl apply -f api-client.yaml
kubectl wait -n team-a --for=condition=Ready pod/api-client
kubectl exec -n team-a -it api-client -- sh
```

Inside the pod:

```sh
T=/var/run/secrets/kubernetes.io/serviceaccount
ls $T                                     # token, ca.crt, namespace
API=https://kubernetes.default.svc
AUTH="Authorization: Bearer $(cat $T/token)"
curl -s --cacert $T/ca.crt -H "$AUTH" $API/api/v1/namespaces/team-a/pods | grep '"name"'
curl -s --cacert $T/ca.crt -H "$AUTH" $API/api/v1/namespaces/team-a/secrets   # 403 Forbidden
exit
```

`kubernetes.default.svc` is a Service fronting the API server. The first call returns a JSON
`PodList` (the `grep` picks out pod and container names); the second, a `Status` with
`"code": 403`. This is exactly how controllers, operators and CI agents running in-cluster
talk to the API; client libraries just hide the curl. (On EKS, **Pod Identity** / **IRSA**
extend the same idea to AWS: a ServiceAccount is mapped to an IAM role, and the pod gets AWS
credentials for it.)

> How do *humans* authenticate? Kubernetes has no user database. Users come from client
> certificates, OIDC, or cloud IAM. On EKS your IAM principal is mapped to Kubernetes
> groups with **access entries**, and RBAC takes it from there. Check your own identity
> with `kubectl auth whoami`: here, `kubernetes-admin` via a client certificate.

## 5. ClusterRoles you get for free

```bash
kubectl get clusterroles | grep -E '^(admin|edit|view|cluster-admin) '
kubectl describe clusterrole view | head -30
```

`view` reads, `edit` changes most things, `admin` also manages RBAC within a namespace,
`cluster-admin` does anything. The pattern worth knowing: bind a ClusterRole with a
*RoleBinding*, and it applies only in that namespace. Define "developer" once, hand it out
namespace by namespace.

## Challenge

1. Give the `deployer` ServiceAccount read-only access to *everything* in namespace
   `team-a` by binding the built-in `view` ClusterRole with a RoleBinding. Check with
   `kubectl auth can-i --list`. Can it read Secrets now? (Why might `view` exclude them?)
2. Create a ServiceAccount `auditor` in `team-a` that can list pods in **all** namespaces.
   (Hint: ClusterRole + ClusterRoleBinding.) Prove it with `kubectl get pods -A --as=...`.
3. As the `deployer`, try to create a Deployment with 10 replicas. Who's stopping you: RBAC or the quota?

<details><summary>Answers</summary>

1. `kubectl create rolebinding deployer-view -n team-a --clusterrole=view --serviceaccount=team-a:deployer`.
   Still no Secrets: reading them can yield credentials (like other ServiceAccounts' tokens)
   worth far more than "view".
2. `kubectl create sa auditor -n team-a`, then
   `kubectl create clusterrole pod-reader --verb=get,list,watch --resource=pods` and
   `kubectl create clusterrolebinding auditor-pod-reader --clusterrole=pod-reader --serviceaccount=team-a:auditor`.
3. The quota. RBAC lets the deployer create the Deployment; the *ReplicaSet controller*
   creates the pods under its own identity, and the quota caps how many.
</details>

## Clean up

```bash
kubectl delete namespace team-a     # deletes everything inside it
kubectl delete clusterrolebinding auditor-pod-reader --ignore-not-found   # cluster-scoped leftovers from challenge 2
kubectl delete clusterrole pod-reader --ignore-not-found
```
