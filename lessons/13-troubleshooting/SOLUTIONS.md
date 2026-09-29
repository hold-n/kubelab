# Drill solutions

Spoilers. Each entry has the diagnostic signal, the root cause, and one possible fix.

<details><summary><b>01: The shop won't start after the nginx upgrade</b></summary>

- **Signal:** `ImagePullBackOff`. `kubectl describe pod` shows `failed to resolve reference "docker.io/library/nginx:1.299-alpine": not found`.
- **Cause:** typo in the tag (`1.299` instead of `1.29`).
- **Fix:** `kubectl -n drill-01 set image deploy/app nginx=nginx:1.29-alpine`
</details>

<details><summary><b>02: Pods keep restarting</b></summary>

- **Signal:** `CrashLoopBackOff`. `kubectl logs <pod>` shows (while the container is waiting in
  back-off, plain `logs` shows the dead container. Use `--previous` once a new one has started)
  `python: can't open file '/app/app.py': [Errno 2] No such file or directory`.
- **Cause:** the `command` override points at a file that doesn't exist (the image runs `server.py`).
- **Fix:** remove the override so the image's default `CMD` runs:
  `kubectl -n drill-02 patch deploy app --type json -p '[{"op":"remove","path":"/spec/template/spec/containers/0/command"}]'`
  (or change it to `["python", "server.py"]`).
</details>

<details><summary><b>03: Pods never start, but there's no crash either</b></summary>

- **Signal:** `CreateContainerConfigError`. Events: `couldn't find key GREETING in ConfigMap drill-03/shop-config`.
- **Cause:** keys are case-sensitive. The ConfigMap has `greeting`, the Deployment asks for `GREETING`.
- **Fix:** either change the `configMapKeyRef.key` to `greeting`, or add the key:
  `kubectl -n drill-03 patch configmap shop-config --type merge -p '{"data":{"GREETING":"welcome to the shop"}}'`.
  The kubelet retries and the pods start without a redeploy.
</details>

<details><summary><b>04: The client pod can't reach the shop Service</b></summary>

- **Signal:** pods are healthy, but `kubectl get endpointslices -n drill-04` shows no endpoints for `shop`.
- **Cause:** the Service selector says `tier: fronted` (typo), which matches no pods.
- **Fix:** `kubectl -n drill-04 patch svc shop --type merge -p '{"spec":{"selector":{"tier":"frontend"}}}'`
- **Verify:** `kubectl -n drill-04 exec client -- curl -s shop/`
</details>

<details><summary><b>05: Pods are stuck and never land on a node</b></summary>

- **Signal:** `Pending`. Events: `0/3 nodes are available: ... Insufficient cpu`.
- **Cause:** each pod requests 16 CPUs, more than any node has.
- **Fix:** `kubectl -n drill-05 set resources deploy/app --requests=cpu=100m`
</details>

<details><summary><b>06: Pods run fine, but are never ready</b></summary>

- **Signal:** `Running` but `0/1`, `RESTARTS 0`. Events: `Readiness probe failed: HTTP probe failed with statuscode: 404`.
- **Cause:** the probe checks `/health`, which doesn't exist. The app serves `/readyz`.
- **Fix:** `kubectl -n drill-06 patch deploy app --type json -p '[{"op":"replace","path":"/spec/template/spec/containers/0/readinessProbe/httpGet/path","value":"/readyz"}]'`
- **Lesson:** a readiness failure never restarts anything. It silently keeps traffic away.
</details>

<details><summary><b>07: Works on my laptop; restarts forever in the cluster</b></summary>

- **Signal:** `CrashLoopBackOff` with nothing useful in the logs.
  `kubectl get pod <p> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'` → `reason: OOMKilled, exitCode: 137`.
- **Cause:** the app allocates a 100 MiB cache at startup, but the memory limit is 64Mi.
  (Locally there's no limit, hence "works on my laptop".)
- **Fix:** `kubectl -n drill-07 set resources deploy/app --requests=memory=192Mi --limits=memory=256Mi`
</details>

<details><summary><b>08: The watcher reports errors from the API server</b></summary>

- **Signal:** `kubectl -n drill-08 logs deploy/watcher` shows `pods is forbidden: User "system:serviceaccount:drill-08:pod-watcher" cannot list resource "pods"`.
  But a Role and RoleBinding exist.
- **Cause:** the Role grants `resources: ["pod"]`. RBAC resource names are plural (`pods`),
  and nothing validates the typo.
- **Fix:** `kubectl -n drill-08 patch role read-pods --type json -p '[{"op":"replace","path":"/rules/0/resources/0","value":"pods"}]'`
- **Verify:** `kubectl auth can-i list pods -n drill-08 --as=system:serviceaccount:drill-08:pod-watcher`
</details>

<details><summary><b>09: The app is stuck waiting on its storage</b></summary>

- **Signal:** pod `Pending`: `unbound immediate PersistentVolumeClaims` / waiting for the volume.
  `kubectl -n drill-09 describe pvc data` → `storageclass.storage.k8s.io "fast-ssd" not found`.
- **Cause:** the PVC asks for a StorageClass that doesn't exist in this cluster (check `kubectl get storageclass`).
- **Fix:** `storageClassName` is **immutable** on a PVC, so delete and recreate it:
  ```bash
  kubectl -n drill-09 delete pvc data
  sed 's/fast-ssd/standard/' drills/09.yaml | kubectl -n drill-09 apply -f -
  ```
  If the delete hangs in `Terminating`, a running pod is using the PVC (the
  `kubernetes.io/pvc-protection` finalizer). Scale the Deployment to 0 first.
</details>

<details><summary><b>10: Endpoints exist, but requests from the client fail</b></summary>

- **Signal:** endpoints are listed, but `kubectl -n drill-10 exec client -- curl -v shop/` gets `connection refused`.
  The endpoint slice shows port 80.
- **Cause:** Service `targetPort: 80`, but the container listens on 8080.
- **Fix:** point it at the named container port, so a future port change can't break it again:
  `kubectl -n drill-10 patch svc shop --type json -p '[{"op":"replace","path":"/spec/ports/0/targetPort","value":"http"}]'`
</details>
