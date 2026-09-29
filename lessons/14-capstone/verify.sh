#!/usr/bin/env bash
# Automated grader for the capstone. Run it as often as you like.
# It also runs two resilience tests: it restarts Redis, and does a rolling
# restart of `web` while sending traffic, counting failed requests.
set -uo pipefail
NS=capstone
PASS=0; FAIL=0
ok()   { echo "  ✅ $*"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $*"; FAIL=$((FAIL+1)); }
check() { local desc=$1; shift; if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi; }
j() { kubectl get -n "$NS" "$@" -o json 2>/dev/null; }

echo "Structure"
check "namespace '$NS' exists" kubectl get ns "$NS"
check "namespace has a ResourceQuota" test "$(j resourcequota | jq '.items | length')" -gt 0
check "StatefulSet 'redis' is ready" kubectl rollout status sts/redis -n "$NS" --timeout=60s
check "redis stores data on a PersistentVolumeClaim" \
  test "$(j sts redis | jq '.spec.volumeClaimTemplates | length')" -gt 0
check "Deployment 'web' is available" kubectl rollout status deploy/web -n "$NS" --timeout=60s
check "web has at least 3 ready replicas" test "$(j deploy web | jq '.status.readyReplicas // 0')" -ge 3
check "every web container has readiness and liveness probes" test "$(j deploy web |
  jq '[.spec.template.spec.containers[] | select(.readinessProbe == null or .livenessProbe == null)] | length')" -eq 0
check "every web container sets cpu/memory requests and a memory limit" test "$(j deploy web |
  jq '[.spec.template.spec.containers[] | select(.resources.requests.cpu == null or .resources.requests.memory == null or .resources.limits.memory == null)] | length')" -eq 0
check "web pods run on at least 2 different nodes" test "$(j pods -l app=web |
  jq '[.items[] | select(.status.phase=="Running") | .spec.nodeName] | unique | length')" -ge 2
check "a PodDisruptionBudget protects web" test "$(j pdb |
  jq '[.items[] | select(.spec.selector.matchLabels.app=="web")] | length')" -gt 0
check "an HPA scales web with minReplicas >= 3" test "$(j hpa |
  jq '[.items[] | select(.spec.scaleTargetRef.name=="web" and .spec.minReplicas >= 3)] | length')" -gt 0

echo "Traffic"
GW=$(j gateway | jq -r '[.items[] | .status.addresses[0].value // empty][0] // empty')
if [ -z "$GW" ]; then
  bad "a Gateway in '$NS' has an address"
  echo; echo "Result: $PASS passed, $FAIL failed"; exit 1
fi
ok "Gateway address: $GW"
# A freshly created Gateway takes a little while before its proxy serves traffic.
for _ in $(seq 1 30); do curl -sf --max-time 2 -o /dev/null "http://$GW/" && break; sleep 2; done
visits() { curl -s --max-time 3 "http://$GW/" | jq -r '.visits // empty' 2>/dev/null; }
v1=$(visits); v2=$(visits)
if [[ "$v1" =~ ^[0-9]+$ && "$v2" =~ ^[0-9]+$ && "$v2" -gt "$v1" ]]; then
  ok "GET http://$GW/ reaches web, and the visit counter increments ($v1 → $v2)"
else
  bad "GET http://$GW/ should return an incrementing integer 'visits' (got '$v1', '$v2')"
fi

echo "Resilience"
if [[ "$v2" =~ ^[0-9]+$ ]]; then
  kubectl delete pod redis-0 -n "$NS" --wait=true >/dev/null 2>&1
  kubectl rollout status sts/redis -n "$NS" --timeout=90s >/dev/null 2>&1
  sleep 2
  v3=$(visits)
  if [[ "$v3" =~ ^[0-9]+$ && "$v3" -gt "$v2" ]]; then
    ok "visit count survived deleting redis-0 ($v2 → $v3)"
  else
    bad "visit count should survive deleting redis-0 (was $v2, now '$v3')"
  fi
fi

echo "  … rolling restart of web under load (takes ~1 min)"
fails=0; total=0
kubectl rollout restart deploy/web -n "$NS" >/dev/null
( kubectl rollout status deploy/web -n "$NS" --timeout=180s >/dev/null 2>&1 ) &
ROLL=$!
while kill -0 "$ROLL" 2>/dev/null; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$GW/")
  total=$((total+1)); [ "$code" = 200 ] || fails=$((fails+1))
  sleep 0.1
done
if [ "$fails" -eq 0 ]; then
  ok "zero failed requests during a rolling restart ($total requests)"
else
  bad "$fails of $total requests failed during a rolling restart"
fi

echo; echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
