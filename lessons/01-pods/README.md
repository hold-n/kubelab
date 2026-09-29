# 01 — Pods

A **Pod** is the smallest deployable unit: one or more containers that share a network
namespace (same IP, can talk over `localhost`) and can share volumes. They're always
co-scheduled on the same node. Think "ECS task". You rarely create pods directly (lesson 02
covers why), but everything else is built on them.

Run all commands from this directory: `cd lessons/01-pods`. In a second terminal, run
`kubectl get pods -o wide -w`.

## 1. Imperative first

```bash
kubectl run quick --image=kubelab/app:v1 --image-pull-policy=Never
kubectl get pods -o wide
kubectl describe pod quick        # read the Events at the bottom: Scheduled → Pulled → Created → Started
kubectl logs quick
kubectl delete pod quick
```

`kubectl run` is handy for experiments. For anything real, use declarative YAML.

## 2. Declarative: apply a manifest

Read [pod.yaml](pod.yaml), then:

```bash
kubectl apply -f pod.yaml
kubectl get pod hello -o wide
kubectl get pod hello -o yaml | less    # note all the defaults Kubernetes filled in, and .status
```

`kubectl apply` is idempotent. Change something (add a label), re-apply, and only the
difference is sent. This is how all real configuration is managed: YAML in git, applied by a
pipeline or a GitOps agent.

## 3. Interact with it

```bash
kubectl logs hello -f                           # stream logs (Ctrl-C to stop)
kubectl exec hello -- curl -s localhost:8080/   # run a command inside the container
kubectl exec -it hello -- bash                  # interactive shell (exit to leave)
```

The response includes `pod`, `node` and `podIP`, which the Downward API env vars in the
manifest injected.

Reach it from the orb with a port-forward, a tunnel through the API server for debugging
only (like SSM port forwarding):

```bash
kubectl port-forward pod/hello 9090:8080 &
curl -s localhost:9090/
kill %1
```

Pods get routable IPs on a flat cluster network. Any pod can reach any other pod directly:

```bash
POD_IP=$(kubectl get pod hello -o jsonpath='{.status.podIP}')
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl -- curl -s $POD_IP:8080/
```

## 4. What happens when things die?

Make the process exit:

```bash
kubectl exec hello -- curl -s localhost:8080/exit
kubectl get pod hello          # RESTARTS went up; the kubelet restarted the container in place
kubectl logs hello --previous  # logs from the previous (dead) container
```

The pod's `restartPolicy` (default `Always`) makes the **kubelet** restart containers in
place. Now delete the whole pod:

```bash
kubectl delete pod hello
kubectl get pods               # gone for good
```

Nothing brings it back. A bare pod is bound to one node, and nobody is responsible for
recreating it if it's deleted or the node dies. Controllers like Deployments fill that gap
(next lesson).

## 5. Multi-container pods (sidecars)

Read [multi-container.yaml](multi-container.yaml): an app, plus a "poller" sidecar that calls
it over `localhost` and writes to a shared `emptyDir` volume.

```bash
kubectl apply -f multi-container.yaml
kubectl get pod sidecar-demo                     # READY 2/2
sleep 15
kubectl exec sidecar-demo -c poller -- cat /data/poll.log
kubectl logs sidecar-demo -c app                 # -c picks the container
```

Real-world sidecars: log shippers, service-mesh proxies (Envoy/Istio), auth proxies, and
secret refreshers. Kubernetes also has *native* sidecars (an `initContainer` with
`restartPolicy: Always`) and **init containers**, which run to completion *before* the app
starts (e.g. for migrations or waiting on a dependency). Look them up with
`kubectl explain pod.spec.initContainers`.

## Challenge

1. Write `challenge.yaml`: a pod named `init-demo` with an **init container** (busybox) that
   writes `hello from init` into an `emptyDir` at `/work/message.txt`, and an app container
   (`kubelab/app:v1`) that mounts the same volume at `/etc/kubelab`. The app shows that file
   on `/`, so `kubectl exec init-demo -- curl -s localhost:8080/` should include your message.
2. Use `kubectl debug` to attach an ephemeral debugging container to a running pod:
   `kubectl debug -it sidecar-demo --image=busybox:1.37 --target=app -- sh`, then run `ps aux`.
   Why can you see the app's Python process? (Hint: `--target` shares the process namespace.)

## Clean up

```bash
kubectl delete -f . --ignore-not-found
```
