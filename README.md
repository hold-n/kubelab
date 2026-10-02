# kubelab — learn Kubernetes by doing

A hands-on Kubernetes course for an engineer who already knows distributed systems and AWS
(ECS, ASGs, ELB, CloudFormation, IAM…) but hasn't used Kubernetes. Every lesson runs on a
real multi-node cluster in this orb, and most end with a challenge.

## The lab

```
┌──────────────────────────── orb (Docker host) ─────────────────────────────┐
│                                                                            │
│  kind cluster "lab"  (each node is a Docker container)                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐          │
│  │ lab-control-plane│  │ lab-worker       │  │ lab-worker2      │          │
│  │ API server, etcd │  │ zone=zone-a      │  │ zone=zone-b      │          │
│  │ scheduler, ctrl- │  │ kubelet +        │  │ kubelet +        │          │
│  │ manager          │  │ containerd       │  │ containerd       │          │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘          │
│                                                                            │
│  cloud-provider-kind: acts like AWS for Services of type LoadBalancer      │
│  kubectl / helm / kind: your tools                                         │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Kubernetes v1.37** via [kind](https://kind.sigs.k8s.io) (Kubernetes-in-Docker): one control
  plane and two workers, each a Docker container pretending to be a machine.
- **cloud-provider-kind** gives `LoadBalancer` Services a reachable IP, the way the AWS Load
  Balancer Controller gives you an NLB on EKS.
- **The kubelab app** ([app/server.py](app/server.py)): a tiny HTTP service with knobs to crash,
  hang, leak memory, burn CPU and flip readiness, so you can break things on purpose and watch
  Kubernetes respond. Images `kubelab/app:v1` and `kubelab/app:v2` are built locally and
  side-loaded into the nodes; no registry is involved.

```bash
./cluster/up.sh     # create/repair the cluster (idempotent; re-run after an orb restart)
./cluster/down.sh   # delete it completely
```

## Open the course in the portal

The whole course runs in the browser through an Amp portal:

- **Lessons rendered as HTML**, with a sidebar, syntax-highlighted code and a viewer for every
  manifest the lessons link to.
- **A built-in terminal** (the **▣ Terminal** button, or Ctrl+\`) that opens beside the text, at
  the repo root. Every shell snippet has a **▶ Paste in terminal** button, which pastes the
  commands *without* running them: read them, then press Enter.
- **Tool UIs** (Prometheus, Consul, Vault, and the lesson 09 Gateway), each on its own portal
  and listed in the **Tool UIs** menu with a live running/not-running status.
- **Ask about anything:** select text on any page and use the portal's review button to send a
  question or comment straight to the Amp thread.

Open **kubelab course** from the thread's **Portal** tab. If it isn't listed, run
`amp orb services ensure` in the orb. The services are declared in
`.amp/services.yaml` and the portal code lives in [portal/](portal/).
Only this thread's collaborators can use the terminal.

## How to work through it

- Run commands a few at a time and read the output before moving on. The lessons tell you what
  to look for; the output is where the learning is.
- Keep a second terminal running `kubectl get pods -w` (or `watch kubectl get pods -o wide`).
  Most of Kubernetes is things happening *on their own* after you change something, and this
  is how you catch them in the act.
- `kubectl explain <thing>` is built-in documentation for every field, e.g.
  `kubectl explain deployment.spec.strategy`.
- If you wreck the cluster, `./cluster/down.sh && ./cluster/up.sh` gives you a fresh one in a
  minute or two.

## Lessons

| #  | Lesson | You'll learn | Time |
|----|--------|--------------|------|
| 00 | [Orientation](lessons/00-orientation/README.md) | Architecture, the reconciliation loop, finding your way around with kubectl | 30m |
| 01 | [Pods](lessons/01-pods/README.md) | The unit of deployment; logs, exec, port-forward, sidecars | 45m |
| 02 | [Deployments](lessons/02-deployments/README.md) | Self-healing, scaling, rolling updates, rollbacks | 45m |
| 03 | [Services & networking](lessons/03-services/README.md) | Service discovery, DNS, ClusterIP / NodePort / LoadBalancer | 45m |
| 04 | [Config & Secrets](lessons/04-config/README.md) | ConfigMaps, Secrets, env vs mounted files, the Downward API | 30m |
| 05 | [Health & resources](lessons/05-health-resources/README.md) | Probes, requests/limits, OOMKilled, QoS, graceful shutdown | 60m |
| 06 | [Namespaces, quotas & RBAC](lessons/06-namespaces-rbac/README.md) | Multi-tenancy, ServiceAccounts, Roles, `kubectl auth can-i` | 45m |
| 07 | [Storage & StatefulSets](lessons/07-storage-statefulsets/README.md) | PVCs, StorageClasses, stable identity, running Redis | 45m |
| 08 | [Helm & Kustomize](lessons/08-helm/README.md) | Installing third-party charts, writing your own chart, overlays | 60m |
| 09 | [Gateway API](lessons/09-gateway-api/README.md) | L7 routing, header matching, canary traffic splits | 45m |
| 10 | [Scheduling](lessons/10-scheduling/README.md) | Node selection, spreading across zones, taints, drains, PDBs | 45m |
| 11 | [Jobs, CronJobs & DaemonSets](lessons/11-jobs-daemonsets/README.md) | Batch work, scheduled work, per-node agents | 30m |
| 12 | [Autoscaling](lessons/12-autoscaling/README.md) | HPA driven by real CPU load | 30m |
| 13 | [Troubleshooting drills](lessons/13-troubleshooting/README.md) | 10 broken scenarios to diagnose and fix, graded by script | 90m |
| 14 | [Capstone](lessons/14-capstone/README.md) | Build a production-shaped app from requirements; auto-graded | 2h |
| 15 | [From lab to production](lessons/15-to-production/README.md) | EKS specifics, GitOps, operators, and the wider ecosystem | reading |
| 16 | [The distributed-systems toolbox](lessons/16-distributed-systems-toolbox/README.md) | How infra software is really run (cloud, SaaS, K8s, VMs, on-prem); Envoy, Istio, Prometheus, Vault, etcd, ZooKeeper, Consul, Kafka, Temporal | 2h |

## Cheat sheet: AWS → Kubernetes

| AWS concept | Kubernetes counterpart | Notes |
|---|---|---|
| ECS task / task definition | Pod / pod template | One or more containers sharing an IP and volumes, always on one node |
| ECS service, ASG desired count | Deployment (→ ReplicaSet) | Controller keeps N replicas running and handles rollouts |
| CodeDeploy rolling / blue-green | Deployment `strategy`, Gateway API weights, Argo Rollouts | |
| Cloud Map / internal ALB | Service (ClusterIP) + cluster DNS | `http://web.default.svc.cluster.local`, or just `http://web` from the same namespace |
| NLB | Service `type: LoadBalancer` | On EKS, provisioned by the AWS Load Balancer Controller |
| ALB + listener rules | Gateway + HTTPRoute (or the older Ingress) | |
| ELB health check / ECS container health check | readinessProbe / livenessProbe | Like ELB, readiness gates traffic; like ECS, liveness restarts |
| SSM Parameter Store | ConfigMap | |
| Secrets Manager | Secret (+ External Secrets Operator on EKS) | Base64-encoded, *not* encrypted: anyone who can read the Secret can read the value (EKS does encrypt etcd at rest) |
| IAM policy / role | Role / ClusterRole + RoleBinding / ClusterRoleBinding | Controls access to the *Kubernetes API*, not to AWS |
| Instance profile / task role | ServiceAccount (+ EKS Pod Identity or IRSA for AWS APIs) | The pod's identity |
| AWS account / team boundary | Namespace (+ ResourceQuota, RBAC, NetworkPolicy) | Softer boundary than an account |
| EBS volume | PersistentVolume (via PVC + StorageClass) | EBS CSI driver on EKS |
| ECS service auto scaling (target tracking) | HorizontalPodAutoscaler | Scales pods; Karpenter / Cluster Autoscaler scale nodes (the ASG part) |
| AZ spread | `topologySpreadConstraints` on `topology.kubernetes.io/zone` | This lab uses a plain `zone` label instead (lesson 10) |
| AWS Batch / scheduled ECS task | Job / CronJob | |
| ECS daemon scheduling | DaemonSet | |
| CloudFormation template | YAML manifests; Helm chart / Kustomize for reuse | Continuously reconciled, not applied once |
| CloudFormation custom resource | CustomResourceDefinition + controller (an "operator") | |
