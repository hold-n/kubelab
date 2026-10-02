# 15 — From lab to production

You know the core objects now. Three things are left: how Kubernetes gets extended (you'll
build a tiny operator), what changes when the cluster is EKS instead of kind, and a map of
the ecosystem, so the dozens of project names you'll hear at work each have a slot to go in.

## Part A: operators, or how Kubernetes gets extended (hands-on, 20 min)

You've already used one. In lesson 09, the Envoy Gateway chart installed new API types
(`Gateway`, `HTTPRoute`) as **CustomResourceDefinitions (CRDs)**, plus a **controller** that
watches them and turns them into Envoy Deployments and Services. A CRD plus a controller that
reconciles it is called an **operator**. Nearly the whole ecosystem is built this way:
databases, certificates, Karpenter, Argo CD, the AWS controllers.

The two halves are separate. A CRD only teaches the API server a new noun, with a schema;
objects of that type get validated and stored, and nothing else happens. The controller is
what gives them meaning, and it's just an ordinary program (usually a pod; here, a script in
your terminal) talking to the API the way `kubectl` does.

Build a toy one. [operator/crd.yaml](operator/crd.yaml) defines a `Greeter` type, and
[operator/controller.sh](operator/controller.sh) is a ~45-line bash loop that turns each
Greeter into a Deployment running the kubelab app.

```bash
cd lessons/15-to-production/operator
kubectl apply -f crd.yaml
kubectl apply -f greeter.yaml
kubectl get greeters                # a brand-new API type, with custom columns (Message, Replicas)
kubectl get deploy                  # no greeter-hello yet: nothing is acting on the Greeter
```

The Greeter is stored in etcd and doing nothing. Start the controller in a second terminal
(it opens at the repo root) and leave it running. It watches the namespace of your current
kubectl context.

```bash
./lessons/15-to-production/operator/controller.sh
```

Back in the first terminal:

```bash
kubectl get deploy greeter-hello    # created by the controller within a few seconds
kubectl exec deploy/greeter-hello -- curl -s localhost:8080/ | grep greeting

kubectl patch greeter hello --type merge -p '{"spec":{"replicas":3,"message":"changed!"}}'
sleep 5; kubectl get deploy greeter-hello   # 3 replicas, rolled out with the new GREETING

kubectl delete deploy greeter-hello # simulate drift: someone deletes what the operator made
sleep 5; kubectl get deploy greeter-hello   # ...and it's back

kubectl delete greeter hello
kubectl get deploy                  # gone, garbage-collected via its ownerReference
```

What just happened:

- **Reconcile.** Every 3 seconds the controller renders the Deployment each Greeter *should*
  have and `kubectl apply`s it. If nothing differs, apply is a no-op; the script hides those,
  so its output shows only real changes (`created`, `configured`).
- **Drift repair comes free.** The controller never asks "was something deleted?" It just
  keeps asserting desired state, so a deleted Deployment comes back.
- **Cleanup isn't the controller's job.** Each Deployment carries an `ownerReference` to its
  Greeter's UID. When the owner goes, the built-in garbage collector deletes the Deployment,
  then its ReplicaSet, then its pods: the same mechanism that ties ReplicaSets to Deployments.

Now feed it some bad Greeters:

```bash
kubectl apply -f - <<'EOF'
apiVersion: kubelab.dev/v1
kind: Greeter
metadata: { name: bad }
spec: { replicas: 10 }
EOF
kubectl apply -f - <<'EOF'
apiVersion: kubelab.dev/v1
kind: Greeter
metadata: { name: bad }
spec: { message: hi, colour: red }
EOF
```

The first is rejected for two reasons at once (`spec.message: Required value`, and
`spec.replicas ... should be less than or equal to 5`); the second with
`strict decoding error: unknown field "spec.colour"`. The API server enforces the CRD's
OpenAPI schema before anything is stored, so your controller never sees invalid input. You get
built-in-quality errors without writing a line of validation code.

Real operators are written in Go with Kubebuilder/controller-runtime. Instead of polling they
use *watches* (a long-lived stream of change events from the API server), plus a work queue so
one slow object doesn't stall the rest. They also write `.status` so `kubectl get` can show
progress, and use *finalizers* to clean up things outside the cluster (an RDS instance, a DNS
record) before the object is allowed to disappear. The loop is the same as yours:
observe, compare, act, repeat.

Stop the controller with Ctrl-C for now.

### Challenge

Start the controller again and recreate the Greeter. Then scale its Deployment by hand.
Predict what happens before you look.

```bash
kubectl apply -f greeter.yaml
sleep 5; kubectl scale deploy greeter-hello --replicas=4
kubectl get deploy greeter-hello; sleep 6; kubectl get deploy greeter-hello
```

<details><summary>Answer</summary>

It goes to 4, then back to 2 within a few seconds. The Greeter is the source of truth and the
Deployment is just its output. The controller's next pass re-applies `replicas: 2` and
quietly reverts your change. To scale, change the Greeter (`kubectl patch greeter hello ...`).

The general lesson: once something is managed by a controller, edit its *input*, not its
*output*. The same trap appears everywhere. Hand-edit a Deployment that Argo CD manages
(with self-heal on) and Argo reverts it. Set `replicas` in git for a Deployment that an HPA also scales and the two
fight, which is why charts usually omit `replicas` when autoscaling is on.
</details>

### Clean up

Stop the controller first (Ctrl-C), or it will exit with errors once its type disappears.

```bash
kubectl delete -f crd.yaml   # deletes every Greeter too, and with them their Deployments
```

## Part B: what's different on EKS

The objects and YAML are the same on EKS. What changes is everything underneath: who runs the
control plane, where nodes come from, and which controller satisfies a `LoadBalancer` Service
or a PVC.

| Area | This lab | On EKS |
|---|---|---|
| Control plane | a container you can break | managed by AWS across 3 AZs; you never see etcd |
| Nodes | fixed Docker containers | managed node groups, Fargate, or **Karpenter**-provisioned EC2 (Spot/On-Demand, sized to the pending pods). **EKS Auto Mode** runs Karpenter, the LB controller and EBS CSI for you |
| Pod networking | kindnet, pod IPs from a private range | **VPC CNI**: pods get real VPC IPs (watch for subnet IP exhaustion; prefix delegation helps) |
| `LoadBalancer` Service | cloud-provider-kind | **AWS Load Balancer Controller** → NLB |
| L7 ingress | Envoy Gateway | AWS LB Controller → ALB (via Ingress, or via Gateway API, GA since early 2026), or Envoy/Istio/Cilium behind an NLB |
| Storage | local-path directory on a node | **EBS CSI** (gp3, pinned to one AZ), **EFS CSI** for ReadWriteMany |
| Human auth | admin client cert | IAM principal → **access entry** → Kubernetes RBAC (the old `aws-auth` ConfigMap is deprecated) |
| Pod → AWS APIs | n/a | **EKS Pod Identity** (or the older IRSA): ServiceAccount ↔ IAM role |
| Secrets | plain Secrets in etcd | etcd envelope-encrypted with KMS by default (bring your own key if you like); real secrets usually live in Secrets Manager, synced in by External Secrets Operator or mounted by the Secrets Store CSI driver |
| Upgrades | `./cluster/down.sh` | control plane one minor version at a time, then add-ons and nodes; PDBs gate the node drains; removed APIs must be migrated first (EKS *cluster insights* lists them). Each version gets ~14 months of standard support, then paid extended support |
| Version | v1.37 | EKS trails upstream by a couple of months; its newest is 1.36 as of October 2026 |
| Observability | `kubectl logs/top` | CloudWatch Container Insights, or Prometheus/Grafana (Amazon Managed Service for Prometheus / Managed Grafana), Fluent Bit, OpenTelemetry |

AWS has also started offering popular ecosystem controllers as managed services. **EKS
Capabilities** runs Argo CD, ACK and kro (all in Part C) for you, outside your cluster.

### How changes reach a production cluster

```
git push → CI builds image → pushes to ECR → bumps the image tag in a GitOps repo
                                                   │
                            Argo CD / Flux in the cluster notices the commit
                                                   │
                          applies it, waits for health checks, keeps
                          re-applying if anyone drifts the live state
```

In production, humans rarely `kubectl apply`. The cluster *pulls* its desired state from a
git repo; this is called **GitOps**. It's your Greeter controller one level up: the input is a
git commit instead of a custom resource, the output is everything in the cluster, and the
same drift repair applies. The payoff is that git becomes the audit log and the undo button.
"Who changed this, and when?" is `git log`. Rolling back is `git revert`. And because the
cluster pulls, your CI system never needs credentials to the production cluster.

## Part C: the ecosystem map

Kubernetes is deliberately a *kernel*: scheduling, reconciliation and an extensible API.
Nearly everything else comes from other projects, mostly CNCF ones. Below are the ones you'll
hear about most, grouped by the problem they solve, each with its nearest AWS equivalent.
Don't memorise it. Come back when a name comes up at work.

**Packaging & delivery**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Helm** | package manager / templated releases (lesson 08) | CloudFormation templates + stacks |
| **Kustomize** | patch-based config overlays (lesson 08) | — |
| **Argo CD**, **Flux** | GitOps continuous delivery: sync the cluster from git | CodePipeline + CodeDeploy, but pull-based |
| **Argo Rollouts**, **Flagger** | canary / blue-green with automated metric analysis | CodeDeploy traffic shifting + alarms |
| **Crossplane**, **ACK** | manage cloud resources (RDS, S3…) as Kubernetes custom resources | CloudFormation/CDK, driven from the cluster |
| **kro** | bundle several resources into one new custom API ("a WebApp = Deployment + Service + bucket") without writing a controller | CloudFormation modules |
| **Terraform / OpenTofu**, **Pulumi** | provision the cluster and the cloud infrastructure around it | CloudFormation / CDK |

**Networking & traffic**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Envoy** | the L7 proxy under most of the tools below | ALB's data plane |
| **Envoy Gateway**, **Istio**, **Cilium**, **Traefik**, **NGINX Gateway Fabric** | Gateway API implementations | ALB |
| **ingress-nginx** | the old default Ingress controller; you'll still find it in many clusters, but it was retired in March 2026 (no more security fixes), so migrate off it | — |
| **Istio**, **Linkerd**, **Cilium** (service mesh) | mTLS between services, retries, traffic policy, per-request telemetry | VPC Lattice / ECS Service Connect (App Mesh was shut down in Sept 2026) |
| **Cilium**, **Calico** | CNI plugins with eBPF networking and NetworkPolicy | VPC CNI + security groups |
| **CoreDNS** | cluster DNS (you used it in lesson 03) | Route 53 private zones / Cloud Map |
| **cert-manager** | issue and renew TLS certificates (Let's Encrypt, AWS Private CA) as custom resources | ACM |
| **ExternalDNS** | create Route 53 records from Services/Gateways | — |

**Scaling & scheduling**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Karpenter** | node autoscaling: launches right-sized EC2 instances for pending pods, removes idle ones (originally built by AWS) | ASG + capacity-optimised EC2 Fleet |
| **Cluster Autoscaler** | the older autoscaler that resizes predefined node groups | ASG scaling |
| **KEDA** | event-driven pod autoscaling (SQS depth, Kafka lag, cron, scale to zero) | Application Auto Scaling on custom metrics |
| **VPA** | right-size requests/limits automatically | Compute Optimizer |

**Observability**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Prometheus** (+ Alertmanager) | pull-based metrics and alerting, the de facto standard | CloudWatch Metrics + Alarms |
| **Grafana** | dashboards over everything | CloudWatch dashboards |
| **OpenTelemetry** | vendor-neutral SDKs + collector for traces, metrics and logs | X-Ray SDK / ADOT |
| **Jaeger**, **Tempo** | distributed tracing backends | X-Ray |
| **Loki**, **Fluent Bit**, **Vector** | log shipping and storage | CloudWatch Logs + agent |

**Security & policy**
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **Pod Security Admission** (built in) | enforce baseline/restricted pod settings per namespace | — |
| **ValidatingAdmissionPolicy**, **MutatingAdmissionPolicy** (built in) | simple admission rules written in CEL, enforced by the API server itself (no webhook to run) | — |
| **Kyverno**, **OPA Gatekeeper** | richer admission policies ("no `latest` tags", "must have limits"), reports, image verification | SCPs / Config rules, at deploy time |
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
| **Knative** | serverless containers (scale-to-zero, revisions) | Lambda / ECS Express Mode |
| **Argo Workflows**, **Tekton** | DAG workflows / CI pipelines as pods | Step Functions / CodeBuild |
| **Kubeflow**, **Ray (KubeRay)**, **Kueue** | ML training/serving and batch queueing | SageMaker / AWS Batch |
| **Dapr** | sidecar building blocks: pub/sub, state, service invocation | SNS/SQS/DynamoDB SDK abstractions |

**Adjacent distributed-systems infrastructure** (not Kubernetes-specific, but often found next to it)
| Tool | What it is | AWS-ish analog |
|---|---|---|
| **etcd** | Raft-based consistent KV store (Kubernetes' database) | DynamoDB with strong consistency, sort of |
| **Consul**, **ZooKeeper** | service discovery, config, coordination | Cloud Map / DynamoDB locks |
| **Nomad** | HashiCorp's simpler alternative to Kubernetes | ECS |
| **Kafka**, **NATS**, **RabbitMQ**, **Pulsar** | messaging and streaming | MSK / Kinesis, SQS/SNS, Amazon MQ |
| **Vault** | secrets, dynamic credentials, PKI | Secrets Manager + AWS Private CA |
| **Temporal** | durable workflow execution | Step Functions |

[Lesson 16](../16-distributed-systems-toolbox/README.md) takes a closer look at Envoy, Istio,
Prometheus, Vault, etcd, ZooKeeper, Consul, Kafka and Temporal: what each does, how it works
inside, and how it's run in practice.

If you're going to run an EKS platform, learn these in this order: **Argo CD** (GitOps), then
**Prometheus + Grafana**, then **cert-manager + ExternalDNS**, then **Karpenter** on a real EKS
cluster. Together they cover most of what a production EKS platform runs.

## Where to go next

- **Build a real EKS cluster**: the [EKS Workshop](https://www.eksworkshop.com/) (AWS's own, very
  hands-on) and the [EKS Best Practices Guides](https://docs.aws.amazon.com/eks/latest/best-practices/introduction.html).
- **Understand the internals**: [*Kubernetes the Hard Way*](https://github.com/kelseyhightower/kubernetes-the-hard-way)
  (Kelsey Hightower), where you bootstrap every component by hand.
- **Write a real operator**: the [Kubebuilder book](https://book.kubebuilder.io/).
- **Certify**: CKAD (developer-focused, very hands-on) or CKA (operations).
- **Read**: *Kubernetes Patterns* (Ibryam & Huß) and *Production Kubernetes* (Rosso et al.).
