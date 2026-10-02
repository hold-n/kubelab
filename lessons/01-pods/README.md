# 01 — Pods

A **Pod** is the smallest thing Kubernetes runs: one or more containers that share a network
namespace (one IP, so they talk over `localhost`) and can share volumes, always on the same
node. Think "ECS task". You'll rarely create pods by hand (section 4 shows why), but
Deployments, Jobs and the rest are all machines for creating pods.

Run all commands from this directory: `cd lessons/01-pods`. In a second terminal, run
`kubectl get pods -o wide -w` and keep an eye on it.

## 1. Imperative first

```bash
kubectl run quick --image=kubelab/app:v1 --image-pull-policy=Never
kubectl get pods -o wide
kubectl describe pod quick        # read the Events at the bottom: Scheduled → Pulled → Created → Started
kubectl logs quick
kubectl delete pod quick
```

The Events are lesson 00's control loops made visible: `default-scheduler` picked a node,
then that node's `kubelet` did the rest. `--image-pull-policy=Never` makes it use the
side-loaded image instead of a registry. (If `logs` prints nothing, the app hadn't started
yet.)

`kubectl run` is fine for experiments. For anything real, write YAML.

## 2. Declarative: apply a manifest

Read [pod.yaml](pod.yaml), then:

```bash
kubectl apply -f pod.yaml
kubectl get pod hello -o wide
kubectl get pod hello -o yaml | less    # note all the defaults Kubernetes filled in, and .status
```

Your 20-line manifest comes back as 100+ lines: defaults like `restartPolicy: Always` and
`terminationGracePeriodSeconds: 30`, plus a `status` (IP, container states) written by the
kubelet.

`kubectl apply` is idempotent. Change something, re-apply, and only the difference is sent.
This is how real configuration is managed: YAML in git, applied by a pipeline or GitOps agent.

One catch: most of a running pod's spec is **immutable**. Adding a label works; changing a port
or env var gets `Forbidden: pod updates may not change fields other than...`. To change a pod,
you replace it. Hold that thought for lesson 02.

## 3. Interact with it

```bash
kubectl exec hello -- curl -s localhost:8080/   # run a command inside the container
kubectl logs hello                              # the app logged that request
```

The response's `pod`, `node` and `podIP` come from the **Downward API** env vars in the
manifest; without them, `node` and `podIP` would be `null`.

Two interactive commands, each holding the terminal until you leave:

```bash
kubectl logs hello -f            # stream logs; Ctrl-C to stop
```

```bash
kubectl exec -it hello -- bash   # a shell inside the container; exit to leave
```

(`I have no name!` in the prompt is harmless: the image runs as non-root UID 1000, which has
no `/etc/passwd` entry.)

To reach the pod from the orb, port-forward: a tunnel through the API server, for debugging
only (like SSM port forwarding):

```bash
kubectl port-forward pod/hello 9090:8080 &
sleep 1
curl -s localhost:9090/
kill %1
```

Every pod gets its own IP on a flat network: any pod can reach any other directly, across
nodes, without NAT. (On EKS, pod IPs are real VPC addresses.) Try it from a throwaway pod:

```bash
POD_IP=$(kubectl get pod hello -o jsonpath='{.status.podIP}')
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- curl -s $POD_IP:8080/
```

`--rm -it --restart=Never` means "run once, attach, then delete". If it warns that it
couldn't attach, `curl` simply finished first; kubectl shows the logs instead.

## 4. What happens when things die?

Make the process exit:

```bash
kubectl exec hello -- curl -s localhost:8080/exit
kubectl get pod hello          # RESTARTS went up; the kubelet restarted the container in place
kubectl logs hello --previous  # logs from the previous (dead) container
```

`restartPolicy: Always` (the default) makes the **kubelet** restart the container in place:
same pod, same node, same IP, no scheduler involved. (Crash repeatedly and the restarts back
off exponentially, up to 5 minutes apart: `CrashLoopBackOff`, lesson 05.) Now delete the
whole pod:

```bash
kubectl delete pod hello
kubectl get pods               # gone for good
```

Nothing brings it back. A bare pod is bound to one node, and nobody recreates it if it's
deleted or the node dies. Mortal, immutable, unsupervised: pods need a controller to manage
them. That's what Deployments are (next lesson).

## 5. Multi-container pods (sidecars)

Read [multi-container.yaml](multi-container.yaml): an app, plus a "poller" sidecar that calls
it over `localhost` every 5 seconds and appends to a log on a shared `emptyDir` volume.

```bash
kubectl apply -f multi-container.yaml
kubectl get pod sidecar-demo                     # READY 2/2
sleep 15
kubectl exec sidecar-demo -c poller -- cat /data/poll.log
kubectl logs sidecar-demo -c app                 # -c picks the container
```

You'll see a `"version": "v1",` line every 5 seconds, and the app logging requests from
`127.0.0.1`: two containers, one network namespace. Without `-c`, kubectl picks the first
container and tells you (`Defaulted container "app"`).

Real-world sidecars: log shippers, service-mesh proxies (Envoy/Istio), auth proxies, secret
refreshers. Two relatives:

- **Init containers** run to completion, in order, *before* the app starts: migrations,
  "wait for the database", fetching config.
- **Native sidecars** are init containers with `restartPolicy: Always`. They start before the
  app and keep running beside it, so a proxy is guaranteed up before the app needs it.

See `kubectl explain pod.spec.initContainers`.

## Challenge

1. Write `challenge.yaml`: a pod named `init-demo` with an **init container** (busybox) that
   writes `hello from init` into an `emptyDir` at `/work/message.txt`, and an app container
   (`kubelab/app:v1`) that mounts the same volume at `/etc/kubelab`. The app shows that file
   on `/`, so `kubectl exec init-demo -- curl -s localhost:8080/` should include your message.
2. Use `kubectl debug` to attach an ephemeral debugging container to a running pod:
   `kubectl debug -it sidecar-demo --image=busybox:1.37 --target=app -- sh`, then run `ps aux`.
   Why can you see the app's Python process? (Hint: `--target` shares the process namespace.)

<details><summary>Hints and answers</summary>

1. One `emptyDir`, mounted at `/work` in the init container and `/etc/kubelab` in the app:
   different paths, same directory. The init container can run
   `command: ["sh", "-c", "echo 'hello from init' > /work/message.txt"]`; don't forget
   `imagePullPolicy: Never` on the app. Success: `"configFile": "hello from init"`.
2. Each container normally has its own process namespace. `--target=app` joins the debug
   container to `app`'s, so `python server.py` shows up as PID 1 (the poller's processes
   don't). This is how you debug minimal images with no shell: bring your tools in a separate
   container. Ephemeral containers can't be removed; they go when the pod does.
</details>

## Clean up

```bash
kubectl delete -f . --ignore-not-found
```
