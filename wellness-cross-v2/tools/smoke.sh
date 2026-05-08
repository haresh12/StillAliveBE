#!/usr/bin/env bash
# smoke.sh — basic curl smoke test for V2 endpoints.
# Usage: HOST=https://your-host DEVICE=test_device bash smoke.sh

set -e
HOST="${HOST:-http://localhost:3000}"
DEVICE="${DEVICE:-smoke_test_device}"

echo "→ /health"
curl -sS -f "$HOST/api/wellness/v2/health" | head -c 400; echo

echo
echo "→ /home/$DEVICE"
curl -sS -o /tmp/v2_home.json -w "HTTP %{http_code}\n" "$HOST/api/wellness/v2/home/$DEVICE"
echo "  (size: $(wc -c < /tmp/v2_home.json) bytes)"

echo
echo "→ /insights/$DEVICE?range=30"
curl -sS -o /tmp/v2_insights.json -w "HTTP %{http_code}\n" "$HOST/api/wellness/v2/insights/$DEVICE?range=30"
echo "  (size: $(wc -c < /tmp/v2_insights.json) bytes)"

echo
echo "→ POST /recompute/$DEVICE"
curl -sS -o /tmp/v2_recompute.json -w "HTTP %{http_code}\n" \
  -X POST -H 'content-type: application/json' \
  -d '{"reason":"smoke_test"}' \
  "$HOST/api/wellness/v2/recompute/$DEVICE"

echo
echo "Smoke complete. Inspect /tmp/v2_*.json for shapes."
