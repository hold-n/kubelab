# 16 — The distributed-systems toolbox

Sooner or later someone will say "we put it on Kafka and Temporal behind Istio, with secrets
from Vault" as if that were a complete sentence. This lesson makes it one. It's a map, not a
deep dive, of the infrastructure software you'll keep meeting around Kubernetes: **Envoy,
Istio, Prometheus, Vault, etcd, ZooKeeper, Consul, Kafka and Temporal**, plus a few others.

For each: the mental model, the internals worth knowing, the AWS equivalent, and how it's
run in practice. Most end with an optional 5–10 minute **Try it** on the lab cluster.

---

## Part 1: how this stuff is actually run

On AWS you create a resource and AWS runs it. Step outside the managed services and
*someone* has to run the software. There are four ways to do it, and most companies use all
four somewhere.

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

1. **Cloud-managed:** the AWS default when a service exists and fits (MSK is Kafka, AMP is
   Prometheus).
2. **Vendor SaaS:** the company behind the project runs it in your region, reached over
   PrivateLink or peering. You pay a premium for their expertise and newest features.
3. **Self-run on Kubernetes:** common for platform teams. It's this course's primitives
   (StatefulSets, PVCs, PDBs, anti-affinity) plus an **operator** that encodes the runbook:
   "to upgrade Kafka, roll brokers one at a time and wait for in-sync replicas".
4. **Self-run on VMs:** the classic, still common for big stateful systems (large Kafka
   clusters, Vault, Consul). Terraform creates 3 or 5 instances across AZs, Packer or
   Ansible installs the binary as a systemd unit, a load balancer goes in front. Replacing a
   dead node is a runbook, or an Auto Scaling group plus automation.

So yes, people really do rent a few machines and install Kafka on them. That's option 4.

### What "on-prem" actually means

Your own servers, in your own data centre or in a colocation facility (Equinix and
similar) that rents you power, cooling and network. Every layer AWS gave you needs a
substitute:

| AWS gives you | On-prem equivalent |
|---|---|
| EC2 | a virtualisation platform (**VMware vSphere**, **OpenStack**, **Proxmox**) or Kubernetes on bare metal, provisioned with PXE boot, **MAAS** or **Tinkerbell** |
| EBS / S3 | SAN/NAS appliances (NetApp, Pure), or **Ceph** (block + object), **MinIO** (S3 API) |
| ELB | hardware or software load balancers: **F5**, **HAProxy**, **Envoy**; **MetalLB** for Kubernetes `LoadBalancer` Services |
| VPC, security groups | physical network gear, VLANs, firewalls; **Cilium/Calico** NetworkPolicies |
| IAM | **Active Directory / LDAP**, an OIDC provider (Keycloak, Okta), plus **Vault** for workload secrets |
| Route 53 / Cloud Map | internal DNS (BIND, Infoblox), **Consul** |
| CloudWatch | **Prometheus + Grafana + Loki**, or a vendor (Datadog…) |
| Managed Kafka, databases | you run them yourself |
| The AWS console | a **platform team** that operates all of this for product teams, often behind an internal developer portal (e.g. **Backstage**) |

This is why Vault and Consul exist: they provide AWS-like capabilities (secrets, identity,
discovery) where there is no AWS, and *the same way across* on-prem, AWS and GCP. Large
companies are usually **hybrid**, with a platform team stitching it all together.

### A rule of thumb for AWS shops

Use the managed service unless you have a concrete reason not to: cost at large scale
(MSK versus self-run Kafka can differ a lot), a missing feature, a hybrid requirement, data
residency. Every self-run stateful system is a permanent subscription to upgrades, backups,
capacity planning and a pager.

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

Two patterns recur:

- **Control plane vs data plane.** A central brain decides; distributed agents do the work
  (API server and kubelets, istiod and Envoys, Consul servers and agents). If the brain dies,
  agents keep running on their last config: a control-plane outage means "no changes", not
  "no traffic".
- **A small, strongly consistent core.** Almost every system here has, at its centre, a
  replicated log agreed on by consensus. Worth understanding once.

### Consensus in one screen

etcd, Consul servers, Vault (integrated storage) and Kafka's KRaft controllers all use
**Raft**. ZooKeeper uses **ZAB**, a close cousin. Temporal outsources the problem to its
database.

```
   client write ──▶ leader ──append entry──▶ follower 1   ✔
                      │     ──append entry──▶ follower 2   ✔  majority (2 of 3) acked → committed
                      ▼                                        → apply to state machine → reply
                   log: [1 put a=1][2 put b=2][3 del a]...
```

- **N = 2f + 1** nodes tolerate **f** failures: 3 survive 1, 5 survive 2. A 4-node cluster
  still survives only 1, and 2 nodes survive *none*. Hence odd numbers, usually 3 or 5.
- Every write costs a round trip to a majority, so keep members close (one region's AZs, not
  continents) and data small: configuration, membership, leadership, metadata.
- Lose the majority and writes stop rather than risk split-brain. In CAP terms, **CP**.
- DynamoDB (Paxos) and Aurora's storage quorum run the same machinery. On AWS you consume
  it; with these tools, you *run* it.

---

## Part 3: the tools

Set up the playground once: single-node, dev-mode instances of Kafka, Vault, ZooKeeper and
Consul ([toolbox.yaml](toolbox.yaml)), plus the kubelab app with a traffic generator
([metrics-demo.yaml](metrics-demo.yaml)) for Envoy and Prometheus to work with.

```bash
cd lessons/16-distributed-systems-toolbox
kubectl apply -f toolbox.yaml
kubectl apply -f metrics-demo.yaml
kubectl -n toolbox wait --for=condition=Ready pod --all --timeout=180s
```

The course's **Tool UIs** menu then links to the Consul and Vault web UIs (and Prometheus,
once installed below). Some Try-its need two terminals: the course terminal is tmux, so
`Ctrl-b %` splits it and `Ctrl-b o` switches panes.

### Envoy: the programmable proxy

**What:** a high-performance L4/L7 proxy in C++, open-sourced by Lyft in 2016. It's the
data plane under Istio, Envoy Gateway, Consul's mesh, Contour and the late AWS App Mesh
(discontinued September 2026). When "the mesh does retries", Envoy is doing them.

**Mental model:** **listener → filter chain → route → cluster → endpoint**. Listeners bind
ports. Filters (TLS, HTTP parsing, auth, rate limiting, Wasm/Lua extensions) process the
connection and its requests. A route picks a **cluster** (a named group of upstream
endpoints, like a target group), whose load balancer picks an endpoint.

**Worth knowing:**
- **xDS APIs** (LDS/RDS/CDS/EDS/SDS: listeners, routes, clusters, endpoints, secrets):
  config streams in over gRPC and applies *without restarts* or dropped connections. That's
  what made Envoy the universal data plane: anyone can write a control plane for it.
- Threading: one main thread plus N workers, each with its own event loop. A connection
  stays on one worker for life, so the hot path needs almost no locking.
- Built-in resilience: retries with budgets, timeouts, **outlier detection** (eject
  endpoints that keep failing), circuit breakers (caps on connections and pending
  requests), rate limiting.
- Thousands of stats, and an admin API on every proxy (`/config_dump`, `/clusters`,
  `/stats/prometheus`).

**Use cases:** edge/API gateway, mesh sidecar, gRPC proxying, TLS termination, traffic
shifting. **AWS analog:** roughly an ALB's insides, plus VPC Lattice. **How it's run:**
almost never by hand: Istio, Envoy Gateway (lesson 09) or Consul generates its config.

**Try it:** a standalone Envoy with a hand-written static config. Read
[envoy.yaml](envoy.yaml) first: Envoy answers `/hello` itself and proxies `/app/` to the
metrics-demo pods with a 1s timeout. A *headless* Service makes DNS return pod IPs, so Envoy
does the load balancing rather than kube-proxy.

```bash
kubectl apply -f envoy.yaml
kubectl -n toolbox wait --for=condition=Ready pod/envoy
kubectl -n toolbox port-forward pod/envoy 10000:10000 9901:9901 &

curl -s localhost:10000/hello                                 # answered by Envoy itself
for i in 1 2 3 4; do curl -s localhost:10000/app/ | grep '"pod"'; done   # alternates between the two pods
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:10000/app/?delay=2'  # 504: route timeout is 1s

curl -s localhost:9901/clusters | grep metrics_demo | grep -E 'rq_total|health_flags'
curl -s localhost:9901/stats | grep -E 'cluster.metrics_demo.upstream_rq_(total|2xx|timeout)'
curl -s localhost:9901/config_dump | jq -r '.configs[]."@type"'   # listeners, routes, clusters...
kill %1
```

The admin API is Envoy's view of the world: `/clusters` gives each pod's request count and
health (`healthy` unless outlier detection ejected it), `/stats` counts 4 successes and 1
timeout, and `/config_dump` is the running config, one section per xDS type. Under Istio,
that's where you look when the mesh misbehaves.

### Istio: the service mesh

**What:** a service mesh. It moves networking out of application code and into the
platform: **mTLS everywhere, traffic control, retries and timeouts, uniform telemetry**,
with no code changes.

**Mental model:** **istiod**, the control plane, compiles Kubernetes and Istio CRDs into
Envoy config and pushes it over xDS. It's also a certificate authority, giving each workload
a short-lived certificate for its ServiceAccount: a SPIFFE identity like
`spiffe://cluster.local/ns/shop/sa/orders`. Two data-plane modes:

- **Sidecar** (classic): an Envoy injected into every pod, traffic redirected into it by
  iptables. Powerful, but costs CPU and memory per pod, adds latency per hop, and upgrading
  the mesh means restarting every pod.
- **Ambient** (GA since Istio 1.24, November 2024): a per-node **ztunnel** (a small Rust
  proxy) does mTLS and L4; optional **waypoint** Envoys do L7 where needed. Cheaper, and
  nothing to inject.

**Worth knowing:** the key CRDs are `PeerAuthentication` (require mTLS),
`AuthorizationPolicy` (which identity may call which service: "zero trust" by
ServiceAccount, not IP), and `VirtualService`/`DestinationRule` (routing, retries, subsets),
increasingly replaced by lesson 09's Gateway API. Because every hop emits metrics and
traces, a mesh also answers "which service calls which, and how slowly?".

**Use cases:** compliance-driven encryption in transit, zero trust, canaries and fault
injection, multi-cluster traffic. **Costs:** a mesh is a distributed system in its own
right, and debugging gets harder when the mesh itself misbehaves. Many teams adopt one only
when they hit a concrete need.
**Alternatives:** **Linkerd** (simpler, Rust proxy), **Cilium** (eBPF, in the kernel).
**AWS analog:** VPC Lattice (App Mesh was closer, but is discontinued). **How it's run:**
per cluster with `istioctl` or Helm; upgrades run a new control-plane revision alongside the
old one and move namespaces over gradually. (No Try it: a mesh is too heavy for this lab,
and you've already seen its engine.)

### Prometheus: metrics and alerting

**What:** a time-series database, query language (PromQL) and alerting engine in one
binary; the de facto metrics standard around Kubernetes. Built at SoundCloud in 2012 after
Google's Borgmon, it was the second CNCF project after Kubernetes.

**Mental model:** **pull-based**. Services expose `GET /metrics` as plain text; Prometheus
discovers targets (via the Kubernetes API, EC2, Consul…) and **scrapes** them every 15–60s.
A series is a name plus labels, like `http_requests_total{service="orders",code="500"}`.
Types: **counter** (only goes up; always query through `rate()`), **gauge**, **histogram**
(buckets, so you can compute percentiles across pods) and summary.

Why pull? Because then Prometheus knows what *should* exist. A dead target shows up as
`up == 0`; a pushed metric that stops arriving looks just like a quiet service.

**Worth knowing:**
- Storage: a local append-only TSDB, about 1–2 bytes per sample (Gorilla-style
  delta-of-delta and XOR encoding), in 2-hour blocks plus a WAL. Deliberately *not*
  clustered: for HA run two identical servers; for long retention and a global view add
  **Thanos** or **Grafana Mimir**, or remote-write to a managed service.
- **Cardinality is the #1 way to kill it.** Each unique label combination is a new series,
  so user IDs, request IDs or raw URLs in labels eventually eat all its memory. (The kubelab
  app maps unknown paths to `other` for this reason; see [server.py](../../app/server.py).)
- **Alertmanager** deduplicates, groups, silences and routes firing alerts (PagerDuty,
  Slack). Alert rules are just PromQL expressions.
- It's for aggregated *metrics*: not logs, traces or billing-grade exact counts.
- The **Prometheus Operator** (usually via kube-prometheus-stack) adds `ServiceMonitor`,
  `PodMonitor` and `PrometheusRule` CRDs. That's how most EKS clusters run it.

**AWS analog:** CloudWatch Metrics + Alarms (push-based). AMP runs the storage and query
side; you still scrape in-cluster. **How it's run:** one Prometheus per cluster (Helm or
operator), plus Grafana, plus Thanos, Mimir or AMP for the long-term, multi-cluster view.

**Try it:** install the community chart (Helm: lesson 08) without the parts we don't need.
It brings **kube-state-metrics** (Kubernetes objects as metrics) and **node-exporter** (a
DaemonSet exposing each node's CPU, memory and disk).

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prom prometheus-community/prometheus -n monitoring --create-namespace \
  --set alertmanager.enabled=false --set prometheus-pushgateway.enabled=false \
  --set server.persistentVolume.enabled=false --wait

kubectl -n toolbox exec deploy/metrics-demo -- curl -s localhost:8080/metrics   # the raw format
kubectl get --raw /metrics | grep '^apiserver_request_total' | head -3          # Kubernetes itself speaks it too

kubectl -n monitoring port-forward svc/prom-prometheus-server 9090:80 &
```

Prometheus finds the metrics-demo pods through their `prometheus.io/scrape` annotations
(see [metrics-demo.yaml](metrics-demo.yaml)). Wait about 2 minutes (it scrapes once a
minute, and `rate()` needs two samples), then query:

```bash
q() { curl -s localhost:9090/api/v1/query --data-urlencode "query=$1" | jq -r '.data.result[] | "\(.metric | del(.__name__) | tostring)  \(.value[1])"'; }
q 'up{namespace="toolbox"}'                                                         # is each target reachable?
q 'sum by (path, code) (rate(kubelab_http_requests_total[5m]))'                     # requests/sec by path and status
q 'histogram_quantile(0.99, sum by (le) (rate(kubelab_http_request_duration_seconds_bucket[5m])))'  # p99 latency
q 'sum by (namespace) (kube_pod_info)'                                              # pods per namespace (kube-state-metrics)
q 'sum by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m]))'             # CPU cores busy per node (node-exporter)
kill %1
```

`up` is `1` for both pods. `/` gets twice the rate of `other` (the 404s): the generator
hits `/` twice (once with `?delay=`) per `/does-not-exist`. The p99 is about 0.4–0.5s
because the delays (up to 0.3s) land in the 0.25–0.5s bucket and `histogram_quantile`
interpolates within it: an estimate, not a measurement.

Then try the queries in **Tool UIs → Prometheus**: **Graph** plots them over time, and
**Status → Targets** lists everything discovered.

### Vault: secrets, identity and encryption

**What:** HashiCorp's secrets server. Its killer features aren't storing passwords but
**dynamic secrets** and **encryption as a service**.

**Mental model:** everything is a **path**, served by a mounted **secrets engine**:

- `kv/`: static secrets (versioned key/value).
- `database/`: **dynamic credentials**. `vault read database/creds/orders-ro` creates a
  brand-new database user with a 1-hour **lease** and drops it on expiry. Nothing
  long-lived to leak or rotate.
- `pki/`: Vault as a certificate authority for short-lived TLS certificates.
- `transit/`: encrypt, decrypt and sign on request; the app never holds the key (think
  KMS `Encrypt`/`Decrypt`).
- `aws/`: short-lived IAM credentials.

Clients log in with an **auth method** (Kubernetes ServiceAccount token, AWS IAM, OIDC,
AppRole) and get a **token** carrying **policies**: paths plus capabilities like `read`.
IAM, for secrets.

**Worth knowing:**
- **Seal/unseal:** data is encrypted with a key that is itself encrypted by a root key. At
  startup Vault is *sealed* and can't read its own storage until a quorum of operators enter
  **Shamir key shares** (3 of 5 by default) or, as nearly everyone does, it **auto-unseals**
  via AWS KMS or an HSM.
- HA via **integrated storage (Raft)**: 3 or 5 nodes, one active, the rest standby.
- Every request goes to an audit log, a big reason security teams like it.
- Licensing: HashiCorp moved Vault and Consul to the source-available BSL in 2023; IBM
  bought HashiCorp in 2025 (hence 2026's jump to version 2.0: IBM versioning, not a
  rewrite). **OpenBao** is the open-source fork, under the Linux Foundation.
- On Kubernetes: the **Vault Secrets Operator** (syncs into Secrets), the Agent Injector (a
  sidecar writing secrets to files), or the CSI provider.

**Use cases:** hybrid or multi-cloud secrets, dynamic DB credentials, internal PKI for
mTLS, encrypting sensitive fields (card data, PII). **AWS analog:** Secrets Manager + KMS +
ACM Private CA + STS, unified. On pure AWS those usually suffice; Vault earns its place in
hybrid setups or where dynamic secrets are required. **How it's run:** a 3- or 5-node Raft
cluster on VMs or Kubernetes (official Helm chart) with KMS auto-unseal, often as a
company-wide service run by a security or platform team. Or HCP Vault Dedicated.

**Try it:** the toolbox Vault is in dev mode (in-memory, unsealed, root token `root`), and
the pod's environment points the CLI at it.

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

Transit takes base64 (so it can encrypt binary) and returns ciphertext like `vault:v1:…`,
where `v1` is the key version: rotate the key and new data uses `v2` while old ciphertext
still decrypts. Note that the policy says `secret/data/myapp`, not `secret/myapp`: KV
version 2 stores data under a `data/` sub-path, which the CLI hides and policies don't. It's
Vault's most common "why is this denied?".

**Tool UIs → Vault** (token `root`) shows the same secret, key and policy.

### etcd: the consistent key-value store you already run

**What:** a Raft-based, strongly consistent key-value store, originally from CoreOS, and
**Kubernetes' database**: every object you've created in this course lives here.

**Mental model:** a flat, ordered keyspace with **MVCC**. Every change gets a cluster-wide,
increasing **revision**; you can read "as of" a revision, and a **watch** streams every
change after revision N. The API server's watches, which drive every controller, are etcd
watches underneath, and every object's `resourceVersion` is an etcd revision. **Leases**
(keys with a TTL) support leader election and liveness.

**Worth knowing:** the default quota is 2 GiB and ~8 GiB the recommended maximum: it holds
metadata, not data. Disk fsync latency makes or breaks it, hence fast SSDs on control-plane
nodes. On EKS, AWS hides and manages it entirely.

**Try it:** Kubernetes' raw storage. etcd runs as a static pod on the control-plane node;
`etcdctl` needs the cluster's client certificates.

```bash
E="kubectl -n kube-system exec etcd-lab-control-plane -- etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key"
$E member list -w table
$E endpoint status -w table                 # leader, Raft term/index, DB size, quota
$E get /registry/namespaces --prefix --keys-only
$E get / --prefix --keys-only | grep -c .   # every object in the cluster
```

One member (production has 3 or 5), and it's the leader. Keys look like
`/registry/<resource>/<namespace>/<name>`; values are binary protobuf. Now watch the way a
controller does. In the terminal where you defined `$E`:

```bash
$E watch --prefix /registry/configmaps/toolbox/ -w json | jq -r '.Events[] | "\(if .type == 1 then "DELETE" else "PUT" end) \(.kv.key | @base64d) rev=\(.kv.mod_revision)"'
```

and in a second one:

```bash
kubectl -n toolbox create configmap watched --from-literal=color=blue
kubectl -n toolbox patch configmap watched -p '{"data":{"color":"green"}}'
kubectl -n toolbox delete configmap watched
```

The watch prints PUT, PUT, DELETE with rising revisions; gaps are writes elsewhere in the
cluster, since the counter is global. `Ctrl-C` stops it.

### ZooKeeper: the original coordination service

**What:** Apache ZooKeeper (from Yahoo, after Google's Chubby paper) is a replicated,
strongly consistent store for *coordination*: leader election, locks, membership, config.
For a decade everything leaned on it: Hadoop, HBase, Kafka, Solr, Storm, Mesos.

**Mental model:** a tree of **znodes**, like a filesystem, each holding a small blob (under
1 MB, usually a few bytes). Three primitives make it powerful:

- **Ephemeral znodes** vanish when the client's session ends. A process dies, its session
  times out, its node disappears: failure detection for free.
- **Sequential znodes** get an auto-incrementing suffix (`candidate-0000000007`): a total
  order.
- **Watches** are one-shot notifications when a node or its children change.

**Leader election:** everyone creates an ephemeral sequential node under `/election`; the
lowest number leads. Everyone else watches *the node just before theirs*, not the leader, so
when the leader dies exactly one client wakes up (no thundering herd), and it's now the
lowest.

**Worth knowing:** consensus is **ZAB**. Writes go through the leader and are linearizable;
any node serves reads locally (fast, possibly stale; `sync` first if that matters). **Apache
Curator** implements the recipes correctly, which is harder than it looks. ZooKeeper is
legacy-ish now: **Kafka 4.0 (March 2025) removed it** for its own Raft (KRaft), and new
systems embed Raft or use etcd. You'll still meet it in older Kafka, HBase, Solr and Hadoop.
**AWS analog:** nothing direct; DynamoDB conditional writes (and lock clients built on them)
come closest. **How it's run:** a 3- or 5-node "ensemble" on VMs or a StatefulSet, usually
bundled with whatever needs it.

**Try it:** ephemeral nodes and watches. Open the ZooKeeper shell in **two** terminals:

```bash
kubectl -n toolbox exec -it zk -- zkCli.sh      # in both terminals
```

Terminal A creates the election and a candidate:

```
create /election ""
create -s -e /election/candidate- node-a      # -s sequential, -e ephemeral
```

Terminal B lists the candidates and sets a watch:

```
ls -w /election                               # [candidate-0000000000]
```

Type `quit` in A. B immediately prints `WatchedEvent state:SyncConnected
type:NodeChildrenChanged path:/election`, and `ls /election` there returns `[]`: the leader
died, elect a new one.

Two subtleties. Watches are **one-shot**: the client must re-read and re-watch, and can
miss changes in between, so an event means "go look", not "here's the state". And A quit
*cleanly*, deleting its node at once; a *crashed* client's node lingers until the session
times out (30s here). That timeout is the failure detector, and tuning it is the eternal
trade between fast failover and false alarms.

### Consul: service discovery and mesh across everything

**What:** HashiCorp Consul: **service discovery with health checks**, a **KV store** and a
**service mesh**, spanning *everything*: VMs, bare metal, many Kubernetes clusters, data
centres and clouds.

**Mental model:** 3 or 5 **servers** (Raft, holding the catalog and KV) plus an **agent**
on every node. Agents register local services, run their health checks, and form a
**gossip** pool (Serf, based on SWIM) for membership and failure detection that scales to
thousands of nodes without hammering the servers. Clients find services via **DNS**
(`orders.service.consul` returns only healthy instances) or HTTP. The mesh (formerly
"Connect") is Envoy sidecars plus mTLS plus **intentions** ("web may call orders").

**Worth knowing:** inside one Kubernetes cluster you mostly *don't* need it: Services and
CoreDNS already do discovery. Consul earns its keep when workloads live outside Kubernetes
or span clusters and data centres (WAN federation, cluster peering). It was historically
Vault's storage backend, and has the same BSL licence.
**AWS analog:** Cloud Map + Route 53 health checks + VPC Lattice + AppConfig. **How it's
run:** servers on VMs or Kubernetes (Helm chart), agents on every VM or as a DaemonSet.
Usually a platform team runs it next to Vault and Nomad (the "HashiStack").

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

DNS returns both `orders` addresses, so anything that can resolve a hostname can use
Consul, no client library needed. (The IPs are made up and unchecked; real services register
through their local agent, whose health checks pull failing instances out of DNS.) **Tool
UIs → Consul** shows the same catalog and KV.

### Kafka: the distributed commit log

**What:** Apache Kafka (open-sourced by LinkedIn in 2011; its creators founded Confluent)
is a distributed, replicated, **append-only log**: the backbone of event streaming. Services
publish facts ("OrderPlaced"); any number of consumers read them at their own pace.

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

- A record's **key** picks its partition (by hash), so **ordering is guaranteed only within
  a partition**. Key by `customer_id` and each customer's events stay in order.
- **Consumer groups:** each partition is read by exactly one member of a group, so
  parallelism is capped at the partition count and extra consumers sit idle. Size
  partitions for future throughput.
- Reading deletes nothing. **Retention** is by time or size (or forever with **log
  compaction**, keeping the latest value per key), so new consumers can replay history.
  That's the big difference from a queue.

**Worth knowing:**
- It's fast because of boring things done well: sequential I/O, the page cache, zero-copy
  `sendfile`, batching, compression.
- Durability: each partition has a leader, followers and an **ISR** (in-sync replicas) set.
  With `acks=all` and `min.insync.replicas=2` at replication factor 3, an acknowledged write
  survives losing a broker.
- At-least-once by default. Idempotent producers plus transactions give exactly-once
  *within Kafka* (consume → process → produce); external side effects must be idempotent.
- **KRaft:** since 4.0, metadata lives in a built-in Raft quorum of controllers. No
  ZooKeeper.
- The ecosystem: **Kafka Connect** (source and sink connectors), **Debezium** (change data
  capture from databases), **Kafka Streams** and **Flink** (stream processing), Schema
  Registry (Avro/Protobuf contracts).

**Use cases:** event-driven microservices, CDC pipelines, feeding data lakes and search
indexes, activity tracking, event sourcing. **AWS analog:** **MSK**
(managed Kafka) or **Kinesis Data Streams** (shards ≈ partitions, same log model). It's
*not* SQS, a queue where each message goes to one consumer and is deleted on ack: no
replay, no partitions. SQS distributes work; Kafka and Kinesis carry event streams that many
consumers need. **How it's run:** 3+ brokers across AZs plus 3 KRaft controllers, on VMs or
via the **Strimzi** operator (Kafka as CRDs); or MSK, or Confluent Cloud. See also
**Redpanda** (Kafka-compatible, C++) and **WarpStream**-style designs that keep data in S3.

**Try it:** partitions, keys, offsets and consumer groups. Each command starts a JVM (a
few seconds apiece); ignore the consumers' notice about the new rebalance protocol.

```bash
K="kubectl -n toolbox exec -i kafka -- /opt/kafka/bin"
$K/kafka-topics.sh --bootstrap-server localhost:9092 --create --topic orders --partitions 3
$K/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic orders

# Produce keyed records ("key:value")
printf 'alice:order-1\nbob:order-2\nalice:order-3\ncarol:order-4\nbob:order-5\n' | \
  $K/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic orders \
  --reader-property parse.key=true --reader-property key.separator=:

# Consume as group "billing", printing partition, offset and key
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders --group billing \
  --from-beginning --max-messages 5 --formatter-property print.key=true \
  --formatter-property print.partition=true --formatter-property print.offset=true

$K/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group billing   # offsets & lag
```

In the consumer output, each key's records sit in one partition, in order. Keys can share
a partition (in our run `alice` and `bob` both hashed to 0): the guarantee is per key.
Billing's committed offsets equal the log-end offsets, so `LAG` is 0; "no active members"
just means the consumer has exited.

Next: the group remembers its place, and the log isn't consumed away.

```bash
# Produce two more, then consume again as "billing": only the NEW records
printf 'dave:order-6\nalice:order-7\n' | $K/kafka-console-producer.sh --bootstrap-server localhost:9092 \
  --topic orders --reader-property parse.key=true --reader-property key.separator=:
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders --group billing --max-messages 2

# A new group replays all 7 from the start
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic orders --group analytics \
  --from-beginning --max-messages 7
```

Billing gets only `order-6` and `order-7`. Analytics gets all seven, probably not in the
order produced: each customer's orders stay in sequence (`order-1`, `order-3`, `order-7`),
but there's no global order across partitions.

### Temporal: durable execution for workflows

**What:** **durable execution**. You write long-running business processes as *ordinary
code* (Go, Java, TypeScript, Python, .NET), and Temporal guarantees it runs to completion
despite crashes, deploys and outages, even if it takes months. Its creators forked it in
2019 from **Cadence**, which they built at Uber; one had earlier led the design of **AWS
Simple Workflow (SWF)**.

**Mental model:** the split is between **workflows** and **activities**.

```go
func OrderWorkflow(ctx workflow.Context, order Order) error {
    ao := workflow.ActivityOptions{StartToCloseTimeout: time.Minute}   // + automatic retries
    ctx = workflow.WithActivityOptions(ctx, ao)

    if err := workflow.ExecuteActivity(ctx, ReserveStock, order).Get(ctx, nil); err != nil {
        return err
    }
    if err := workflow.ExecuteActivity(ctx, ChargeCard, order).Get(ctx, nil); err != nil {
        _ = workflow.ExecuteActivity(ctx, ReleaseStock, order).Get(ctx, nil)   // saga compensation
        return err
    }
    workflow.Sleep(ctx, 14*24*time.Hour)                     // yes, really: sleep two weeks
    return workflow.ExecuteActivity(ctx, AskForReview, order).Get(ctx, nil)
}
```

- **Activities** do the side effects (API calls, DB writes), with timeouts and retry
  policies.
- **Workflow code** must be **deterministic**: no direct I/O, clocks or randomness (the SDK
  has safe versions). Temporal records each step's result in an **event history**. If a
  worker dies, another **replays** the history through the same code, reusing recorded
  results rather than re-running activities, to rebuild the exact state and carry on. Hence
  the two-week sleep is fine: no process sleeps, just a timer in Temporal's database.
- Workflows can receive **signals** ("customer cancelled"), answer **queries**, and wait on
  timers as long as they like.

**Worth knowing:** the Temporal *server* (frontend, history, matching and internal worker
services) keeps state in **Cassandra, PostgreSQL or MySQL**. Your code runs in *your*
**worker** processes, which long-poll task queues; Temporal never runs it. Changing workflow
code while old executions are in flight needs **versioning** care, since replay must stay
deterministic. Histories are capped (~50k events), so long-lived workflows
*continue-as-new*.

**Use cases:** order fulfilment and payments, sagas, infrastructure provisioning,
subscription lifecycles, human approval steps, and increasingly AI-agent orchestration.
**AWS analog:** **Step Functions** (a JSON state machine, versus workflows-as-code) and the
older SWF. **How it's run:** **Temporal Cloud**, or self-hosted on Kubernetes with the Helm
chart plus a managed Postgres. Workers are just your Deployments.

**Kafka vs Temporal:** Kafka is *choreography*: services react to each other's events and
nobody owns the whole process. Temporal is *orchestration*: one piece of code owns the
process, its state and its error handling. Big systems often use both.

**Try it** (off-cluster): the tutorials at <https://learn.temporal.io> get a local dev
server (`temporal server start-dev`) and a first workflow running in about 15 minutes. Do it
to *feel* replay: kill the worker mid-workflow, restart it, and watch it pick up where it
left off.

---

## Part 4: others worth knowing (one line each)

| Tool | What it is | AWS analog |
|---|---|---|
| **OpenTelemetry** | vendor-neutral SDKs + collector for traces, metrics and logs: instrument once, send anywhere | ADOT / X-Ray SDK |
| **Grafana** (+ **Loki**, **Tempo**, **Mimir**) | dashboards, plus logs, traces and long-term metrics backends from the same vendor | CloudWatch dashboards, Logs, X-Ray |
| **Jaeger** | distributed tracing backend and UI | X-Ray |
| **Linkerd** | a simpler, lighter service mesh than Istio | — |
| **Cilium** | eBPF-based CNI: networking, NetworkPolicy, observability (Hubble), even mesh, in the kernel | VPC CNI + SGs |
| **NATS** (+ JetStream) | very lightweight pub/sub and request-reply, with optional persistence | SNS/SQS-ish |
| **RabbitMQ** | classic message broker: queues, routing, per-message acks | Amazon MQ, SQS |
| **Redpanda**, **Pulsar** | Kafka alternatives (Kafka-compatible C++ / tiered, multi-tenant) | MSK, Kinesis |
| **Debezium** | turns database changelogs (binlog/WAL) into Kafka events (CDC) | DMS CDC |
| **Flink** | stateful stream processing with exactly-once state | Managed Service for Apache Flink |
| **Redis / Valkey** | in-memory data structures: cache, rate limits, queues, locks | ElastiCache / MemoryDB |
| **CockroachDB**, **TiDB**, **YugabyteDB** | distributed SQL on Raft, Spanner-style | Aurora DSQL |
| **Cassandra / ScyllaDB** | leaderless, wide-column, eventually consistent, tunable quorum | Keyspaces, DynamoDB |
| **SPIFFE / SPIRE** | standard workload identities (what Istio's certificates are) | IAM roles for workloads |
| **OpenBao** | open-source fork of Vault | — |
| **Nomad** | HashiCorp's simpler scheduler, a Kubernetes alternative | ECS |
| **Argo Workflows / Airflow** | DAG/batch orchestration (data pipelines), vs Temporal's application workflows | Step Functions, MWAA |

## Part 5: choosing between the overlapping ones

| Question | Short answer |
|---|---|
| Istio or Consul for a mesh? | All-Kubernetes: Istio (or Linkerd, Cilium). Lots of VMs plus clusters plus data centres: Consul. On AWS, first ask whether VPC Lattice or plain mTLS in the apps would do. |
| etcd, ZooKeeper or Consul for coordination? | Don't build on them unless you must. If you must: etcd (modern, simple API), ZooKeeper only where the ecosystem requires it, Consul if you also want discovery and health checks. On AWS, DynamoDB conditional writes cover many lock and lease needs. |
| Kafka, Kinesis, SQS/SNS or RabbitMQ? | Many consumers, replay, per-key ordering: Kafka/MSK or Kinesis. Distributing work items: SQS. Fan-out notifications: SNS (+SQS). Complex routing, request/reply: RabbitMQ. |
| Temporal or Step Functions? | Step Functions for AWS-native glue: visual state machines, little code. Temporal for complex, long-running business logic you want as testable code, or outside AWS. |
| Vault or Secrets Manager? | AWS-only: Secrets Manager + KMS (+ ACM PCA). Hybrid or multi-cloud, dynamic DB credentials everywhere, or one audited secrets plane: Vault. |
| Prometheus or CloudWatch? | On Kubernetes, Prometheus-format metrics are the lingua franca (every chart exposes them); store them in AMP, or self-run with Thanos/Mimir. CloudWatch remains home for AWS-service metrics. Many shops use both, with Grafana on top. |

## Clean up

```bash
kubectl delete namespace toolbox
helm uninstall prom -n monitoring && kubectl delete namespace monitoring
```
