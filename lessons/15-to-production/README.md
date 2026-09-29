# 15 — From lab to production

You now know the core objects. This lesson covers how Kubernetes is extended and what
changes on a real cluster (EKS especially), and gives you a map of the surrounding
ecosystem so the names you hear at work have somewhere to go.

## Part A: operators, or how Kubernetes gets extended (hands-on, 20 min)

You've already used this pattern without noticing: Envoy Gateway added `Gateway` and
`HTTPRoute` types (**CRDs**) and runs a **controller** that reconciles them into Envoy
Deployments and Services. That combination is called an **operator**, and it's how almost
everything in the ecosystem is built (databases, certificates, Karpenter, Argo CD, the AWS
controllers).

Build a toy one. [operator/crd.yaml](operator/crd.yaml) defines a `Greeter` type, and
[operator/controller.sh](operator/controller.sh) is a ~40-line bash reconcile loop that
turns each Greeter into a Deployment.

```bash
cd lessons/15-to-production/operator
kubectl apply -f crd.yaml
kubectl apply -f greeter.yaml
kubectl get greeters                # a brand-new API type, with printer columns
kubectl get deploy                  # nothing yet - no controller is running
```

In a second terminal, start the controller: `./controller.sh`. Then:

```bash
kubectl get deploy greeter-hello
kubectl exec deploy/greeter-hello -- curl -s localhost:8080/ | grep greeting

kubectl patch greeter hello --type merge -p '{"spec":{"replicas":3,"message":"changed!"}}'
kubectl get deploy greeter-hello    # the controller reconciled the change

kubectl delete deploy greeter-hello # drift!
kubectl get deploy greeter-hello    # ...recreated a few seconds later

kubectl delete greeter hello
kubectl get deploy                  # gone: garbage-collected through the ownerReference
```

Also try creating a Greeter without `message`, or with `replicas: 10`. The API server
rejects it using the CRD's OpenAPI schema before your controller ever sees it.

Real operators are written in Go with Kubebuilder/controller-runtime. They use watches
instead of polling, write `.status`, and handle finalizers, but the loop is the same.
Stop the controller with Ctrl-C, and `kubectl delete -f crd.yaml` when you're done.

## Part B: what's different on EKS

| Area | This lab | On EKS |
|---|---|---|
| Control plane | a container you can break | managed by AWS across 3 AZs; you never see etcd |
| Nodes | fixed Docker containers | managed node groups, Fargate, or **Karpenter**-provisioned EC2 (Spot/On-Demand, right-sized per pending pod) |
| Pod networking | kindnet, pod IPs from a private range | **VPC CNI**: pods get real VPC IPs (watch IP exhaustion; prefix delegation helps) |
| `LoadBalancer` Service | cloud-provider-kind | **AWS Load Balancer Controller** → NLB |
| L7 ingress | Envoy Gateway | AWS LB Controller (ALB via Ingress or Gateway API), or Envoy/Istio/Cilium behind an NLB |
| Storage | local-path directory on a node | **EBS CSI** (gp3, one AZ), **EFS CSI** for ReadWriteMany |
| Human auth | admin client cert | IAM → **access entries** → RBAC groups |
| Pod → AWS APIs | n/a | **EKS Pod Identity** (or IRSA): ServiceAccount ↔ IAM role |
| Secrets | plain Secrets | KMS envelope encryption + External Secrets Operator / Secrets Store CSI from Secrets Manager |
| Upgrades | `./cluster/down.sh` | control plane upgrade (one minor at a time), then nodes; PDBs gate drains; deprecated APIs must be migrated first |
| Observability | `kubectl logs/top` | CloudWatch Container Insights, or Prometheus/Grafana (Amazon Managed Service for Prometheus / Grafana), Fluent Bit, OpenTelemetry |

Typical production workflow:

```
git push → CI builds image → pushes to ECR → bumps tag in a GitOps repo
                                                   │
                            Argo CD / Flux in the cluster notices the change
                                                   │
                                     kubectl-apply-equivalent + health checks,
                                     drift detection, one-click rollback
```

Humans rarely `kubectl apply` in prod. The cluster pulls desired state from git
(**GitOps**), which is the same reconciliation idea applied one level up.

## Part C: the ecosystem map

Kubernetes is deliberately a *kernel*: scheduling, reconciliation and an extensible API.
Nearly everything else comes from other projects, most of them CNCF. These are the ones you'll
hear about most, grouped by the problem they solve, with the closest AWS equivalent.

**Packaging & delivery**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Helm** | package manager / templated releases (lesson 08) | CloudFormation templates + stacks |
| **Kustomize** | patch-based config overlays (lesson 08) | — |
| **Argo CD**, **Flux** | GitOps continuous delivery: sync the cluster from git | CodePipeline + CodeDeploy, pull-based |
| **Argo Rollouts**, **Flagger** | canary / blue-green with automated metric analysis | CodeDeploy traffic shifting + alarms |
| **Crossplane**, **ACK** | manage cloud resources (RDS, S3…) as Kubernetes CRDs | CloudFormation/CDK, driven from the cluster |
| **Terraform / OpenTofu**, **Pulumi** | provision the cluster and cloud infrastructure around it | CloudFormation / CDK |

**Networking & traffic**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Envoy** | the L7 proxy under most of the tools below | ALB's data plane |
| **Envoy Gateway**, **Istio**, **Cilium**, **Traefik**, **NGINX Gateway Fabric** | Gateway API implementations | ALB |
| **Istio**, **Linkerd**, **Cilium** (service mesh) | mTLS between services, retries, traffic policy, per-request telemetry | App Mesh (end of support Sept 2026) / VPC Lattice |
| **Cilium**, **Calico** | CNI plugins with eBPF networking and NetworkPolicy | VPC CNI + security groups |
| **CoreDNS** | cluster DNS (you used it in lesson 03) | Route 53 private zones / Cloud Map |
| **cert-manager** | issue and renew TLS certificates (Let's Encrypt, ACM PCA) as CRDs | ACM |
| **ExternalDNS** | create Route 53 records from Services/Gateways | — |

**Scaling & scheduling**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Karpenter** | just-in-time node provisioning (originally built by AWS) | ASG + capacity-optimised fleet |
| **Cluster Autoscaler** | the older node-group-based autoscaler | ASG scaling |
| **KEDA** | event-driven pod autoscaling (SQS depth, Kafka lag, cron, scale to zero) | Application Auto Scaling on custom metrics |
| **VPA** | right-size requests/limits automatically | Compute Optimizer |

**Observability**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Prometheus** (+ Alertmanager) | pull-based metrics and alerting, the de facto standard | CloudWatch Metrics + Alarms |
| **Grafana** | dashboards over everything | CloudWatch dashboards |
| **OpenTelemetry** | vendor-neutral traces/metrics/logs SDKs + collector | X-Ray SDK / ADOT |
| **Jaeger**, **Tempo** | distributed tracing backends | X-Ray |
| **Loki**, **Fluent Bit**, **Vector** | log shipping and storage | CloudWatch Logs + agent |

**Security & policy**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Pod Security Admission** (built in) | enforce baseline/restricted pod settings per namespace | — |
| **Kyverno**, **OPA Gatekeeper** | admission policies ("no `latest` tags", "must have limits") | SCPs / Config rules, at deploy time |
| **External Secrets Operator** | sync from Secrets Manager / Parameter Store into Secrets | — |
| **Sealed Secrets**, **SOPS** | encrypted secrets safe to commit to git | KMS-encrypted parameters |
| **Falco** | runtime threat detection (syscall-level) | GuardDuty Runtime Monitoring |
| **Trivy**, **Grype** | image and cluster vulnerability scanning | ECR / Inspector scanning |
| **SPIFFE/SPIRE** | workload identity across clusters and clouds | IAM roles for workloads |

**Stateful systems on Kubernetes (via operators)**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **CloudNativePG**, **Zalando Postgres Operator** | HA PostgreSQL | RDS / Aurora |
| **Strimzi** | Kafka | MSK |
| **Rook/Ceph**, **Longhorn** | distributed block/file storage | EBS / EFS |
| **Velero** | cluster and volume backup/restore | AWS Backup |

**Other workload platforms built on Kubernetes**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Knative** | serverless containers (scale-to-zero, revisions) | App Runner / Lambda |
| **Argo Workflows**, **Tekton** | DAG workflows / CI pipelines as pods | Step Functions / CodeBuild |
| **Kubeflow**, **Ray (KubeRay)**, **Kueue** | ML training/serving and batch queueing | SageMaker / AWS Batch |
| **Dapr** | sidecar building blocks: pub/sub, state, service invocation | SNS/SQS/DynamoDB SDK abstractions |

**Adjacent distributed-systems infrastructure** (not Kubernetes-specific, but it shows up alongside it)
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **etcd** | Raft-based consistent KV store (Kubernetes' database) | DynamoDB with strong consistency, sort of |
| **Consul**, **ZooKeeper** | service discovery, config, coordination | Cloud Map / DynamoDB locks |
| **Nomad** | a simpler Kubernetes alternative from HashiCorp | ECS |
| **Kafka**, **NATS**, **RabbitMQ**, **Pulsar** | messaging and streaming | MSK / Kinesis, SQS/SNS, Amazon MQ |
| **Vault** | secrets, dynamic credentials, PKI | Secrets Manager + ACM PCA |
| **Temporal** | durable workflow execution | Step Functions |

For a closer look at Envoy, Istio, Prometheus, Vault, etcd, ZooKeeper, Consul, Kafka and Temporal (what each does, how it works inside, and how it's run in practice), continue to [lesson 16](../16-distributed-systems-toolbox/README.md).

A sensible learning order after this course: **Argo CD** (GitOps), then **Prometheus +
Grafana**, then **cert-manager + ExternalDNS**, then **Karpenter** on a real EKS cluster.
That covers most of what a production EKS platform runs.

## Where to go next

- **Build a real EKS cluster**: [EKS Workshop](https://www.eksworkshop.com/) (AWS's own, very hands-on)
  or [EKS Best Practices Guides](https://docs.aws.amazon.com/eks/latest/best-practices/introduction.html).
- **Understand the internals**: *Kubernetes the Hard Way* (Kelsey Hightower), where you
  bootstrap every component by hand.
- **Write a real operator**: the [Kubebuilder book](https://book.kubebuilder.io/).
- **Certify**: CKAD (developer-focused, very hands-on) or CKA (operations).
- **Read**: *Kubernetes Patterns* (Ibryam & Huß), and *Production Kubernetes* (Rosso et al.).
