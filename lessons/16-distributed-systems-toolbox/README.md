# 16 — The distributed-systems toolbox

An overview of the infrastructure software you'll keep running into around Kubernetes:
**Envoy, Istio, Prometheus, Vault, etcd, ZooKeeper, Consul, Kafka and Temporal**, plus a
short list of others. For each one: what it is, the mental model, a few internals worth
knowing, use cases, the AWS equivalent, and how it's run in practice. Most sections end
with an optional 5–10 minute **Try it** on the lab cluster.

This is a map, not a deep dive. The goal is that when someone says "we put it on Kafka and
Temporal behind Istio, with secrets from Vault", you know what each piece does and why it's
there.

---

## Part 1: how this stuff is actually run

On AWS you rarely think about it: you create a resource in your account and AWS runs it.
Outside AWS's managed services, *someone* has to run the software, and there are four
common ways to do it. Most companies use a mix.

```
 less ops work, less control                                       more ops work, more control
 ◀──────────────────────────────────────────────────────────────────────────────────────────▶
 ┌──────────────────┐ ┌──────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
 │ 1. Cloud-managed │ │ 2. Vendor SaaS   │ │ 3. Self-run on          │ │ 4. Self-run on VMs /    │
 │                  │ │                  │ │    Kubernetes           │ │    bare metal           │
 │ MSK, Amazon      │ │ Confluent Cloud, │ │ Helm charts + operators │ │ Terraform creates EC2 / │
 │ Managed Service  │ │ Temporal Cloud,  │ │ (Strimzi, Vault Helm,   │ │ vSphere VMs; Ansible or │
 │ for Prometheus,  │ │ HCP Vault,       │ │ istioctl, kube-         │ │ Packer images install   │
 │ Secrets Manager  │ │ Grafana Cloud    │ │ prometheus-stack...)    │ │ the software as systemd │
 │                  │ │                  │ │ on EKS or on-prem K8s   │ │ services                │
 └──────────────────┘ └──────────────────┘ └─────────────────────────┘ └─────────────────────────┘
  You: config, IAM     You: config, a       You: upgrades, scaling,     You: all of that, plus
                       bill, a network      backups, on-call, but       the OS, disks, network,
                       link (PrivateLink)   K8s does placement,         failure replacement
                                            healing, rollouts
```

1. **Cloud-managed**: the default choice on AWS when a service exists and fits. MSK is
   Kafka, Amazon Managed Service for Prometheus (AMP) is Prometheus, and so on.
2. **Vendor SaaS**: the company behind the open-source project runs it for you, usually in
   your preferred cloud region, connected over PrivateLink or VPC peering. You pay a premium
   and get the vendor's expertise and newest features.
3. **Self-run on Kubernetes**: very common for platform teams today. The Kubernetes
   primitives from this course (StatefulSets, PVCs, PDBs, anti-affinity) plus an
   **operator** that encodes the runbook: "to upgrade Kafka, roll brokers one at a time and
   wait for in-sync replicas". You just learned everything this needs.
4. **Self-run on VMs**: the classic approach, and still common for big stateful systems
   (large Kafka and ZooKeeper clusters, Vault, Consul). Something like: Terraform creates 3 or 5
   instances across AZs, a Packer-built image or Ansible installs the binary and a systemd
   unit, a load balancer or DNS name goes in front, and Prometheus plus alerting watch it.
   Replacing a dead node is a runbook (or an ASG plus automation).

**So yes, "rent a few machines and deploy it" is option 4.** On AWS the machines are EC2
instances. On-prem, they're servers you own.

### What "on-prem" actually means

"On-prem" means running your own servers, either in your own data centre or in rented space
in a colocation facility (Equinix and similar), where you rent power, cooling and network
and bring your own racks. Without AWS, every layer AWS gave you needs a substitute:

| AWS gives you | On-prem equivalent |
|---|---|
| EC2 | a virtualisation platform: **VMware vSphere**, **OpenStack**, **Proxmox**, or Kubernetes directly on bare metal; bare-metal provisioning with PXE boot, **MAAS**, **Tinkerbell** |
| EBS / S3 | SAN/NAS appliances (NetApp, Pure), or **Ceph** (block + object), **MinIO** (S3 API) |
| ELB | hardware or software load balancers: **F5**, **HAProxy**, **Envoy**; **MetalLB** for Kubernetes `LoadBalancer` Services |
| VPC, security groups | physical network gear, VLANs, firewalls; **Cilium/Calico** NetworkPolicies |
| IAM | **Active Directory / LDAP**, an OIDC provider (Keycloak, Okta), plus **Vault** for workload secrets |
| Route 53 / Cloud Map | internal DNS (BIND, Infoblox), **Consul** |
| CloudWatch | **Prometheus + Grafana + Loki**, or a vendor (Datadog…) |
| Managed Kafka, databases | you run them yourself (see above) |
| The AWS console | a **platform team** that operates all of this and offers it to product teams, often through an internal developer portal (e.g. **Backstage**) |

That's why tools like Vault and Consul exist: they provide AWS-like capabilities
(secrets, identity, service discovery) in environments that don't have them, and
*consistently across* environments (on-prem + AWS + GCP). Large companies are very often
**hybrid**: some data centres, some cloud, plus a platform team stitching them together.

### A rule of thumb for AWS shops

Use the managed service unless you have a concrete reason not to. Common reasons:
cost at large scale (MSK vs self-run Kafka on EC2 or EKS can differ a lot), features the
managed version lacks, a multi-cloud or hybrid requirement, or data-residency rules. Every
self-run stateful system means upgrades, backups, capacity planning and a pager rotation.

---

## Part 2: the big picture

A plausible e-commerce backend on EKS, showing where each tool sits:

```
                    ┌───────────────────────── Kubernetes cluster ─────────────────────────┐
  users ──▶ NLB ──▶ │ Envoy (edge gateway)                                                 │
                    │    │                                                                 │
                    │    ▼            Istio: every pod has an Envoy sidecar (or ambient    │
                    │ ┌─────────┐ mTLS ┌──────────┐    ztunnel); istiod pushes config and  │
                    │ │ orders  │─────▶│ payments │    certificates to all of them         │
                    │ └─┬──┬──┬─┘      └────┬─────┘                                        │
                    │   │  │  │             │                                              │
                    │   │  │  └─ start workflow ─▶ Temporal ──▶ workers: reserve stock,    │
                    │   │  │                                    charge, ship, email        │
                    │   │  └── publish "OrderPlaced" ─▶ Kafka ──▶ analytics, search index, │
                    │   │                                         fraud, data lake         │
                    │   └──── DB creds (dynamic, 1h TTL) ◀── Vault ◀── auth: K8s SA token  │
                    │                                                                      │
                    │  Prometheus scrapes /metrics from everything ──▶ Grafana, alerts     │
                    │  etcd: Kubernetes' own database (you never touch it)                 │
                    └──────────────────────────────────────────────────────────────────────┘
       Consul: service discovery + mesh spanning this cluster AND the legacy VMs on-prem
       ZooKeeper: only if something old needs it (older Kafka, HBase, Solr, Hadoop)
```

Two patterns show up again and again:

- **Control plane vs data plane.** A central brain decides, and many distributed agents
  do the work: Kubernetes (API server vs kubelets), Istio (istiod vs Envoys), Consul
  (servers vs agents). When the control plane is down, the data plane keeps running on its
  last known config.
- **A small, strongly consistent core.** Almost every system here has, at its centre, a
  replicated log agreed on by a consensus protocol. That's worth understanding once, next.

### Consensus in one screen

etcd, Consul servers, Vault (integrated storage) and Kafka's KRaft controllers all use
**Raft**. ZooKeeper uses **ZAB**, a close cousin. Temporal hands this job to its database.

```
   client write ──▶ leader ──append entry──▶ follower 1   ✔
                      │     ──append entry──▶ follower 2   ✔  majority (2 of 3) acked → committed
                      ▼                                        → apply to state machine → reply
                   log: [1 put a=1][2 put b=2][3 del a]...
```

- A cluster of **N = 2f + 1** nodes tolerates **f** failures: 3 nodes survive 1 failure,
  5 survive 2. A 4-node cluster survives only 1, and 2 nodes survive *none* (each needs
  the other), so always use odd numbers, typically 3 or 5.
- Every write needs a round trip to a majority. Keep members close (the AZs of one region,
  not across continents), and don't expect these systems to absorb huge write volumes.
  They store small, critical data: configuration, membership, leadership, metadata.
- If you lose the majority, the cluster stops accepting writes rather than risk
  split-brain. In CAP terms these are **CP** systems.
- The AWS parallel: this is what's inside DynamoDB (Paxos), Aurora's storage quorum, and
  every other AWS service that needs strong consistency. On AWS you consume it. With these
  tools, you *run* it.

---

## Part 3: the tools

Set up the playground once (single-node dev instances, [toolbox.yaml](toolbox.yaml)):

```bash
cd lessons/16-distributed-systems-toolbox
kubectl apply -f toolbox.yaml
kubectl apply -f metrics-demo.yaml       # the kubelab app + a traffic generator (used by Envoy & Prometheus)
kubectl -n toolbox wait --for=condition=Ready pod --all --timeout=180s
```

### Envoy: the programmable proxy

**What:** a high-performance L4/L7 proxy written in C++ (created at Lyft, open-sourced in
2016). It's the data plane under Istio, Envoy Gateway, Consul's mesh, AWS App Mesh
(discontinued September 2026), Contour and more. When people say "the mesh does retries"
or "the gateway does canaries", Envoy is usually what's executing it.

**Mental model:** a request flows through **listener → filter chain → route → cluster →
endpoint**. Listeners bind ports. Filters (TLS, HTTP parsing, auth, rate limiting,
Wasm/Lua extensions) process the connection and requests. The route table picks a
**cluster** (a named group of upstream endpoints, like a target group), and the
cluster's load balancer picks an endpoint.

**Worth knowing:**
- **xDS APIs** (LDS/RDS/CDS/EDS/SDS for listeners, routes, clusters, endpoints and secrets):
  config streams in over gRPC from a control plane and applies *without restarts* or
  dropped connections. That's what made Envoy the universal data plane: anyone can write a
  control plane for it.
- Threading: one main thread plus N worker threads, each with its own event loop. A
  connection stays on one worker for life, so the hot path needs almost no locking.
- Resilience is built in: retries with budgets, timeouts, **outlier detection** (eject
  endpoints that keep failing), circuit breakers (caps on connections and pending requests),
  and rate limiting.
- Very detailed stats (thousands of counters) and an admin API on each proxy (`/config_dump`, `/clusters`, `/stats/prometheus`).

**Use cases:** edge/API gateway, service-mesh sidecar, gRPC proxying and transcoding,
TLS termination, traffic shifting. **AWS analog:** roughly what's inside an ALB, plus App
Mesh / VPC Lattice. **How it's run:** almost never by hand. Istio, Envoy Gateway or Consul
generate its config. Lesson 09 used Envoy through Envoy Gateway.

**Try it:** a standalone Envoy with a hand-written static config. Read [envoy.yaml](envoy.yaml) first.

```bash
kubectl apply -f envoy.yaml
kubectl -n toolbox wait --for=condition=Ready pod/envoy
kubectl -n toolbox port-forward pod/envoy 10000:10000 9901:9901 &

curl -s localhost:10000/hello                                 # answered by Envoy itself
for i in 1 2 3 4; do curl -s localhost:10000/app/ | grep '"pod"'; done   # round-robin across both pods
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:10000/app/?delay=2'  # 504: route timeout is 1s

curl -s localhost:9901/clusters | grep metrics_demo | grep -E 'rq_total|health_flags'
curl -s localhost:9901/stats | grep -E 'cluster.metrics_demo.upstream_rq_(total|2xx|timeout)'
curl -s localhost:9901/config_dump | jq -r '.configs[]."@type"'   # listeners, routes, clusters...
kill %1
```

### Istio: the service mesh

**What:** a service mesh. It moves networking concerns out of application code and into
the platform: **mTLS between all services, fine-grained traffic control, retries/timeouts,
and uniform telemetry**, with no code changes.

**Mental model:** **istiod** (the control plane) watches Kubernetes and Istio CRDs,
compiles them into Envoy config, and pushes it over xDS to the data plane. It also acts as a
certificate authority, issuing each workload a short-lived certificate tied to its
ServiceAccount (a SPIFFE identity like `spiffe://cluster.local/ns/shop/sa/orders`).
Two data-plane modes:

- **Sidecar mode** (classic): an Envoy container injected into every pod. Traffic is
  redirected into it with iptables. It's powerful, but costs CPU and memory per pod and adds
  latency on every hop.
- **Ambient mode** (GA since late 2024): a per-node **ztunnel** (a lightweight Rust
  proxy) handles mTLS and L4, and optional per-namespace **waypoint** Envoys handle L7. It's
  cheaper, with no sidecars to inject or restart.

**Worth knowing:** the key CRDs are `PeerAuthentication` (require mTLS),
`AuthorizationPolicy` (which identity may call which service: "zero trust" by
ServiceAccount, not IP), `VirtualService`/`DestinationRule` (routing, retries, subsets),
and increasingly the standard Gateway API (lesson 09). A mesh is also *the* answer to
"which service calls which, and with what latency?", because every hop emits metrics and
traces.

**Use cases:** compliance-driven encryption in transit, zero-trust between services,
canaries and fault injection, multi-cluster traffic. **Costs:** operational complexity
(it's a distributed system in its own right), upgrades, and harder debugging when the
mesh itself misbehaves. Many teams adopt it only when they have a concrete need.
Alternatives: **Linkerd** (simpler, Rust proxy), **Cilium** (eBPF-based, in the kernel).
**AWS analog:** VPC Lattice plus App Mesh (discontinued). **How it's run:** installed per
cluster with `istioctl` or Helm, and upgraded carefully with revision-based canary
upgrades of the control plane.

### Prometheus: metrics and alerting

**What:** a time-series database plus a query language (PromQL) plus an alerting engine,
and the de facto standard for metrics in the Kubernetes world. It came out of SoundCloud in
2012, inspired by Google's Borgmon, and was the second CNCF project after Kubernetes.

**Mental model:** **pull-based**. Services expose `GET /metrics` in a simple text format,
and Prometheus discovers targets (from the Kubernetes API, EC2 API, Consul…) and
**scrapes** them every 15–60s. Each series is identified by a metric name plus labels,
such as `http_requests_total{service="orders",code="500"}`. Metric types are **counter**
(only goes up; always query it with `rate()`), **gauge**, **histogram** (buckets, which
give you percentiles across pods) and summary.

**Worth knowing:**
- Storage: an append-only, heavily compressed local TSDB (about 1–2 bytes per sample, using
  Gorilla-style delta-of-delta and XOR encoding), cut into 2-hour blocks plus a WAL.
  A single server is deliberately *not* clustered. For HA you run two identical ones, and for
  long retention and a global view you add **Thanos** or **Grafana Mimir**, or remote-write
  to a managed service.
- **Cardinality is the #1 way to kill it.** Every unique label combination is a new
  series, so never put user IDs, request IDs or raw URLs in labels. (The kubelab app
  normalises unknown paths to `other` for exactly this reason. See
  [server.py](../../app/server.py).)
- **Alertmanager** receives firing alerts and deduplicates, groups, silences and routes
  them (PagerDuty, Slack). Alert rules are PromQL expressions.
- It's for *metrics*: aggregated numbers. Not logs, not per-request traces, and not
  billing-grade exact counts.
- The **Prometheus Operator** / kube-prometheus-stack adds CRDs (`ServiceMonitor`,
  `PodMonitor`, `PrometheusRule`), which is how most EKS clusters run it.

**AWS analog:** CloudWatch Metrics + Alarms (push-based). Amazon Managed Service for
Prometheus runs the storage/query side for you, and you keep scraping in-cluster.
**How it's run:** one Prometheus per cluster (Helm or operator), plus Grafana, plus Thanos
or Mimir or AMP for the long-term, multi-cluster view.

**Try it:**

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prom prometheus-community/prometheus -n monitoring --create-namespace \
  --set alertmanager.enabled=false --set prometheus-pushgateway.enabled=false \
  --set server.persistentVolume.enabled=false --wait

kubectl -n toolbox exec deploy/metrics-demo -- curl -s localhost:8080/metrics   # the raw format
kubectl get --raw /metrics | grep '^apiserver_request_total' | head -3          # Kubernetes itself speaks it too

kubectl -n monitoring port-forward svc/prom-prometheus-server 9090:80 &
```

Wait about 2 minutes (it scrapes once a minute and `rate()` needs two samples), then query:

```bash
q() { curl -s localhost:9090/api/v1/query --data-urlencode "query=$1" | jq -r '.data.result[] | "\(.metric | del(.__name__) | tostring)  \(.value[1])"'; }
q 'up{namespace="toolbox"}'                                                         # is each target reachable?
q 'sum by (path, code) (rate(kubelab_http_requests_total[5m]))'                     # requests/sec by path and status
q 'histogram_quantile(0.99, sum by (le) (rate(kubelab_http_request_duration_seconds_bucket[5m])))'  # p99 latency
q 'sum by (namespace) (kube_pod_info)'                                              # pods per namespace (kube-state-metrics)
q 'sum by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m]))'             # CPU cores busy per node (node-exporter)
kill %1
```

For the UI, run `amp orb service start prometheus --port 9090 --portal --command 'kubectl -n monitoring port-forward svc/prom-prometheus-server $PORT:80'`
and open the URL it prints.

### Vault: secrets, identity and encryption

**What:** a secrets-management server from HashiCorp. It's much more than a key/value
store for passwords. Its killer features are **dynamic secrets** and **encryption as a service**.

**Mental model:** everything is a **path**, mounted on a **secrets engine**:

- `kv/`: static secrets (versioned key/value).
- `database/`: **dynamic credentials**. `vault read database/creds/orders-ro` makes Vault
  create a brand-new database user with a 1-hour **lease**, and drop it when the lease
  expires. Nothing long-lived to leak or rotate.
- `pki/`: Vault is a certificate authority that issues short-lived TLS certificates.
- `transit/`: encrypt/decrypt/sign on request. Apps never hold the key (think KMS `Encrypt`/`Decrypt`).
- `aws/`: generate short-lived IAM credentials.

Clients log in with an **auth method** (a Kubernetes ServiceAccount token, AWS IAM, OIDC,
AppRole) and get a **token** carrying **policies** (paths plus capabilities like `read`,
`create`). It's IAM-style, for secrets.

**Worth knowing:**
- **Seal/unseal:** all data is encrypted with a key that's itself encrypted by a root key.
  At startup Vault is *sealed* and can't read its own storage until unsealed, either by a
  quorum of operators entering **Shamir key shares** (by default 3 of 5), or automatically
  with **auto-unseal** via AWS KMS / HSM (what everyone does in practice).
- HA via **integrated storage (Raft)**: 3 or 5 nodes, one active, the others standby.
- Every request is written to audit logs, which is a big reason security teams like it.
- Licensing: HashiCorp moved to the BSL licence in 2023 (IBM acquired the company in 2025),
  and **OpenBao** is the community fork under the Linux Foundation.
- Kubernetes integration: the **Vault Secrets Operator** (syncs into Secrets), the Agent
  Injector (a sidecar that writes secrets to files), or the CSI provider.

**Use cases:** hybrid or multi-cloud secrets, dynamic DB credentials, an internal PKI for
mTLS, encryption of sensitive fields (card data, PII). **AWS analog:** Secrets Manager +
KMS + ACM Private CA + STS, unified. On pure AWS those are usually enough. Vault earns its
place in hybrid and multi-cloud setups, or where dynamic secrets are required.
**How it's run:** a 3- or 5-node Raft cluster on VMs or Kubernetes (official Helm chart),
KMS auto-unseal, behind a load balancer, often run by a security/platform team as a
company-wide service. Or HCP Vault Dedicated (managed by HashiCorp).

**Try it:**

```bash
V="kubectl -n toolbox exec vault -- vault"
$V status                                             # Sealed: false (dev mode auto-unseals), Storage: inmem
$V kv put secret/myapp db_password=hunter2
$V kv get secret/myapp                                # versioned

# Encryption as a service: the app never sees the key
$V secrets enable transit
$V write -f transit/keys/orders
CT=$($V write -field=ciphertext transit/encrypt/orders plaintext=$(echo -n '4111-1111-1111-1111' | base64)); echo "$CT"
$V write -field=plaintext transit/decrypt/orders ciphertext=$CT | base64 -d; echo

# Least privilege: a token that can only read one path
kubectl -n toolbox exec -i vault -- sh <<'EOF'
vault policy write myapp-read - <<POLICY
path "secret/data/myapp" { capabilities = ["read"] }
POLICY
T=$(vault token create -policy=myapp-read -ttl=10m -field=token)
VAULT_TOKEN=$T vault kv get -field=db_password secret/myapp; echo
VAULT_TOKEN=$T vault kv put secret/myapp db_password=pwned   # permission denied
EOF
```

### etcd: the consistent key-value store you already run

**What:** a Raft-based, strongly consistent key-value store (from CoreOS). It's
**Kubernetes' database**: every object you've created in this course lives here.

**Mental model:** a flat, ordered keyspace with **MVCC**. Every change gets a
cluster-wide increasing **revision**, you can read "as of" a revision, and a **watch** can
stream every change after revision N. The Kubernetes API server's watches (which drive
every controller) are built directly on etcd watches. **Leases** (TTL'd keys) support
leader election and liveness.

**Worth knowing:** keep it small and fast. The default quota is 2 GB and around 8 GB is the
recommended maximum, because it's metadata storage, not a general database. Disk fsync
latency makes or breaks it, which is why control-plane nodes need fast SSDs. On EKS it's
fully hidden and managed by AWS.

**Try it:** look at Kubernetes' raw storage.

```bash
E="kubectl -n kube-system exec etcd-lab-control-plane -- etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key"
$E member list -w table
$E endpoint status -w table                 # leader, Raft term/index, DB size
$E get /registry/namespaces --prefix --keys-only
$E get / --prefix --keys-only | grep -c .   # every object in the cluster
```

Watch it the way a controller would. Run this in one terminal:

```bash
$E watch --prefix /registry/configmaps/toolbox/ -w json | jq -r '.Events[] | "\(if .type == 1 then "DELETE" else "PUT" end) \(.kv.key | @base64d) rev=\(.kv.mod_revision)"'
```

and in another:

```bash
kubectl -n toolbox create configmap watched --from-literal=color=blue
kubectl -n toolbox patch configmap watched -p '{"data":{"color":"green"}}'
kubectl -n toolbox delete configmap watched
```

You'll see PUT, PUT, DELETE, each with a new revision.

### ZooKeeper: the original coordination service

**What:** Apache ZooKeeper (from Yahoo, inspired by Google's Chubby paper) is a replicated,
strongly consistent store for *coordination*: leader election, locks, group membership,
configuration. For a decade it was the thing every distributed system leaned on (Hadoop,
HBase, Kafka, Solr, Storm, Mesos).

**Mental model:** a tree of **znodes**, like a filesystem, each holding a small blob
(< 1 MB, usually bytes). Three primitives make it powerful:

- **Ephemeral znodes** are deleted automatically when the client's session ends. If a
  process dies, its session times out and its node disappears. That's failure detection
  for free.
- **Sequential znodes** get an auto-incrementing suffix (`candidate-0000000007`), which
  gives you a total order.
- **Watches** are one-shot notifications when a node or its children change.

**Leader election recipe:** everyone creates an ephemeral sequential node under `/election`,
and the lowest number is leader. Everyone else watches *the node just before theirs*, which
avoids a thundering herd. When the leader dies, its node vanishes and the next in line is
notified.

**Worth knowing:** consensus via **ZAB**. Writes go through the leader and are
linearizable, while reads are served locally by any node (fast, possibly stale; `sync`
first if that matters). **Apache Curator** is the Java library that implements the recipes
correctly. It's legacy-ish now: **Kafka 4.0 (2025) dropped ZooKeeper** for its own Raft
(KRaft), and new systems tend to embed Raft or use etcd. You'll still meet it in older
Kafka, HBase, Solr and Hadoop clusters.
**AWS analog:** nothing direct. The closest are DynamoDB conditional writes / lock clients.
**How it's run:** a 3- or 5-node "ensemble" on VMs or a StatefulSet, usually bundled with
whatever needs it.

**Try it:** ephemeral nodes and watches. Open **two** terminals with the ZooKeeper shell:

```bash
kubectl -n toolbox exec -it zk -- zkCli.sh      # in both terminals
```

Terminal A:

```
create /election ""
create -s -e /election/candidate- node-a      # ephemeral + sequential
```

Terminal B:

```
ls -w /election                               # see candidate-0000000000, and set a watch
```

Terminal A: type `quit`. Terminal B immediately gets `WatchedEvent ... NodeChildrenChanged`,
and `ls /election` is now empty. That's how "the leader died, elect a new one" works.
Watches are **one-shot**: after firing, the client has to re-read and set a new watch (and
may miss intermediate changes in between, so it re-reads state rather than trusting events). (If a
client *crashes* instead of quitting cleanly, the node lingers until the session timeout,
30s here. That timeout is the failure detector.)

### Consul: service discovery and mesh across everything

**What:** HashiCorp Consul does **service discovery with health checking**, a **KV store**,
and a **service mesh**. Its selling point is that it spans *everything*: VMs, bare metal,
multiple Kubernetes clusters, multiple data centres and clouds.

**Mental model:** 3 or 5 **servers** (Raft, holding the catalog and KV) plus an **agent** on
every node. Agents register local services, run their health checks, and form a **gossip**
pool (Serf, a SWIM-based protocol) for membership and failure detection that scales to
thousands of nodes without hammering the servers. Services are found through **DNS**
(`orders.service.consul`, returning only healthy instances) or the HTTP API. **Consul
Connect** is the mesh: Envoy sidecars plus mTLS plus **intentions** ("web may call orders").

**Worth knowing:** within a single Kubernetes cluster you mostly *don't* need it.
Kubernetes Services, CoreDNS and etcd already do discovery. Consul earns its keep when
workloads live outside Kubernetes, or across many clusters and data centres (WAN
federation / cluster peering). It was historically also Vault's storage backend. It's under
the same BSL licensing situation as Vault.
**AWS analog:** Cloud Map + Route 53 health checks + (retired) App Mesh / VPC Lattice + AppConfig.
**How it's run:** servers on VMs or Kubernetes (Helm chart), and agents on every VM or as a
DaemonSet. Usually a platform team runs it next to Vault and Nomad (the "HashiStack").

**Try it:**

```bash
C="kubectl -n toolbox exec consul -- consul"
$C members                                                    # the gossip pool (just 1 node here)
$C services register -name=orders -port=8080 -address=10.0.0.5 -tag=v1
$C services register -name=orders -id=orders-2 -port=8080 -address=10.0.0.6 -tag=v2
$C catalog services -tags
kubectl -n toolbox exec consul -- nslookup -port=8600 orders.service.consul 127.0.0.1   # DNS-based discovery
$C kv put config/orders/max_conns 100
$C kv get config/orders/max_conns
```

In real life, services register themselves through the local agent, which runs health checks
and takes failing instances out of DNS automatically.

### Kafka: the distributed commit log

**What:** Apache Kafka (from LinkedIn, 2011; Confluent is the company behind it) is a
distributed, replicated, **append-only log**. It's the backbone for event streaming:
services publish facts ("OrderPlaced"), and any number of consumers read them at their own pace.

**Mental model:**

```
topic "orders" (3 partitions, replication factor 3)
  partition 0: [0][1][2][3][4][5]...  ◀── appends go to the end; each record has an offset
  partition 1: [0][1][2]...
  partition 2: [0][1][2][3]...
                     ▲          ▲
  consumer group "billing":    reads at its own offset (committed back to Kafka)
  consumer group "analytics":  independent offsets, can replay from 0
```

- A record's **key** picks its partition (by hash), so **ordering is guaranteed only
  within a partition**. Key by `customer_id` and each customer's events stay in order.
- **Consumer groups:** each partition is read by exactly one member of a group, so
  parallelism is capped at the partition count. Extra consumers sit idle. Choose the
  partition count with future throughput in mind.
- Messages aren't deleted when read. **Retention** is by time or size (or forever with
  **log compaction**, which keeps the latest value per key). New consumers can replay
  history, which is the big difference from a queue.

**Worth knowing:**
- It's fast because of sequential disk I/O, the OS page cache, zero-copy `sendfile`,
  batching and compression, rather than anything clever in memory.
- Durability: each partition has a leader and followers, and the **ISR** (in-sync replicas)
  set. With `acks=all` and `min.insync.replicas=2` at RF=3, an acknowledged write survives
  losing a broker.
- Delivery is at-least-once by default. Idempotent producers plus transactions give
  exactly-once *within Kafka* (consume → process → produce). Make external side effects idempotent.
- **KRaft:** since 4.0, Kafka's metadata lives in a built-in Raft quorum of controllers,
  so no ZooKeeper.
- The ecosystem: **Kafka Connect** (source and sink connectors), **Debezium** (change data
  capture from databases), **Kafka Streams** / **Flink** (stream processing), Schema Registry
  (Avro/Protobuf contracts).

**Use cases:** event-driven microservices, CDC pipelines, feeding data lakes and search
indexes, activity tracking, log aggregation, event sourcing.
**AWS analog:** **MSK** (managed Kafka) or **Kinesis Data Streams** (shards ≈ partitions,
same log model). It's *not* SQS: SQS is a queue where each message goes to one consumer,
is deleted on ack, can't be replayed, and has no partitions to size. Use SQS for work
distribution, and Kafka/Kinesis for event streams many consumers need.
**How it's run:** 3+ brokers across AZs plus 3 KRaft controllers, on VMs or with the
**Strimzi** operator on Kubernetes (Kafka as CRDs). Or MSK / Confluent Cloud. Also look at
**Redpanda** (Kafka-API compatible, C++) and **WarpStream**-style "brokers on S3" designs.

**Try it:** partitions, keys, offsets and consumer groups.

```bash
K="kubectl -n toolbox exec -i kafka -- /opt/kafka/bin"
$K/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic orders --partitions 3
$K/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic orders

# Produce keyed records ("key:value")
printf 'alice:order-1\nbob:order-2\nalice:order-3\ncarol:order-4\nbob:order-5\n' | \
  $K/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic orders \
  --reader-property parse.key=true --reader-property key.separator=:

# Consume as group "billing": note each key always lands in the same partition, in order
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders --group billing \
  --from-beginning --max-messages 5 --formatter-property print.key=true \
  --formatter-property print.partition=true --formatter-property print.offset=true

$K/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group billing   # offsets & lag

# (a console consumer with --max-messages exits once it has read that many)
# Produce two more, then consume again as "billing": only the NEW records (it remembers its offset)
printf 'dave:order-6\nalice:order-7\n' | $K/kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic orders --reader-property parse.key=true --reader-property key.separator=:
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders --group billing --max-messages 2

# A different group replays everything from the start: the log wasn't consumed away.
# Note the order: per-key (per-partition) order holds, but there's no global order across partitions.
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders --group analytics \
  --from-beginning --max-messages 7
```

### Temporal: durable execution for workflows

**What:** a platform for **durable execution**. You write long-running business
processes as *ordinary code* (Go, Java, TypeScript, Python, .NET), and Temporal guarantees
the code runs to completion despite crashes, deploys, timeouts and outages, even if it takes
months. It was forked in 2019 from Uber's **Cadence** by its creators, one of whom had
earlier led the design of **AWS Simple Workflow (SWF)**.

**Mental model:** the split is between **workflows** and **activities**.

```go
func OrderWorkflow(ctx workflow.Context, order Order) error {
    ao := workflow.ActivityOptions{StartToCloseTimeout: time.Minute}   // + automatic retries
    ctx = workflow.WithActivityOptions(ctx, ao)

    if err := workflow.ExecuteActivity(ctx, ReserveStock, order).Get(ctx, nil); err != nil {
        return err
    }
    if err := workflow.ExecuteActivity(ctx, ChargeCard, order).Get(ctx, nil); err != nil {
        workflow.ExecuteActivity(ctx, ReleaseStock, order)   // saga compensation
        return err
    }
    workflow.Sleep(ctx, 14*24*time.Hour)                     // yes, really: sleep two weeks
    return workflow.ExecuteActivity(ctx, AskForReview, order).Get(ctx, nil)
}
```

- **Activities** do the side effects (API calls, DB writes), with timeouts and retry policies.
- **Workflow code** must be **deterministic**: no direct I/O, clocks or randomness (use
  SDK APIs instead). Temporal records every step's result in an **event history**. If a
  worker dies mid-workflow, another worker **replays** the history through the same code to
  rebuild its exact state (completed activities aren't re-run, their recorded results are
  reused) and carries on.
- Workflows can receive **signals** (e.g. "customer cancelled"), answer **queries**, and wait on timers for as long as needed.

**Worth knowing:** the Temporal *server* (frontend, history, matching and worker services)
stores state in **Cassandra, PostgreSQL or MySQL**, and your code runs in *your* **worker**
processes, which long-poll task queues. Temporal never runs your code. Deploying new
workflow code while old executions are in flight needs **versioning** care (replay must
still be deterministic). Histories are capped (around 50k events), so very long-lived
workflows use *continue-as-new*.

**Use cases:** order fulfilment and payments, sagas across microservices,
infrastructure provisioning, user onboarding and subscription lifecycles, human approval
steps, and increasingly orchestration of AI agents.
**AWS analog:** **Step Functions** (a state machine defined in JSON/ASL vs. Temporal's
workflows-as-code) and the older SWF. **Kafka vs Temporal:** Kafka is *choreography*
(services react to each other's events, and nobody owns the whole process). Temporal is
*orchestration* (one piece of code owns the process, its state and its error handling). Big
systems often use both.
**How it's run:** **Temporal Cloud** (SaaS), or self-hosted on Kubernetes with the Helm
chart plus a managed Postgres (RDS/Aurora). Workers are just your Deployments.

**Try it** (off-cluster): the official tutorials at <https://learn.temporal.io> get a local
dev server (`temporal server start-dev`) and a first workflow running in about 15 minutes,
and they're worth doing to *feel* replay. Kill the worker mid-workflow and watch it resume.

---

## Part 4: others worth knowing (one line each)

| Tool | What it is | AWS analog |
|---|---|---|
| **OpenTelemetry** | vendor-neutral SDKs + collector for traces, metrics and logs. Instrument once, send anywhere | ADOT / X-Ray SDK |
| **Grafana** (+ **Loki**, **Tempo**, **Mimir**) | dashboards, plus logs / traces / long-term metrics backends from the same vendor | CloudWatch dashboards, Logs, X-Ray |
| **Jaeger** | distributed tracing backend and UI | X-Ray |
| **Linkerd** | a simpler, lighter service mesh than Istio | — |
| **Cilium** | eBPF-based CNI: networking, NetworkPolicy, observability (Hubble), even mesh, in the kernel | VPC CNI + SGs |
| **NATS** (+ JetStream) | very lightweight pub/sub and request-reply, with optional persistence | SNS/SQS-ish |
| **RabbitMQ** | classic message broker: queues, routing, per-message acks | Amazon MQ, SQS |
| **Redpanda**, **Pulsar** | Kafka alternatives (Kafka-compatible C++ / tiered, multi-tenant) | MSK, Kinesis |
| **Debezium** | turns database changelogs (binlog/WAL) into Kafka events (CDC) | DMS CDC |
| **Flink** | stateful stream processing with exactly-once state | Managed Service for Apache Flink |
| **Redis / Valkey** | in-memory data structures: cache, rate limits, queues, locks | ElastiCache / MemoryDB |
| **CockroachDB**, **TiDB**, **YugabyteDB** | distributed SQL on Raft, Spanner-style | Aurora DSQL, Spanner-like |
| **Cassandra / ScyllaDB** | leaderless, wide-column, eventually consistent, tunable quorum | Keyspaces, DynamoDB |
| **SPIFFE / SPIRE** | standard workload identities (what Istio's certificates are) | IAM roles for workloads |
| **OpenBao** | open-source fork of Vault | — |
| **Nomad** | HashiCorp's simpler scheduler, a Kubernetes alternative | ECS |
| **Argo Workflows / Airflow** | DAG/batch orchestration (data pipelines), vs Temporal's application workflows | Step Functions, MWAA |

## Part 5: choosing between the overlapping ones

| Question | Short answer |
|---|---|
| Istio or Consul for a mesh? | All-Kubernetes: Istio (or Linkerd, Cilium). Many VMs + clusters + data centres: Consul. On AWS, first ask whether VPC Lattice or plain mTLS in apps would do. |
| etcd, ZooKeeper or Consul for coordination? | Don't build on them unless you must. If you must: etcd (modern, simple API, Raft), ZooKeeper only where the ecosystem requires it, Consul if you also want discovery and health checks. On AWS, DynamoDB conditional writes cover many lock/lease needs. |
| Kafka, Kinesis, SQS/SNS or RabbitMQ? | Many consumers, replay, ordering per key, streams: Kafka/MSK or Kinesis. Distributing work items: SQS. Fan-out notifications: SNS (+SQS). Complex routing, request/reply: RabbitMQ. |
| Temporal or Step Functions? | Step Functions for AWS-native glue with visual state machines and less code. Temporal for complex, long-running business logic you want as testable code, or outside AWS. |
| Vault or Secrets Manager? | AWS-only: Secrets Manager + KMS (+ ACM PCA). Hybrid or multi-cloud, dynamic DB credentials everywhere, or one audited secrets plane: Vault. |
| Prometheus or CloudWatch? | On Kubernetes, Prometheus-format metrics are the lingua franca (every chart exposes them). Store them in AMP or self-run with Thanos/Mimir. CloudWatch remains the place for AWS-service metrics. Many shops use both, with Grafana on top. |

## Clean up

```bash
kubectl delete namespace toolbox
helm uninstall prom -n monitoring && kubectl delete namespace monitoring
```
