#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Smoke test: Water agent HTTP contract.
#
# Hits every Water route against a running server and asserts the
# response shape matches what the frontend reads. Catches drift between
# water.agent.js and the React Native screens before ship.
#
# Usage:
#   API=http://localhost:3000 DEVICE=smoke_water_$(date +%s) \
#     bash scripts/smoke-water-api.sh
#
# Exits 0 on full pass, 1 on any failure. Uses jq for JSON inspection.
# ─────────────────────────────────────────────────────────────────────
set -u
API=${API:-http://localhost:3000}
DEVICE=${DEVICE:-smoke_water_$(date +%s)}
PASS=0
FAIL=0
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; DIM=$'\033[2m'; NC=$'\033[0m'

if ! command -v jq >/dev/null 2>&1; then
  echo "${RED}jq not installed. brew install jq.${NC}" >&2
  exit 2
fi

assert_keys() {
  local label="$1"; local body="$2"; shift 2
  local missing=()
  for key in "$@"; do
    if ! echo "$body" | jq -e ".${key}" >/dev/null 2>&1; then
      missing+=("$key")
    fi
  done
  if [ ${#missing[@]} -eq 0 ]; then
    echo "${GREEN}✓${NC} ${label}"
    PASS=$((PASS+1))
  else
    echo "${RED}✗${NC} ${label} ${DIM}missing: ${missing[*]}${NC}"
    echo "${DIM}  body: $(echo "$body" | head -c 200)${NC}"
    FAIL=$((FAIL+1))
  fi
}

call() { curl -sS -m 10 "$@"; }

echo "${DIM}API=$API   DEVICE=$DEVICE${NC}"
echo

# ── 1. POST /setup ───────────────────────────────────────────────────
SETUP=$(call -X POST "$API/api/water/setup" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"goal\":[\"health\"],\"activity_level\":\"moderate\",\"climate\":\"mild\",\"reminders\":\"smart\",\"weight_kg\":70,\"weight_unit\":\"kg\",\"pregnancy\":\"no\",\"wake_time_min\":420,\"bed_time_min\":1380,\"utc_offset_minutes\":0}")
assert_keys "POST /setup" "$SETUP" ok daily_goal_ml recommended_goal_ml manual_goal_ml goal_source setup

# ── 2. GET /setup-status ─────────────────────────────────────────────
STATUS=$(call "$API/api/water/setup-status?deviceId=$DEVICE")
assert_keys "GET /setup-status (post-setup)" "$STATUS" setup_completed setup

# ── 3. GET /today (cold, no logs) ────────────────────────────────────
TODAY=$(call "$API/api/water/today?deviceId=$DEVICE")
assert_keys "GET /today (cold)" "$TODAY" logs entry_count logged_ml remaining_ml goal_ml recommended_goal_ml manual_goal_ml goal_source streak

# ── 4. POST /log ─────────────────────────────────────────────────────
LOG1=$(call -X POST "$API/api/water/log" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"ml\":350,\"beverage_type\":\"water\"}")
assert_keys "POST /log (water)" "$LOG1" ok id effective_ml

LOG2=$(call -X POST "$API/api/water/log" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"ml\":200,\"beverage_type\":\"coffee\"}")
assert_keys "POST /log (coffee)" "$LOG2" ok id effective_ml

# ── 5. GET /today (with logs) ────────────────────────────────────────
TODAY2=$(call "$API/api/water/today?deviceId=$DEVICE")
assert_keys "GET /today (after logs)" "$TODAY2" logs logged_ml goal_ml streak
LOGGED=$(echo "$TODAY2" | jq -r '.logged_ml')
if [ "$LOGGED" -gt 0 ]; then
  echo "${GREEN}✓${NC} /today.logged_ml > 0 (${LOGGED}ml)"
  PASS=$((PASS+1))
else
  echo "${RED}✗${NC} /today.logged_ml did not register logs"
  FAIL=$((FAIL+1))
fi

# ── 6. GET /logs?date=today ──────────────────────────────────────────
TODAY_DATE=$(date -u +%Y-%m-%d)
LOGS=$(call "$API/api/water/logs?deviceId=$DEVICE&date=$TODAY_DATE")
assert_keys "GET /logs?date=today" "$LOGS" logs logged_ml goal_ml

# ── 7. POST /goal ────────────────────────────────────────────────────
GOAL=$(call -X POST "$API/api/water/goal" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"goal_ml\":3000}")
assert_keys "POST /goal (manual)" "$GOAL" ok daily_goal_ml goal_source setup

GOAL2=$(call -X POST "$API/api/water/goal" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"use_recommended\":true}")
assert_keys "POST /goal (use_recommended)" "$GOAL2" ok daily_goal_ml goal_source

# ── 8. DELETE /log/:id ───────────────────────────────────────────────
DEL_ID=$(echo "$LOG1" | jq -r '.id')
DEL=$(call -X DELETE "$API/api/water/log/$DEL_ID?deviceId=$DEVICE")
assert_keys "DELETE /log/:id" "$DEL" ok

# ── 9. GET /analysis (legacy) ────────────────────────────────────────
ANALYSIS=$(call "$API/api/water/analysis?deviceId=$DEVICE")
assert_keys "GET /analysis" "$ANALYSIS" stage goal_ml stats hydration_score day_parts beverage_mix observations setup

# ── 10. GET /analysis/v2?range=30 ────────────────────────────────────
V2=$(call "$API/api/water/analysis/v2?deviceId=$DEVICE&range=30")
assert_keys "GET /analysis/v2 (30d)" "$V2" range score score_grade hydration_score drink_breakdown daily_logs circadian ai_reads aha_moments observations personal_formula streak completion avg_ml

# ── 11. GET /actions/v2 ──────────────────────────────────────────────
ACTIONS=$(call "$API/api/water/actions/v2?deviceId=$DEVICE")
assert_keys "GET /actions/v2" "$ACTIONS" cadence prescription actions history stats

# ── 12. GET /containers (saved-container CRUD, Phase 2) ──────────────
CONT_LIST=$(call "$API/api/water/containers?deviceId=$DEVICE")
assert_keys "GET /containers" "$CONT_LIST" containers

CONT_NEW=$(call -X POST "$API/api/water/containers" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\",\"name\":\"smoke bottle\",\"drink_type\":\"water\",\"ml\":500,\"emoji\":\"💧\"}")
assert_keys "POST /containers" "$CONT_NEW" ok id

CID=$(echo "$CONT_NEW" | jq -r '.id')
USE=$(call -X POST "$API/api/water/containers/$CID/use" \
  -H 'content-type: application/json' \
  -d "{\"deviceId\":\"$DEVICE\"}")
assert_keys "POST /containers/:id/use" "$USE" ok

DEL_CONT=$(call -X DELETE "$API/api/water/containers/$CID?deviceId=$DEVICE")
assert_keys "DELETE /containers/:id" "$DEL_CONT" ok

# Note: POST /log/from-photo requires a real base64 JPEG + OpenAI key, so we
# skip the AI roundtrip here. Smoke that endpoint manually with a real photo.

# ── Summary ──────────────────────────────────────────────────────────
echo
echo "${DIM}─────────────────────────────────────${NC}"
TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  echo "${GREEN}PASS${NC} $PASS/$TOTAL"
  exit 0
else
  echo "${RED}FAIL${NC} $FAIL/$TOTAL  (passed: $PASS)"
  exit 1
fi
