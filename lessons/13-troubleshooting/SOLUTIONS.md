# Drill solutions

Spoilers. Each entry gives the signal that points at the problem, the root cause, and one
fix. Commands assume you're in `lessons/13-troubleshooting`.

<details><summary><b>01: The shop won't start after the nginx upgrade</b></summary>

- **Signal:** `ImagePullBackOff`. `kubectl describe pod` ends with
  `failed to resolve reference "docker.io/library/nginx:1.299-alpine": ... not found`.
- **Cause:** a typo in the tag: `1.299` instead of `1.29`.
- **Fix:** `kubectl -n drill-01 set image deploy/app nginx=nginx:1.29-alpine`
</details>

<details><summary><b>02: Pods keep restarting</b></summary>

- **Signal:** `CrashLoopBackOff` (or `Error` between restarts). `kubectl logs <pod>` shows
  `python: can't open file '/app/app.py': [Errno 2] No such file or directory`.
  If a fresh container has already started and its log is empty, add `--previous`.
- **Cause:** the `command` override points at a file that doesn't exist. The image runs `server.py`.
- **Fix:** remove the override so the image's default `CMD` runs:
  `kubectl -n drill-02 patch deploy app --type json -p '[{"op":"remove","path":"/spec/template/spec/containers/0/command"}]'`
  (or change it to `["python", "server.py"]`).
</details>

<details><summary><b>03: Pods never start, but there's no crash either</b></summary>

- **Signal:** `CreateContainerConfigError`. There are no logs, because the container was never
  created. Events: `couldn't find key GREETING in ConfigMap drill-03/shop-config`.
- **Cause:** keys are case-sensitive. The ConfigMap has `greeting`; the Deployment asks for `GREETING`.
- **Fix:** change the `configMapKeyRef.key` to `greeting`, or add the key it wants:
  `kubectl -n drill-03 patch configmap shop-config --type merge -p '{"data":{"GREETING":"welcome to the shop"}}'`.
  The kubelet keeps retrying, so the existing pods start on their own. No redeploy needed.
</details>

<details><summary><b>04: The client pod can't reach the shop Service</b></summary>

- **Signal:** the pods are `Running` and `1/1`, but `kubectl -n drill-04 get endpointslices`
  shows `<unset>` under ENDPOINTS for `shop`. A Service with no endpoints is a phone number
  that rings nowhere.
- **Cause:** the Service selector says `tier: fronted` (typo), which matches no pods.
  Compare `kubectl -n drill-04 get svc shop -o yaml` with `kubectl -n drill-04 get pods --show-labels`.
- **Fix:** `kubectl -n drill-04 patch svc shop --type merge -p '{"spec":{"selector":{"tier":"frontend"}}}'`
- **Verify:** `kubectl -n drill-04 exec client -- curl -s shop/`
</details>

<details><summary><b>05: Pods are stuck and never land on a node</b></summary>

- **Signal:** `Pending`. Events: `0/3 nodes are available: 1 node(s) had untolerated taint(s),
  2 Insufficient cpu.` Read it as a tally: the control plane is ruled out by its taint, and
  both workers are ruled out because they don't have enough CPU.
- **Cause:** each pod requests 16 CPUs, more than any node has.
- **Fix:** `kubectl -n drill-05 set resources deploy/app --requests=cpu=100m`
</details>

<details><summary><b>06: Pods run fine, but are never ready</b></summary>

- **Signal:** `Running` but `0/1`, `RESTARTS 0`. Events: `Readiness probe failed: HTTP probe
  failed with statuscode: 404`. (The first few failures say `connection refused`: that's
  just the app still starting. The 404 that follows is the real clue.)
- **Cause:** the probe checks `/health`, which doesn't exist. The app serves `/readyz`.
- **Fix:** `kubectl -n drill-06 patch deploy app --type json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/readyz"}]'`
- **Lesson:** a failing readiness probe never restarts anything. It just keeps traffic away,
  quietly, forever.
</details>

<details><summary><b>07: Works on my laptop; restarts forever in the cluster</b></summary>

- **Signal:** `CrashLoopBackOff`, and `kubectl logs --previous` is empty: the process died
  before printing anything. The last state tells you how it died:
  `kubectl -n drill-07 describe pod` → `Last State: Terminated, Exit Code: 137`. 137 is
  128 + 9, i.e. SIGKILL. Nothing in the app sends itself SIGKILL; the kernel does, when a
  container exceeds its memory limit. The reason may read `OOMKilled` or, in this lab,
  just `Error` (see the note in the README).
- **Cause:** the startup command allocates a 100 MiB cache (look at it with
  `kubectl -n drill-07 get deploy app -o yaml`), but the memory limit is 64Mi. Locally
  there's no limit, hence "works on my laptop".
- **Fix:** `kubectl -n drill-07 set resources deploy/app --requests=memory=192Mi --limits=memory=256Mi`
</details>

<details><summary><b>08: The watcher reports errors from the API server</b></summary>

- **Signal:** `kubectl -n drill-08 logs deploy/watcher` shows `pods is forbidden: User
  "system:serviceaccount:drill-08:pod-watcher" cannot list resource "pods"`.
  Yet a Role and RoleBinding exist.
- **Cause:** the Role grants `resources: ["pod"]`. RBAC resource names are plural (`pods`),
  and nothing validates them: a rule for a resource that doesn't exist is accepted and
  simply never matches.
- **Fix:** `kubectl -n drill-08 patch role read-pods --type json -p '[{"op":"replace","path":"/rules/0/resources/0","value":"pods"}]'`
- **Verify:** `kubectl auth can-i list pods -n drill-08 --as=system:serviceaccount:drill-08:pod-watcher`,
  and within 10 seconds the watcher logs `OK: I can see 1 pod(s)`.
</details>

<details><summary><b>09: The app is stuck waiting on its storage</b></summary>

- **Signal:** pod `Pending` with `pod has unbound immediate PersistentVolumeClaims`. Follow
  the trail to the claim: `kubectl -n drill-09 describe pvc data` →
  `storageclass.storage.k8s.io "fast-ssd" not found`.
- **Cause:** the PVC asks for a StorageClass this cluster doesn't have (`kubectl get storageclass`
  lists only `standard`).
- **Fix:** `storageClassName` is **immutable** on a PVC, so delete the claim and recreate it
  (pointing at `standard`, or with no `storageClassName` at all to get the default):
  ```bash
  kubectl -n drill-09 delete pvc data
  sed 's/fast-ssd/standard/' drills/09.yaml | kubectl -n drill-09 apply -f -
  ```
  The Pending pod is still waiting for a claim called `data`, so it picks up the new one
  and starts. (Had a running pod been using the PVC, the delete would hang in
  `Terminating` thanks to the `kubernetes.io/pvc-protection` finalizer until that pod went
  away.)
</details>

<details><summary><b>10: Endpoints exist, but requests from the client fail</b></summary>

- **Signal:** this time the endpoint slice lists both pod IPs, but
  `kubectl -n drill-10 exec client -- curl -v shop/` fails with `Failed to connect to shop
  port 80 ... Could not connect to server` (connection refused). The slice's PORTS column
  says `80`: the Service is forwarding to port 80 on the pods.
- **Cause:** Service `targetPort: 80`, but the container listens on 8080.
- **Fix:** point it at the container's named port, so a future port change can't break it again:
  `kubectl -n drill-10 patch svc shop --type json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":"http"}]'`
</details>
