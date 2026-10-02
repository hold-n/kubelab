# 00 — Orientation: what Kubernetes actually is

## The one idea to internalise

Kubernetes is a **database of desired state** (the API server, backed by etcd) plus a pile of
**control loops** that keep comparing desired state with actual state and acting to close the
gap. Everything else in this course is a consequence.

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

The components don't call each other; each watches the API server and writes its results
back there. The scheduler never tells a kubelet "start this pod". It writes a node name onto
the pod, and that node's kubelet notices. (Exception: for `kubectl logs` and `exec` the API
server connects straight to the kubelet.)

So there's no "deploy" command that runs a sequence of steps. You record intent, and the
controllers converge on it, forever. Compared to AWS:

- **CloudFormation** applies a template once. Delete an instance by hand and the stack has
  drifted. Kubernetes keeps reconciling: delete a pod and its controller makes a new one.
- **ECS** comes closest (its service scheduler keeps N tasks running), but Kubernetes applies
  the same pattern to *everything* (networking, storage, certificates, DNS records), and you
  can add your own controllers for your own types (lesson 15).

Why build it this way? A script that dies halfway through leaves a mess. A control loop that
dies halfway just looks at reality again when it restarts and carries on.

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

Three nodes, all `Ready`, with IPs on a Docker network: these "nodes" are Docker containers
on this orb. On EKS they'd be EC2 instances:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

In kind, the control plane itself runs as pods you can see:

```bash
kubectl get pods -n kube-system -o wide
```

| Pod | What it is | On EKS |
|---|---|---|
| `etcd-…` | the database | hidden (AWS runs it) |
| `kube-apiserver-…` | the API everyone talks to | hidden |
| `kube-scheduler-…` | assigns pods to nodes | hidden |
| `kube-controller-manager-…` | runs the built-in control loops | hidden |
| `coredns-…` | cluster DNS | visible, an EKS add-on |
| `kube-proxy-…` (one per node) | implements Service networking | visible, an EKS add-on |
| `kindnet-…` (one per node) | the CNI plugin that gives pods IPs | `aws-node`, the VPC CNI |

(Pods like `metrics-server` appear once later lessons install them.)

The kubelet and containerd aren't pods. Something has to exist before pods can, so they're
ordinary processes on each node:

```bash
docker exec lab-worker ps -eo pid,comm | grep -E 'kubelet|containerd'
docker exec lab-worker crictl ps     # containers on this node, as containerd sees them
```

## Learn to navigate the API

```bash
kubectl api-resources                  # every type the cluster knows, with short names
kubectl explain pod.spec.containers    # built-in field documentation
kubectl explain deployment.spec --recursive | less
kubectl get all -A                     # "all" really means "the common ones"
kubectl get events -A --sort-by=.lastTimestamp | tail -20
```

In `api-resources`, `SHORTNAMES` is why people type `kubectl get po,svc,deploy`, and
`NAMESPACED` says which types live in a namespace and which are cluster-wide (like nodes).
Events are the cluster's activity log, the first place to look when something isn't
happening; they expire after an hour.

Output formats you'll use constantly:

```bash
kubectl get nodes -o yaml                         # the full object, spec + status
kubectl get nodes --show-labels
kubectl get nodes -L zone                         # show a label as a column
kubectl get pods -n kube-system -o jsonpath='{.items[*].metadata.name}'
kubectl get pods -n kube-system -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName
```

The workers carry a `zone` label so later lessons can pretend they're in different AZs.

Underneath, it's all a REST API. Here's what kubectl sends:

```bash
kubectl get nodes -v=6 2>&1 | grep GET
kubectl get --raw /api/v1/namespaces/kube-system/pods | head -c 400; echo
```

A plain `GET /api/v1/nodes`, and the raw JSON that kubectl turns into tables. Anything kubectl
does, `curl` with the right credentials could do.

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

1. The scheduler picks the node by writing `spec.nodeName` on the pod. The kubelet on that node
   sees the assignment and starts the containers through containerd.
2. No. Kubelets keep running what they already have, and even restart crashed containers
   locally. But anything that needs the API stops: you can't change anything, and pods lost
   with a dead node won't be replaced until the API server is back.
3. `spec` is desired state, written by you or a higher-level controller. `status` is observed
   state, written by the controller or kubelet responsible for the object.
</details>
