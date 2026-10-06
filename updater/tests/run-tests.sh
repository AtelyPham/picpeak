#!/usr/bin/env bash
# Tests for updater/picpeak-updater.sh. Runs the real script against
# fake-docker.sh, so no Docker daemon is needed: `bash updater/tests/run-tests.sh`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATER="$HERE/../picpeak-updater.sh"
FAILS=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  ok   $1"; }
fail() {
    FAILS=$((FAILS + 1))
    echo "  FAIL $1"
    if [[ -n "${2:-}" ]]; then echo "       $2"; fi
}

expect_eq() {
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "expected '$3', got '$2'"; fi
}

status_field() {
    sed -n "s/^  \"$1\": \"\{0,1\}\([^\"]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$PROJECT/update/status/status.json"
}

################################################################################
# Pure helpers (sourced)
################################################################################

echo "version_cmp / json_value"
# shellcheck source=../picpeak-updater.sh
source "$UPDATER"
set +e
expect_eq "newer minor"            "$(version_cmp 3.160.0 3.159.4)" 1
expect_eq "older patch"            "$(version_cmp 3.159.3 3.159.4)" -1
expect_eq "equal"                  "$(version_cmp 3.159.4 3.159.4)" 0
expect_eq "stable above its beta"  "$(version_cmp 3.160.0 3.160.0-beta.3)" 1
expect_eq "beta below its stable"  "$(version_cmp 3.160.0-beta.3 3.160.0)" -1
expect_eq "beta order"             "$(version_cmp 3.160.0-beta.10 3.160.0-beta.9)" 1
expect_eq "numeric not lexical"    "$(version_cmp 3.10.0 3.9.0)" 1
expect_eq "v prefix accepted"      "$(version_cmp v3.1.0 3.1.0)" 0
version_cmp 3.1 3.1.0 >/dev/null; expect_eq "unparsable fails closed" "$?" 1
version_cmp 3.1.0-rc.1 3.1.0 >/dev/null; expect_eq "unknown prerelease fails closed" "$?" 1
expect_eq "json escapes quotes"    "$(json_value 'say "hi"')" '"say \"hi\""'
expect_eq "json escapes newline"   "$(json_value $'a\nb')" '"a\nb"'
expect_eq "json empty is null"     "$(json_value '')" 'null'

################################################################################
# Full runs against the fake docker
################################################################################

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin"
ln -s "$HERE/fake-docker.sh" "$ROOT/bin/docker"
printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/sleep"
chmod +x "$ROOT/bin/sleep" "$HERE/fake-docker.sh"
# macOS has no flock; CI and every Linux host do.
if ! command -v flock >/dev/null 2>&1; then
    printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/flock"
    chmod +x "$ROOT/bin/flock"
fi

# new_image ID VERSION [MIGRATIONS...]
new_image() {
    local id="$1" version="$2"; shift 2
    mkdir -p "$FAKE_STATE/images/$id"
    echo "$version" > "$FAKE_STATE/images/$id/version"
    printf '%s\n' "$@" > "$FAKE_STATE/images/$id/migrations"
}

# scenario NAME: a stack running backend "old" (3.159.0) + frontend "fe-old",
# with the registry already serving backend "new" (3.160.0) + frontend "fe-new".
scenario() {
    echo
    echo "$1"
    PROJECT="$ROOT/$(echo "$1" | tr -c 'a-z0-9' '-')"
    FAKE_STATE="$PROJECT.state"
    FAKE_WORKING_DIR="$PROJECT"
    export FAKE_STATE FAKE_WORKING_DIR
    mkdir -p "$PROJECT/update/request" "$FAKE_STATE"/{images,registry,tags,running}
    new_image old 3.159.0 001_a.js 002_b.js
    new_image new 3.160.0 001_a.js 002_b.js
    new_image fe-old 3.159.0
    new_image fe-new 3.160.0
    echo old > "$FAKE_STATE/running/backend";  echo old > "$FAKE_STATE/tags/backend";  echo new > "$FAKE_STATE/registry/backend"
    echo fe-old > "$FAKE_STATE/running/frontend"; echo fe-old > "$FAKE_STATE/tags/frontend"; echo fe-new > "$FAKE_STATE/registry/frontend"
    touch "$PROJECT/update/request/update-requested"
}

run_updater() {
    PATH="$ROOT/bin:$PATH" \
    PICPEAK_PROJECT_DIR="${PROJECT_DIR_OVERRIDE:-$PROJECT}" \
    PICPEAK_UPDATE_DIR="$PROJECT/update" \
    PICPEAK_UPDATER_PACKAGING="${PACKAGING:-host}" \
    PICPEAK_UPDATER_HEALTH_TIMEOUT=1 \
    PICPEAK_UPDATER_PULL_ATTEMPTS=3 \
        bash "$UPDATER" "${1:-run}" 2>"$PROJECT.log"
}

has_real_flock() {
    command -v flock >/dev/null 2>&1 && [[ "$(command -v flock)" != "$ROOT/bin/flock" ]]
}

running() { cat "$FAKE_STATE/running/$1"; }
tagged() { cat "$FAKE_STATE/tags/$1"; }

scenario "update succeeds"
run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "from" "$(status_field from_version)" 3.159.0
expect_eq "to" "$(status_field to_version)" 3.160.0
expect_eq "backend runs new" "$(running backend)" new
expect_eq "frontend runs new" "$(running frontend)" fe-new
[[ ! -e "$PROJECT/update/request/update-requested" ]] && pass "request consumed" || fail "request consumed"
expect_eq "contract" "$(sed -n 's/^  "contract": \([0-9]*\),$/\1/p' "$PROJECT/update/status/status.json")" 1

scenario "a healthy stack counts even when the deadline passed before the first check"

PATH="$ROOT/bin:$PATH" PICPEAK_PROJECT_DIR="$PROJECT" PICPEAK_UPDATE_DIR="$PROJECT/update" \
    PICPEAK_UPDATER_HEALTH_TIMEOUT=0 bash "$UPDATER" run 2>"$PROJECT.log"
expect_eq "state" "$(status_field state)" succeeded

scenario "a request older than the limit is discarded, not run"
# A fixed old date: touch -t works the same in GNU, BSD and busybox.
touch -t 202001010000 "$PROJECT/update/request/update-requested"
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" request_expired
expect_eq "backend untouched" "$(running backend)" old
[[ ! -e "$PROJECT/update/request/update-requested" ]] && pass "stale request removed" || fail "stale request removed"
grep -q ' pull ' "$FAKE_STATE/calls" && fail "nothing pulled" || pass "nothing pulled"

scenario "no request does nothing"
rm "$PROJECT/update/request/update-requested"
run_updater
expect_eq "state" "$(status_field state)" idle
expect_eq "backend untouched" "$(running backend)" old

scenario "already up to date"
echo old > "$FAKE_STATE/registry/backend"; echo fe-old > "$FAKE_STATE/registry/frontend"
run_updater
expect_eq "state" "$(status_field state)" up_to_date
grep -q '^compose.* up ' "$FAKE_STATE/calls" && fail "no recreate" || pass "no recreate"

scenario "downgrade refused"
new_image new 3.158.0
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" downgrade
expect_eq "backend untouched" "$(running backend)" old
expect_eq "old tag restored" "$(tagged backend)" old
expect_eq "frontend tag restored" "$(tagged frontend)" fe-old

scenario "manual-only release refused"
echo 3.160.0 > "$FAKE_STATE/images/new/label"
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" manual_required
expect_eq "backend untouched" "$(running backend)" old
expect_eq "old tag restored" "$(tagged backend)" old

scenario "auto-from floor at or below running version allows the update"
echo 3.159.0 > "$FAKE_STATE/images/new/label"
run_updater
expect_eq "state" "$(status_field state)" succeeded

scenario "source build refused before pulling"
touch "$FAKE_STATE/images/old/local"
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" source_build
grep -q ' pull ' "$FAKE_STATE/calls" && fail "nothing pulled" || pass "nothing pulled"

scenario "build context in compose refused"
touch "$FAKE_STATE/build_context"
run_updater
expect_eq "reason" "$(status_field reason)" source_build

scenario "pull retried until it succeeds"
echo 2 > "$FAKE_STATE/pull_failures"
run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "three pull attempts" "$(grep -c ' pull ' "$FAKE_STATE/calls")" 3

scenario "pull fails on every attempt"
echo 9 > "$FAKE_STATE/pull_failures"
run_updater
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" pull_failed
expect_eq "backend untouched" "$(running backend)" old
grep -q 'toomanyrequests' "$PROJECT/update/status/status.json" && pass "real error reported" || fail "real error reported"

scenario "unhealthy without migrations rolls back"
echo new > "$FAKE_STATE/broken"
run_updater
expect_eq "state" "$(status_field state)" rolled_back
expect_eq "backend back on old" "$(running backend)" old
expect_eq "frontend back on old" "$(running frontend)" fe-old
expect_eq "old tag restored" "$(tagged backend)" old
grep -q 'backend is unhealthy' "$PROJECT/update/status/status.json" && pass "health cause reported" || fail "health cause reported"
grep -q 'Recreated' "$PROJECT/update/status/status.json" && fail "compose progress not reported as the cause" || pass "compose progress not reported as the cause"

scenario "unhealthy with new migrations stops without rollback"
new_image new 3.160.0 001_a.js 002_b.js 003_c.js
echo new > "$FAKE_STATE/broken"
run_updater
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" migrations_may_have_run
expect_eq "backend left on new" "$(running backend)" new

scenario "compose files come from the running stack"
echo "$PROJECT/docker-compose.production.yml,$PROJECT/docker-compose.override.yml" > "$FAKE_STATE/config_files"
run_updater
expect_eq "state" "$(status_field state)" succeeded
grep -q -- "-f $PROJECT/docker-compose.production.yml -f $PROJECT/docker-compose.override.yml up" "$FAKE_STATE/calls" \
    && pass "up uses both files" || fail "up uses both files"

scenario "unexpected docker failure mid-run is reported, not left running"
touch "$FAKE_STATE/fail_label_read"
run_updater
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" internal_error
expect_eq "step recorded" "$(status_field step)" verify

scenario "a request filed while another updater runs an update is dropped"
mkdir -p "$PROJECT/update/status"
printf '{\n  "state": "running",\n}\n' > "$PROJECT/update/status/status.json"
exec 8>"$PROJECT/update/status/.lock"
if has_real_flock; then
    flock -n 8
    run_updater
    expect_eq "lock holder blocks the run" "$(running backend)" old
    # Left in place, the marker would keep the systemd path unit retriggering.
    [[ ! -e "$PROJECT/update/request/update-requested" ]] && pass "request dropped" || fail "request dropped"
    grep -q 'covered by it' "$PROJECT.log" && pass "drop is logged" || fail "drop is logged"
    flock -u 8
else
    echo "  skip (no flock on this host)"
fi
exec 8>&-

scenario "a request filed while another updater is only polling is kept"
mkdir -p "$PROJECT/update/status"
printf '{\n  "state": "idle",\n}\n' > "$PROJECT/update/status/status.json"
exec 8>"$PROJECT/update/status/.lock"
if has_real_flock; then
    flock -n 8
    run_updater
    expect_eq "lock holder blocks the run" "$(running backend)" old
    [[ -e "$PROJECT/update/request/update-requested" ]] && pass "request kept for the next pass" || fail "request kept for the next pass"
    flock -u 8
else
    echo "  skip (no flock on this host)"
fi
exec 8>&-

scenario "lock file is not readable by the backend"
run_updater
expect_eq "mode 0600" "$(ls -l "$PROJECT/update/status/.lock" | cut -c1-10)" "-rw-------"

scenario "planted non-empty directory is moved aside, never walked"
rm "$PROJECT/update/request/update-requested"
mkdir -p "$PROJECT/update/request/update-requested/nested"
touch "$PROJECT/update/request/update-requested/nested/file"
run_updater; code=$?
expect_eq "run does not abort" "$code" 0
expect_eq "state" "$(status_field state)" succeeded
expect_eq "request dir empty" "$(ls -A "$PROJECT/update/request")" ""
[[ -f "$PROJECT/update/status/.rejected-request/nested/file" ]] && pass "tree moved intact to status/" || fail "tree moved intact to status/"

scenario "a second planted directory is refused while one is set aside"
rm "$PROJECT/update/request/update-requested"
mkdir -p "$PROJECT/update/status/.rejected-request" "$PROJECT/update/request/update-requested/nested"
run_updater; code=$?
expect_eq "run does not abort" "$code" 0
expect_eq "backend untouched" "$(running backend)" old
[[ -d "$PROJECT/update/request/update-requested/nested" ]] && pass "planted tree left alone" || fail "planted tree left alone"
grep -q 'refusing it' "$PROJECT.log" && pass "refusal logged" || fail "refusal logged"

scenario "planted empty directory is removed"
rm "$PROJECT/update/request/update-requested"
mkdir "$PROJECT/update/request/update-requested"
run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "request dir empty" "$(ls -A "$PROJECT/update/request")" ""

scenario "pre-planted symlink next to the marker receives nothing"
mkdir -p "$PROJECT.target-dir"
ln -s "$PROJECT.target-dir" "$PROJECT/update/request/.claimed.12345"
run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "target dir still empty" "$(ls -A "$PROJECT.target-dir")" ""

scenario "planted FIFO as request is claimed without being read"
rm "$PROJECT/update/request/update-requested"
mkfifo "$PROJECT/update/request/update-requested"
run_updater; code=$?
expect_eq "run does not abort" "$code" 0
expect_eq "state" "$(status_field state)" succeeded
expect_eq "request dir empty" "$(ls -A "$PROJECT/update/request")" ""

scenario "crash-looping backend is named as the cause"
echo new > "$FAKE_STATE/crashing"
run_updater
expect_eq "state" "$(status_field state)" rolled_back
grep -q 'backend is restarting' "$PROJECT/update/status/status.json" && pass "cause reported" || fail "cause reported"

scenario "service without a container is named as the cause"
echo frontend > "$FAKE_STATE/no_container"
run_updater
# It stays gone during the rollback too, so the rollback cannot succeed either.
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" rollback_failed
grep -q 'frontend has no container' "$PROJECT/update/status/status.json" && pass "cause reported" || fail "cause reported"

scenario "service without a healthcheck counts as healthy when running"
echo frontend > "$FAKE_STATE/no_healthcheck"
run_updater
expect_eq "state" "$(status_field state)" succeeded

scenario "leftover compose run container is ignored"
touch "$FAKE_STATE/oneoff_leftover"
run_updater
expect_eq "state" "$(status_field state)" succeeded

scenario "trailing slash on the project dir still matches"
PROJECT_DIR_OVERRIDE="$PROJECT/" run_updater
expect_eq "state" "$(status_field state)" succeeded

scenario "only a non-backend image moved"
echo old > "$FAKE_STATE/registry/backend"
run_updater
expect_eq "state" "$(status_field state)" succeeded
grep -q 'stays at 3.159.0; updated the frontend image' "$PROJECT/update/status/status.json" \
    && pass "says what changed" || fail "says what changed"

scenario "container packaging hands its restart to the new updater image"
new_image upd-old 1.0.0; new_image upd-new 1.0.1
echo upd-old > "$FAKE_STATE/running/updater"; echo upd-old > "$FAKE_STATE/tags/updater"; echo upd-new > "$FAKE_STATE/registry/updater"
PACKAGING=container run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "updater not recreated by the app update" "$(running updater)" upd-old
grep -q '^run -d --rm --name picpeak-updater-handoff .* upd-new recreate-self$' "$FAKE_STATE/calls" \
    && pass "hand-off started from the new image" || fail "hand-off started from the new image"

scenario "container packaging leaves an unchanged updater alone"
new_image upd-old 1.0.0
echo upd-old > "$FAKE_STATE/running/updater"; echo upd-old > "$FAKE_STATE/tags/updater"; echo upd-old > "$FAKE_STATE/registry/updater"
PACKAGING=container run_updater
grep -q '^run ' "$FAKE_STATE/calls" && fail "no hand-off" || pass "no hand-off"

scenario "container packaging gives up on its own pull after one attempt"
new_image upd-old 1.0.0
echo upd-old > "$FAKE_STATE/running/updater"; echo upd-old > "$FAKE_STATE/tags/updater"
PACKAGING=container run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "one pull of the updater image" "$(grep -c '^pull -q ghcr.io/picpeak/picpeak/updater:1$' "$FAKE_STATE/calls")" 1

scenario "SIGTERM during an update is recorded as interrupted"
touch "$FAKE_STATE/slow_up"
PATH="$ROOT/bin:$PATH" PICPEAK_PROJECT_DIR="$PROJECT" PICPEAK_UPDATE_DIR="$PROJECT/update" \
    PICPEAK_UPDATER_HEALTH_TIMEOUT=1 bash "$UPDATER" watch 2>"$PROJECT.log" &
watch_pid=$!
for _ in $(seq 1 100); do [[ "$(status_field step 2>/dev/null)" == recreate ]] && break; /bin/sleep 0.05; done
kill -TERM "$watch_pid"; wait "$watch_pid" 2>/dev/null
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" interrupted

scenario "SIGTERM during a host-agent run is recorded as interrupted"
touch "$FAKE_STATE/slow_up"
PATH="$ROOT/bin:$PATH" PICPEAK_PROJECT_DIR="$PROJECT" PICPEAK_UPDATE_DIR="$PROJECT/update" \
    PICPEAK_UPDATER_HEALTH_TIMEOUT=1 bash "$UPDATER" run 2>"$PROJECT.log" &
run_pid=$!
for _ in $(seq 1 100); do [[ "$(status_field step 2>/dev/null)" == recreate ]] && break; /bin/sleep 0.05; done
kill -TERM "$run_pid"; wait "$run_pid" 2>/dev/null
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" interrupted

scenario "watch processes a request and stops promptly on SIGTERM"
rm "$PROJECT/update/request/update-requested"
PATH="$ROOT/bin:$PATH" PICPEAK_PROJECT_DIR="$PROJECT" PICPEAK_UPDATE_DIR="$PROJECT/update" \
    PICPEAK_UPDATER_HEALTH_TIMEOUT=1 bash "$UPDATER" watch 2>"$PROJECT.log" &
watch_pid=$!
for _ in $(seq 1 100); do [[ -f "$PROJECT/update/status/status.json" ]] && break; /bin/sleep 0.1; done
touch "$PROJECT/update/request/update-requested"
for _ in $(seq 1 100); do [[ "$(status_field state)" == succeeded ]] && break; /bin/sleep 0.1; done
expect_eq "state" "$(status_field state)" succeeded
kill -TERM "$watch_pid"
for _ in $(seq 1 50); do kill -0 "$watch_pid" 2>/dev/null || break; /bin/sleep 0.1; done
if kill -0 "$watch_pid" 2>/dev/null; then
    fail "exits within 5 s of SIGTERM"; kill -KILL "$watch_pid"
else
    pass "exits within 5 s of SIGTERM"
fi
wait "$watch_pid" 2>/dev/null

scenario "request dir is created when missing"
rm -rf "$PROJECT/update/request"
run_updater init
[[ -d "$PROJECT/update/request" ]] && pass "request dir exists" || fail "request dir exists"

scenario "interrupted run is reported"
mkdir -p "$PROJECT/update/status"
printf '{\n  "state": "running",\n  "from_version": "3.159.0",\n  "started_at": "2026-10-03T10:00:00Z",\n}\n' \
    > "$PROJECT/update/status/status.json"
rm "$PROJECT/update/request/update-requested"
run_updater init
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" interrupted
expect_eq "from kept" "$(status_field from_version)" 3.159.0

scenario "planted symlink as request is removed, not followed"
rm "$PROJECT/update/request/update-requested"
echo keep > "$PROJECT.target"
ln -s "$PROJECT.target" "$PROJECT/update/request/update-requested"
run_updater
expect_eq "target intact" "$(cat "$PROJECT.target")" keep
expect_eq "state" "$(status_field state)" succeeded
expect_eq "request dir empty" "$(ls -A "$PROJECT/update/request")" ""

echo
echo "$PASSES passed, $FAILS failed"
(( FAILS == 0 ))
