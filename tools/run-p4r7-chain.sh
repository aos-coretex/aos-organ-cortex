#!/bin/bash
# p4r-7 chained completion driver — waits for Phase 1, runs Phase 2, runs replay,
# generates REPORT.md. Drops a state file so external observers can poll progress.
#
# Anchor: RFI-2 reply Path III + Phase 1+2 ratified.
# Idempotent throughout — restart on any phase resumes from current state.
#
# Reads LITELLM master_key from Keychain (com.coretex.litellm-proxy/master-key).
# Aborts if Phase 1 isn't progressing within poll-deadline.

set -u
set -o pipefail

REPO_ROOT="/Library/AI/AI-AOS/AOS-organ-dev/AOS-organ-cortex/AOS-organ-cortex-src"
FIXTURES_DIR="${REPO_ROOT}/test/fixtures/p4r-7"
REPLAYS_DIR="${FIXTURES_DIR}/replays"
STATE_FILE="${FIXTURES_DIR}/CHAIN_STATE.json"
LOG="${FIXTURES_DIR}/chain.log"

PHASE1_TARGET=50
AUGMENTED_PER_PATTERN=8
COST_CAP=30
CONCURRENCY=4
POLL_INTERVAL=60       # seconds between fixture-count checks
POLL_DEADLINE=18000    # 5 hours hard deadline for Phase 1

cd "${REPO_ROOT}"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG}"
}

write_state() {
  local phase="$1" detail="$2"
  python3 -c "
import json, datetime
state = { 'phase': '$phase', 'detail': '$detail', 'updated_at': datetime.datetime.utcnow().isoformat() + 'Z' }
print(json.dumps(state, indent=2))
" > "${STATE_FILE}"
}

log "p4r-7 chain start"
write_state "starting" "chain initialized"

# Phase 1 — wait
log "Phase 1: waiting for ${PHASE1_TARGET} natural-*.json fixtures (poll ${POLL_INTERVAL}s, deadline ${POLL_DEADLINE}s)"
write_state "phase1_waiting" "polling for fixtures"
START_TS=$(date +%s)
while :; do
  COUNT=$(ls "${FIXTURES_DIR}"/natural-*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "${COUNT}" -ge "${PHASE1_TARGET}" ]; then
    log "Phase 1 reached ${COUNT}/${PHASE1_TARGET} fixtures"
    break
  fi
  ELAPSED=$(( $(date +%s) - START_TS ))
  if [ "${ELAPSED}" -gt "${POLL_DEADLINE}" ]; then
    log "ERROR: Phase 1 deadline exceeded (count=${COUNT}, target=${PHASE1_TARGET})"
    write_state "phase1_deadline_exceeded" "count=${COUNT}, target=${PHASE1_TARGET}"
    exit 2
  fi
  write_state "phase1_waiting" "count=${COUNT}/${PHASE1_TARGET}, elapsed=${ELAPSED}s"
  sleep "${POLL_INTERVAL}"
done
write_state "phase1_complete" "count=${COUNT}"

# Phase 2 — synthetic-recentGoals augmentation
log "Phase 2: synthetic-recentGoals augmentation (${AUGMENTED_PER_PATTERN}/pattern × 4 patterns)"
write_state "phase2_running" "augmenting fixtures"
node tools/build-precision-verification-fixtures.js --phase augmented \
  --out-dir "${FIXTURES_DIR}" --augmented-per-pattern "${AUGMENTED_PER_PATTERN}" 2>&1 | tee -a "${LOG}" || {
  log "ERROR: Phase 2 failed"
  write_state "phase2_error" "augmentation failed"
  exit 3
}
AUGMENTED_COUNT=$(ls "${FIXTURES_DIR}"/augmented-*.json 2>/dev/null | wc -l | tr -d ' ')
log "Phase 2 emitted ${AUGMENTED_COUNT} augmented fixtures"
write_state "phase2_complete" "augmented_count=${AUGMENTED_COUNT}"

# Source LITELLM master key
log "Sourcing LITELLM master key from Keychain"
LITELLM_MK=$(/usr/bin/security find-generic-password \
  -s "com.coretex.litellm-proxy" -a "master-key" -w 2>/dev/null) || {
  log "ERROR: failed to retrieve LITELLM master key from Keychain"
  write_state "litellm_key_error" "Keychain lookup failed"
  exit 4
}
export LOCAL_LLM_API_KEY="${LITELLM_MK}"

# Replay
log "Replay: legacy + modular on ${COUNT}+${AUGMENTED_COUNT} fixtures (concurrency=${CONCURRENCY}, cost-cap=\$${COST_CAP})"
write_state "replay_running" "starting replay"
node tools/run-precision-verification-replay.js \
  --fixtures-dir "${FIXTURES_DIR}" \
  --replays-dir "${REPLAYS_DIR}" \
  --cost-cap "${COST_CAP}" \
  --concurrency "${CONCURRENCY}" \
  --continue-on-error 2>&1 | tee -a "${LOG}" || {
  log "ERROR: Replay phase failed"
  write_state "replay_error" "replay returned non-zero"
  exit 5
}
REPLAY_COUNT=$(ls "${REPLAYS_DIR}"/*-replay.json 2>/dev/null | wc -l | tr -d ' ')
log "Replay complete: ${REPLAY_COUNT} replay envelopes"
write_state "replay_complete" "replay_count=${REPLAY_COUNT}"

# Report
log "Generating REPORT.md"
write_state "report_running" "generating REPORT"
node tools/generate-precision-verification-report.js 2>&1 | tee -a "${LOG}" || {
  log "ERROR: Report generation failed"
  write_state "report_error" "generation failed"
  exit 6
}
log "Chain complete. REPORT.md at ${FIXTURES_DIR}/REPORT.md"
write_state "complete" "REPORT.md ready at ${FIXTURES_DIR}/REPORT.md"

exit 0
