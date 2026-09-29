# 11 — Jobs, CronJobs and DaemonSets

Deployments are for things that should run *forever*, somewhere. Two other patterns cover
most of what's left:

- **Job / CronJob**: run to completion, retry on failure, optionally on a schedule
  (≈ AWS Batch, a one-off ECS task, EventBridge Scheduler)
- **DaemonSet**: exactly one pod per node (≈ ECS daemon scheduling). Used for node agents.

`cd lessons/11-jobs-daemonsets`

## 1. A parallel Job

Read [job.yaml](job.yaml): 6 completions, 2 at a time.

```bash
kubectl apply -f job.yaml
kubectl get pods -l job-name=crunch -w      # two at a time until 6 succeed (Ctrl-C)
kubectl get job crunch
kubectl logs job/crunch                      # logs from one of its pods
kubectl logs -l job-name=crunch --prefix
```

## 2. Failure and retries

Read [flaky-job.yaml](flaky-job.yaml): each pod fails ~70% of the time.

```bash
kubectl apply -f flaky-job.yaml
kubectl get pods -l job-name=flaky -w        # failed pods, retried with exponential backoff
kubectl describe job flaky | tail -10
```

Delete and re-apply it a few times. Sometimes it succeeds quickly, sometimes it exhausts
`backoffLimit` and the Job is marked `Failed`.

> Jobs are **at-least-once**. A pod can be retried after doing part of its work, or (rarely)
> run twice. Make job logic idempotent, just like with SQS consumers.

## 3. CronJobs

Read [cronjob.yaml](cronjob.yaml):

```bash
kubectl apply -f cronjob.yaml
kubectl get cronjob heartbeat
kubectl get jobs -w                           # a new Job each minute (Ctrl-C after 2)
kubectl logs -l job-name --tail=1 | grep heartbeat
kubectl create job manual-run --from=cronjob/heartbeat   # trigger one now - handy for testing
kubectl logs job/manual-run
```

## 4. DaemonSets

The cluster already runs some:

```bash
kubectl get daemonsets -n kube-system        # kube-proxy and kindnet: one per node
```

Read [daemonset.yaml](daemonset.yaml). It's a toy node agent that reads the node's pod log
directory through a `hostPath` volume, like Fluent Bit or the CloudWatch agent would.

```bash
kubectl apply -f daemonset.yaml
kubectl get pods -l app=node-agent -o wide   # one per node, including the control plane
kubectl logs -l app=node-agent --prefix
```

Add a node and the DaemonSet follows automatically. You can simulate this: remove the
toleration, re-apply, and watch the control-plane pod disappear.

## Challenge

1. Write a Job that computes something slow (e.g. `python -c "print(sum(range(10**8)))"`)
   and set `activeDeadlineSeconds: 5`. What happens?
2. Make the CronJob run every 2 minutes with `timeZone: Europe/London`, and suspend it with
   `kubectl patch cronjob heartbeat -p '{"spec":{"suspend":true}}'`.
3. Use an **indexed** Job (`completionMode: Indexed`, `completions: 5`) where each pod
   prints `$JOB_COMPLETION_INDEX`. This is how you shard a batch workload.

## Clean up

```bash
kubectl delete -f .
kubectl delete job manual-run --ignore-not-found
```
