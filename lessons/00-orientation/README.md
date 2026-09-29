# 00 — Orientation: what Kubernetes actually is

## The one idea to internalise

Kubernetes is a **database of desired state** (the API server backed by etcd) plus a
collection of **control loops** that continuously compare desired state with actual state and
act to close the gap.

```
          you: kubectl apply -f thing.yaml
                        │
                        ▼
┌───────────────────────────────────────────┐
│ API server  ◀──▶  etcd (desired + status) │
└──────┬───────────────┬────────────────┬───┘
       │ watch         │ watch          │ watch
       ▼               ▼                ▼
  scheduler      controller-manager   kubelet (on every node)
  "which node    "Deployment wants 3  "pods bound to me should be
   for this       pods, I see 2 →      running → start containers
   pod?"          create 1"            via containerd, report status"
```

Nothing talks to anything directly: every component reads and writes objects through the
API server. There's no "deploy" command that runs a sequence of steps. You record intent,
and the controllers converge on it, forever. Compared to AWS:

- **CloudFormation** applies a template once. If someone deletes the instance, the stack
  drifts. Kubernetes keeps reconciling, so if you delete a pod its controller recreates it.
- **ECS** comes closest (a service scheduler keeps N tasks running), but Kubernetes applies
  the same pattern to *everything* (networking, storage, certificates, DNS records), and you
  can add your own controllers (lesson 15).

Every object has the same shape:

```yaml
apiVersion: apps/v1     # API group + version
kind: Deployment        # type
metadata:               # name, namespace, labels, annotations
  name: web
spec: {...}             # desired state (written by you)
status: {...}           # observed state (written by controllers)
```

## Explore the lab

```bash
kubectl cluster-info
kubectl get nodes -o wide
```

The "nodes" are Docker containers on this orb. On EKS they'd be EC2 instances:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

The control plane itself runs as pods (on EKS AWS hides these from you):

```bash
kubectl get pods -n kube-system -o wide
```

Find: `etcd-…`, `kube-apiserver-…`, `kube-scheduler-…`, `kube-controller-manager-…`,
`coredns-…` (cluster DNS), `kube-proxy-…` (Service networking, one per node), and
`kindnet-…` (the CNI plugin that gives pods IPs; on EKS it's the VPC CNI).

Look inside a node to see the kubelet and containerd running as ordinary processes:

```bash
docker exec lab-worker ps -eo pid,comm | grep -E 'kubelet|containerd'
docker exec lab-worker crictl ps     # containers on this node, as containerd sees them
```

## Learn to navigate the API

```bash
kubectl api-resources                  # every type the cluster knows, with short names
kubectl explain pod.spec.containers    # built-in field documentation
kubectl explain deployment.spec --recursive | less
kubectl get all -A                     # "all" is actually "the common ones"
kubectl get events -A --sort-by=.lastTimestamp | tail -20
```

Output formats you'll use constantly:

```bash
kubectl get nodes -o yaml                         # the full object, spec + status
kubectl get nodes --show-labels
kubectl get nodes -L zone                         # add a label as a column
kubectl get pods -n kube-system -o jsonpath='{.items[*].metadata.name}'
kubectl get pods -n kube-system -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName
```

It's all a REST API underneath. See what kubectl does:

```bash
kubectl get nodes -v=6 2>&1 | grep GET
kubectl get --raw /api/v1/namespaces/kube-system/pods | head -c 400; echo
```

## Quality-of-life setup (optional)

```bash
echo 'source <(kubectl completion bash)' >> ~/.bashrc
echo 'alias k=kubectl; complete -o default -F __start_kubectl k' >> ~/.bashrc
source ~/.bashrc
```

## Check your understanding

1. Which component decides *which node* a pod runs on? Which one actually starts the container?
2. If the API server goes down, do running pods stop? (Think about who is doing what.)
3. What's the difference between `spec` and `status`, and who writes each?

<details><summary>Answers</summary>

1. The scheduler assigns the node (it writes `spec.nodeName`). The kubelet on that node starts it through containerd.
2. No. Kubelets keep running what they already have. You just can't change anything, and nothing self-heals until the API server is back.
3. `spec` is desired state, written by you or a higher-level controller. `status` is observed state, written by the controller or kubelet that owns the object.
</details>
