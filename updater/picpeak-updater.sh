#!/usr/bin/env bash

################################################################################
# PicPeak updater
#
# Updates a docker-compose.production.yml install to the latest image of its
# channel when the backend asks for it. One script, two packagings:
#
#   host       systemd path unit installed by scripts/picpeak-setup.sh
#              (--enable-self-update). Nothing in a container holds the socket.
#   container  the `updater` compose service behind `profiles: [updater]`, for
#              hosts without shell access. Holds the Docker socket.
#
# File contract (version 1), all under $PICPEAK_UPDATE_DIR:
#
#   request/update-requested   The backend creates it to ask for an update.
#                              Only its existence counts; the content is never
#                              read. There is no version argument: v1 always
#                              updates to whatever the channel tag points at.
#   status/status.json         Written by the updater only (the backend mounts
#                              status/ read-only). See docs/self-update.md.
#
# The updater enforces its own rules, because the backend is the component we
# assume compromised: no source builds, no downgrades, and no release whose
# backend image label io.picpeak.update.auto-from is newer than the running
# version (that release needs manual operator steps).
################################################################################

set -euo pipefail

readonly UPDATER_VERSION="1.0.1"
readonly CONTRACT_VERSION=1
readonly AUTO_FROM_LABEL="io.picpeak.update.auto-from"

PROJECT_DIR="${PICPEAK_PROJECT_DIR:-}"
# Compose records working_dir without a trailing slash; compare like with like.
PROJECT_DIR="${PROJECT_DIR%/}"
UPDATE_DIR="${PICPEAK_UPDATE_DIR:-${PROJECT_DIR:+$PROJECT_DIR/update}}"
PACKAGING="${PICPEAK_UPDATER_PACKAGING:-host}"
SELF_SERVICE="${PICPEAK_UPDATER_SERVICE:-updater}"
SELF_PROFILE="${PICPEAK_UPDATER_PROFILE:-updater}"
HEALTH_TIMEOUT="${PICPEAK_UPDATER_HEALTH_TIMEOUT:-600}"
PULL_ATTEMPTS="${PICPEAK_UPDATER_PULL_ATTEMPTS:-5}"
PULL_BACKOFF="${PICPEAK_UPDATER_PULL_BACKOFF:-15}"
POLL_INTERVAL="${PICPEAK_UPDATER_POLL_INTERVAL:-5}"
# Minutes a request may wait before it is discarded instead of run. The backend
# withdraws its own unclaimed request after 10 minutes; this is the backstop
# for one it could not withdraw (it was down, or a stopped updater comes back
# days later and must not update unattended with a backup that old).
REQUEST_MAX_AGE="${PICPEAK_UPDATER_REQUEST_MAX_AGE:-15}"

REQUEST_DIR=""
REQUEST_FILE=""
STATUS_DIR=""
STATUS_FILE=""
LOCK_FILE=""

# Status fields, written as one JSON document by write_status.
ST_STATE="idle"
ST_REASON=""
ST_STEP=""
ST_MESSAGE=""
ST_FROM=""
ST_TO=""
ST_IMAGE=""
ST_STARTED=""
ST_FINISHED=""

# Snapshot of the running stack, filled by snapshot_stack.
PROJECT_NAME=""
COMPOSE_FILES=()
SERVICES=()
IMAGE_REFS=()
OLD_IDS=()
BACKEND_INDEX=-1
LAST_ERROR=""

log() { printf '%s [picpeak-updater] %s\n' "$(now)" "$*" >&2; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

die_usage() {
    log "$1"
    exit 2
}

################################################################################
# Status file
################################################################################

json_value() {
    local s="$1"
    if [[ -z "$s" ]]; then
        printf 'null'
        return
    fi
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/\\r}
    s=${s//$'\t'/\\t}
    s=$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037')
    printf '"%s"' "$s"
}

# status/ is writable by the updater alone (the backend mounts it read-only),
# so a temp file + rename there cannot be redirected through a planted symlink.
write_status() {
    local tmp
    tmp=$(mktemp "$STATUS_DIR/.status.XXXXXX")
    {
        printf '{\n'
        printf '  "contract": %s,\n' "$CONTRACT_VERSION"
        printf '  "updater_version": %s,\n' "$(json_value "$UPDATER_VERSION")"
        printf '  "packaging": %s,\n' "$(json_value "$PACKAGING")"
        printf '  "state": %s,\n' "$(json_value "$ST_STATE")"
        printf '  "reason": %s,\n' "$(json_value "$ST_REASON")"
        printf '  "step": %s,\n' "$(json_value "$ST_STEP")"
        printf '  "message": %s,\n' "$(json_value "$ST_MESSAGE")"
        printf '  "from_version": %s,\n' "$(json_value "$ST_FROM")"
        printf '  "to_version": %s,\n' "$(json_value "$ST_TO")"
        printf '  "image": %s,\n' "$(json_value "$ST_IMAGE")"
        printf '  "started_at": %s,\n' "$(json_value "$ST_STARTED")"
        printf '  "finished_at": %s,\n' "$(json_value "$ST_FINISHED")"
        printf '  "updated_at": %s\n' "$(json_value "$(now)")"
        printf '}\n'
    } > "$tmp"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$STATUS_FILE"
}

set_step() {
    ST_STEP="$1"
    ST_MESSAGE="$2"
    log "$2"
    write_status
}

# Terminal states: succeeded | up_to_date | refused | failed | rolled_back
finish() {
    ST_STATE="$1"
    ST_REASON="$2"
    ST_MESSAGE="$3"
    ST_FINISHED="$(now)"
    log "$ST_STATE${ST_REASON:+ ($ST_REASON)}: $ST_MESSAGE"
    write_status
}

# A status still saying "running" when no run holds the lock means the last run
# died mid-way (host reboot, container killed). Say so instead of leaving the UI
# spinning forever.
mark_interrupted_run() {
    [[ -f "$STATUS_FILE" ]] || return 0
    grep -q '"state": "running"' "$STATUS_FILE" || return 0
    ST_FROM=$(sed -n 's/^  "from_version": "\(.*\)",$/\1/p' "$STATUS_FILE")
    ST_STARTED=$(sed -n 's/^  "started_at": "\(.*\)",$/\1/p' "$STATUS_FILE")
    finish failed interrupted "The previous update run was interrupted before it finished. Check that PicPeak is running, then try again."
}

################################################################################
# Versions
################################################################################

V_MAJ=0; V_MIN=0; V_PAT=0; V_PRE=""

parse_version() {
    [[ "$1" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)(-beta\.([0-9]+))?$ ]] || return 1
    V_MAJ=${BASH_REMATCH[1]}
    V_MIN=${BASH_REMATCH[2]}
    V_PAT=${BASH_REMATCH[3]}
    V_PRE=${BASH_REMATCH[5]:-}
}

# Prints -1, 0 or 1. Returns 1 when either version cannot be parsed, so every
# caller can fail closed. A stable release sorts above its own betas.
version_cmp() {
    parse_version "$1" || return 1
    local a=("$V_MAJ" "$V_MIN" "$V_PAT") a_pre="$V_PRE"
    parse_version "$2" || return 1
    local b=("$V_MAJ" "$V_MIN" "$V_PAT") b_pre="$V_PRE"
    local i
    for i in 0 1 2; do
        if (( 10#${a[i]} > 10#${b[i]} )); then echo 1; return 0; fi
        if (( 10#${a[i]} < 10#${b[i]} )); then echo -1; return 0; fi
    done
    if [[ "$a_pre" == "$b_pre" ]]; then echo 0; return 0; fi
    if [[ -z "$a_pre" ]]; then echo 1; return 0; fi
    if [[ -z "$b_pre" ]]; then echo -1; return 0; fi
    if (( 10#$a_pre > 10#$b_pre )); then echo 1; else echo -1; fi
}

################################################################################
# Docker helpers
################################################################################

# The guarded expansion keeps an empty COMPOSE_FILES from tripping `set -u` on
# bash before 4.4.
compose() {
    docker compose --project-directory "$PROJECT_DIR" -p "$PROJECT_NAME" ${COMPOSE_FILES[@]+"${COMPOSE_FILES[@]}"} "$@"
}

# Reads one file out of an image without running it.
image_file() {
    local image="$1" path="$2" cid out
    cid=$(docker create "$image") || return 1
    out=$(docker cp "$cid:$path" - 2>/dev/null | tar -xOf - 2>/dev/null) || true
    docker rm -f "$cid" >/dev/null 2>&1 || true
    [[ -n "$out" ]] || return 1
    printf '%s\n' "$out"
}

image_version() {
    image_file "$1" /app/package.json \
        | sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' | head -n 1
}

image_migrations() {
    local cid
    cid=$(docker create "$1") || return 1
    docker cp "$cid:/app/migrations" - 2>/dev/null | tar -tf - 2>/dev/null \
        | grep '\.js$' | grep -v '/helpers\.js$' | grep -v '/run-migrations' | sort || true
    docker rm -f "$cid" >/dev/null 2>&1 || true
}

image_label() {
    docker image inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null | sed 's/^<no value>$//'
}

# Finds the compose project from the backend container's own labels. This also
# proves the project dir is mounted at the identical host path: compose resolves
# relative bind mounts against it, and a mismatch would recreate the stack on
# empty storage.
discover_project() {
    local ids
    # oneoff=False skips leftovers of `docker compose run backend ...`, which
    # carry the same service label.
    ids=$(docker ps -a \
        --filter "label=com.docker.compose.service=backend" \
        --filter "label=com.docker.compose.oneoff=False" \
        --filter "label=com.docker.compose.project.working_dir=$PROJECT_DIR" \
        --format '{{.ID}}')
    if [[ -z "$ids" ]]; then
        LAST_ERROR="No PicPeak backend container belongs to a compose project in $PROJECT_DIR. In the container variant the project directory must be mounted at the identical host path (PICPEAK_PROJECT_DIR)."
        return 1
    fi
    if [[ $(wc -l <<<"$ids") -ne 1 ]]; then
        LAST_ERROR="More than one PicPeak backend container belongs to $PROJECT_DIR."
        return 1
    fi
    PROJECT_NAME=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$ids")
    [[ -n "$PROJECT_NAME" ]] || { LAST_ERROR="Could not read the compose project name."; return 1; }

    # Use the compose files the stack was started with, not whatever a plain
    # `docker compose` in that directory would pick: an install started with
    # `-f docker-compose.production.yml` and no COMPOSE_FILE in .env would
    # otherwise be read through the source-build docker-compose.yml.
    local files f
    files=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$ids" | sed 's/^<no value>$//')
    COMPOSE_FILES=()
    local IFS=','
    for f in $files; do
        [[ -n "$f" ]] && COMPOSE_FILES+=(-f "$f")
    done
}

# Records every running service with the image ref compose uses and the image ID
# it runs, so a failed update can retag the old IDs and bring them back.
snapshot_stack() {
    SERVICES=(); IMAGE_REFS=(); OLD_IDS=(); BACKEND_INDEX=-1
    local line svc ref id
    while IFS=$'\t' read -r svc ref id; do
        [[ -n "$svc" ]] || continue
        [[ "$svc" == "$SELF_SERVICE" ]] && continue
        SERVICES+=("$svc"); IMAGE_REFS+=("$ref"); OLD_IDS+=("$id")
        [[ "$svc" == "backend" ]] && BACKEND_INDEX=$(( ${#SERVICES[@]} - 1 ))
    done < <(docker ps \
        --filter "label=com.docker.compose.project=$PROJECT_NAME" \
        --filter "label=com.docker.compose.oneoff=False" \
        --filter status=running \
        --format '{{.ID}}' \
        | while read -r line; do
            docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}{{"\t"}}{{.Config.Image}}{{"\t"}}{{.Image}}' "$line"
        done | sort -u)
    (( BACKEND_INDEX >= 0 )) || { LAST_ERROR="The backend is not running; start PicPeak before updating."; return 1; }
}

is_source_build() {
    local digests
    digests=$(docker image inspect -f '{{ len .RepoDigests }}' "${OLD_IDS[$BACKEND_INDEX]}" 2>/dev/null || echo 0)
    [[ "$digests" == "0" ]] && return 0
    compose config 2>/dev/null | grep -qE '^[[:space:]]+build:' && return 0
    return 1
}

restore_tags() {
    local i
    for i in "${!SERVICES[@]}"; do
        docker tag "${OLD_IDS[i]}" "${IMAGE_REFS[i]}" || log "could not retag ${IMAGE_REFS[i]}"
    done
}

# Retries with backoff and jitter, and reports the real exit status. A single
# pull that fails on a registry rate limit must not read as "updated".
pull_with_retry() {
    retry_pull compose pull --quiet "$@"
}

retry_pull() {
    local attempt=1 delay="$PULL_BACKOFF" out
    while :; do
        if out=$("$@" 2>&1); then
            return 0
        fi
        LAST_ERROR=$(tail -n 3 <<<"$out")
        log "pull attempt $attempt/$PULL_ATTEMPTS failed: $LAST_ERROR"
        if (( attempt >= PULL_ATTEMPTS )); then
            return 1
        fi
        sleep $(( delay + RANDOM % 10 ))
        delay=$(( delay * 2 ))
        attempt=$(( attempt + 1 ))
    done
}

# Every service is running, and healthy where it has a healthcheck.
# Checks before it looks at the clock: on a loaded host the deadline can pass
# before the first check, and giving up without one leaves LAST_ERROR naming
# whatever failed earlier.
wait_healthy() {
    local deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) svc cids cid state health all_ok
    while :; do
        all_ok=true
        for svc in "${SERVICES[@]}"; do
            # -a: a crash-looping container is not "running" and would vanish
            # from the list, leaving no cause to report. Every replica counts.
            cids=$(compose ps -a -q "$svc" 2>/dev/null || true)
            if [[ -z "$cids" ]]; then
                all_ok=false
                LAST_ERROR="$svc has no container"
                break
            fi
            for cid in $cids; do
                state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || echo missing)
                health=$(docker inspect -f '{{ if .State.Health }}{{.State.Health.Status}}{{ end }}' "$cid" 2>/dev/null || true)
                if [[ "$state" != "running" ]] || [[ -n "$health" && "$health" != "healthy" ]]; then
                    all_ok=false
                    LAST_ERROR="$svc is ${health:-$state}"
                    break 2
                fi
            done
        done
        $all_ok && return 0
        (( $(date +%s) < deadline )) || return 1
        sleep 5
    done
}

################################################################################
# Update
################################################################################

do_update() {
    ST_STATE="running"; ST_REASON=""; ST_FROM=""; ST_TO=""; ST_IMAGE=""; ST_FINISHED=""
    ST_STARTED="$(now)"
    set_step discover "Checking the installation"

    if ! discover_project || ! snapshot_stack; then
        finish failed not_found "$LAST_ERROR"
        return
    fi
    ST_IMAGE="${IMAGE_REFS[$BACKEND_INDEX]}"

    if is_source_build; then
        finish refused source_build "This install is built from source. One-click updates only work with the prebuilt images from docker-compose.production.yml."
        return
    fi

    local old_backend="${OLD_IDS[$BACKEND_INDEX]}"
    ST_FROM=$(image_version "$old_backend" || true)
    if ! parse_version "$ST_FROM"; then
        finish refused unknown_version "Could not read the running PicPeak version."
        return
    fi

    set_step pull "Downloading the latest images for $ST_IMAGE"
    if ! pull_with_retry "${SERVICES[@]}"; then
        restore_tags
        finish failed pull_failed "Downloading the new images failed after $PULL_ATTEMPTS attempts. Nothing was changed. Last error: $LAST_ERROR"
        return
    fi

    local i changed=false changed_services="" new_ids=()
    for i in "${!SERVICES[@]}"; do
        new_ids[i]=$(docker image inspect -f '{{.Id}}' "${IMAGE_REFS[i]}" 2>/dev/null || true)
        if [[ -z "${new_ids[i]}" ]]; then
            restore_tags
            finish failed pull_failed "The pull reported success but ${IMAGE_REFS[i]} is not available locally. Nothing was changed."
            return
        fi
        if [[ "${new_ids[i]}" != "${OLD_IDS[i]}" ]]; then
            changed=true
            changed_services+="${changed_services:+, }${SERVICES[i]}"
        fi
    done
    local new_backend="${new_ids[$BACKEND_INDEX]}"
    ST_TO=$(image_version "$new_backend" || true)

    if ! $changed; then
        ST_TO="$ST_FROM"
        finish up_to_date "" "PicPeak $ST_FROM is already the latest version of this channel."
        self_update
        return
    fi

    set_step verify "Checking PicPeak $ST_TO before installing it"
    local cmp
    if ! cmp=$(version_cmp "$ST_TO" "$ST_FROM"); then
        restore_tags
        finish refused unknown_version "Could not read the version of the downloaded image. Nothing was changed."
        return
    fi
    if [[ "$cmp" == "-1" ]]; then
        restore_tags
        finish refused downgrade "The channel tag points at $ST_TO, which is older than the running $ST_FROM. Downgrades are not supported. Nothing was changed."
        return
    fi
    local auto_from
    auto_from=$(image_label "$new_backend" "$AUTO_FROM_LABEL")
    if [[ -n "$auto_from" ]]; then
        if ! cmp=$(version_cmp "$ST_FROM" "$auto_from"); then
            restore_tags
            finish refused unknown_version "The new image carries an unreadable $AUTO_FROM_LABEL label ($auto_from). Nothing was changed."
            return
        fi
        if [[ "$cmp" == "-1" ]]; then
            restore_tags
            finish refused manual_required "PicPeak $ST_TO needs manual steps when updating from versions before $auto_from. Follow the release notes to update. Nothing was changed."
            return
        fi
    fi

    local new_migrations
    new_migrations=$(comm -13 <(image_migrations "$old_backend") <(image_migrations "$new_backend") | wc -l | tr -d ' ')

    set_step recreate "Installing PicPeak $ST_TO"
    # compose writes its progress to stderr too, so its output only explains a
    # failure of `up` itself; otherwise wait_healthy's LAST_ERROR is the cause.
    if compose up -d --no-build "${SERVICES[@]}" >/dev/null 2>"$WORK_DIR/up.err"; then
        set_step health "Waiting for PicPeak $ST_TO to start"
        if wait_healthy; then
            if [[ "$ST_TO" == "$ST_FROM" ]]; then
                finish succeeded "" "PicPeak stays at $ST_FROM; updated the $changed_services image(s)."
            else
                finish succeeded "" "Updated PicPeak from $ST_FROM to $ST_TO."
            fi
            self_update
            return
        fi
    else
        LAST_ERROR=$(tail -n 3 "$WORK_DIR/up.err")
    fi

    # Rolling back images is only safe while the database is still on the old
    # schema. If the new version ships migrations they may already have run, and
    # the old code against a migrated database is worse than a stopped update.
    # No new migration files does not mean no database writes: the boot-time
    # seeders in server.js run after migrations. They are additive, so the old
    # version still runs against what they leave behind.
    if (( new_migrations > 0 )); then
        finish failed migrations_may_have_run "PicPeak $ST_TO did not become healthy ($LAST_ERROR). It ships $new_migrations database migration(s) that may already have run, so the old version was not brought back automatically. Restore the backup taken before the update (see docs/self-update.md)."
        return
    fi

    local cause="$LAST_ERROR"
    set_step rollback "PicPeak $ST_TO did not become healthy ($cause). Bringing back $ST_FROM"
    restore_tags
    if compose up -d --no-build "${SERVICES[@]}" >/dev/null 2>&1 && wait_healthy; then
        finish rolled_back "" "PicPeak $ST_TO did not start ($cause), so $ST_FROM was brought back. Nothing else changed."
    else
        finish failed rollback_failed "PicPeak $ST_TO did not start ($cause) and bringing back $ST_FROM failed too ($LAST_ERROR). Check the server."
    fi
}

# Container packaging only. The updater pulls its own image and, when it
# changed, hands the restart to a short-lived container started from the new
# image, so it never goes stale and never stops itself mid-run. The host agent
# is refreshed by `picpeak-setup.sh --update` instead: it never fetches code to
# run as root on its own.
self_update() {
    [[ "$PACKAGING" == "container" ]] || return 0
    # One attempt: a failure here only delays the updater's own refresh to the
    # next run, and retrying would hold the lock for minutes.
    local PULL_ATTEMPTS=1
    local self ref old new
    self=$(docker ps -q \
        --filter "label=com.docker.compose.project=$PROJECT_NAME" \
        --filter "label=com.docker.compose.service=$SELF_SERVICE" | head -n 1)
    [[ -n "$self" ]] || return 0
    ref=$(docker inspect -f '{{.Config.Image}}' "$self") || return 0
    old=$(docker inspect -f '{{.Image}}' "$self") || return 0
    # Pull the image itself rather than the service: the profile may have been
    # enabled on the command line only, and compose then does not know it.
    if ! retry_pull docker pull -q "$ref"; then
        log "could not pull a newer updater image: $LAST_ERROR"
        return 0
    fi
    new=$(docker image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)
    [[ -n "$new" && "$new" != "$old" ]] || return 0
    log "restarting on the new updater image $ref"
    docker rm -f "${PROJECT_NAME}-updater-handoff" >/dev/null 2>&1 || true
    docker run -d --rm --name "${PROJECT_NAME}-updater-handoff" \
        --network none \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "$PROJECT_DIR:$PROJECT_DIR:ro" \
        -e "PICPEAK_PROJECT_DIR=$PROJECT_DIR" \
        -e "PICPEAK_UPDATER_SERVICE=$SELF_SERVICE" \
        -e "PICPEAK_UPDATER_PROFILE=$SELF_PROFILE" \
        --entrypoint /usr/local/bin/picpeak-updater \
        "$new" recreate-self >/dev/null \
        || log "could not start the updater hand-off container"
}

################################################################################
# Commands
################################################################################

WORK_DIR=""

setup_paths() {
    [[ -n "$PROJECT_DIR" ]] || die_usage "PICPEAK_PROJECT_DIR is not set."
    [[ "$PROJECT_DIR" == /* ]] || die_usage "PICPEAK_PROJECT_DIR must be an absolute path."
    [[ -d "$PROJECT_DIR" ]] || die_usage "PICPEAK_PROJECT_DIR ($PROJECT_DIR) does not exist."
    [[ -n "$UPDATE_DIR" ]] || die_usage "PICPEAK_UPDATE_DIR is not set."
    REQUEST_DIR="$UPDATE_DIR/request"
    REQUEST_FILE="$REQUEST_DIR/update-requested"
    STATUS_DIR="$UPDATE_DIR/status"
    STATUS_FILE="$STATUS_DIR/status.json"
    # The lock lives in status/, which only updaters can write. Both packagings
    # see the same directory, so a host agent and a container enabled on one
    # install still never run at the same time.
    LOCK_FILE="$STATUS_DIR/.lock"
    mkdir -p "$STATUS_DIR"
    # request/ belongs to the backend (UID 1001). The setup script creates it;
    # the container variant has no shell to do that, so create it here.
    if [[ ! -d "$REQUEST_DIR" ]]; then
        mkdir -p "$REQUEST_DIR"
        chown 1001:1001 "$REQUEST_DIR" 2>/dev/null || log "could not chown $REQUEST_DIR to UID 1001"
        chmod 0750 "$REQUEST_DIR"
    fi
    WORK_DIR=$(mktemp -d)
    trap on_exit EXIT
    # Without this, bash still runs the EXIT trap on SIGTERM, but with $? = 1,
    # so a stop mid-update (`docker compose down`, a host shutdown stopping the
    # oneshot) would be recorded as an unexplained internal_error. With it,
    # on_exit sees 143 and records "interrupted". bash runs the trap once the
    # current command returns.
    trap 'exit 143' TERM
    open_lock
}

# flock(2) needs only a read-only descriptor, and status/ is mounted into the
# backend read-only: a lock file the backend can open is one it can hold
# forever, blocking every run. Create it 0600 under umask 077, so it is never
# readable even for an instant, and tighten one left with looser permissions.
# fd 9 stays open for the life of the process.
open_lock() {
    local old_umask
    old_umask=$(umask)
    umask 077
    exec 9>"$LOCK_FILE"
    umask "$old_umask"
    chmod 0600 "$LOCK_FILE"
}

# A command that fails under `set -e` mid-update must not leave the status on
# "running": the UI would spin until the next run marks it interrupted.
on_exit() {
    local code=$?
    if [[ "$ST_STATE" == "running" && -n "$STATUS_FILE" ]]; then
        if (( code == 143 )); then
            finish failed interrupted "The updater was stopped during step '$ST_STEP'. Check that PicPeak is running, then try again." || true
        else
            finish failed internal_error "The updater stopped unexpectedly during step '$ST_STEP' (exit $code). Check the updater log." || true
        fi
    fi
    rm -rf "$WORK_DIR"
}

# Clears the marker before anything else, so a failing run is never retriggered
# in a loop by the systemd path unit. request/ belongs to the backend, so root
# must not rename anything into it or walk a tree in it: unlink(2) and rmdir(2)
# act on the name itself, never follow a link and never descend. The lock
# already serialises updaters, so no rename is needed to claim the request.
claim_request() {
    [[ -e "$REQUEST_FILE" || -L "$REQUEST_FILE" ]] || return 1
    rm -f -- "$REQUEST_FILE" 2>/dev/null || rmdir -- "$REQUEST_FILE" 2>/dev/null || true
    if [[ -e "$REQUEST_FILE" || -L "$REQUEST_FILE" ]]; then
        # A non-empty directory. Move it out of the trigger path to a fixed
        # name in status/: only updaters can write there, so a name found
        # absent stays absent, and mv renames rather than moving into anything.
        # Same filesystem (both under update/), so it is a rename, not a copy.
        # It is never deleted recursively; one left from an earlier run means
        # the backend is planting trees, and the request is refused.
        local rejected="$STATUS_DIR/.rejected-request"
        if [[ -e "$rejected" || -L "$rejected" ]]; then
            log "the request marker is a non-empty directory and $rejected already exists; refusing it"
            return 1
        fi
        mv -- "$REQUEST_FILE" "$rejected" 2>/dev/null \
            || { log "could not clear the request marker"; return 1; }
        log "the request marker was a non-empty directory; moved aside to $rejected"
    fi
    return 0
}

# The lock is only ever taken in an `if` condition and the work runs in its
# body: a function called from a condition runs with `set -e` suspended, which
# would silently disable the internal_error reporting in do_update.
# True when the marker is older than REQUEST_MAX_AGE minutes. find looks at
# the entry itself (it does not follow links by default), in GNU, BSD and
# busybox alike. Checked before claiming, because claiming removes it.
request_is_stale() {
    [[ -n "$(find "$REQUEST_FILE" -maxdepth 0 -mmin "+$REQUEST_MAX_AGE" 2>/dev/null)" ]]
}

refuse_stale_request() {
    ST_STATE="running"; ST_REASON=""; ST_STEP=""; ST_FROM=""; ST_TO=""; ST_IMAGE=""; ST_FINISHED=""
    ST_STARTED="$(now)"
    finish refused request_expired "The update request was more than $REQUEST_MAX_AGE minutes old when the updater saw it, so it was discarded instead of run. Request the update again."
}

handle_request() {
    if flock -n 9; then
        local stale=false
        if request_is_stale; then stale=true; fi
        if claim_request; then
            if $stale; then
                refuse_stale_request
            else
                log "update requested"
                do_update
            fi
        fi
        flock -u 9
        return 0
    fi
    # Another updater holds the lock. Only while it is running an update is
    # this request covered (same channel tag), so only then drop it: left in
    # place it keeps the systemd path unit retriggering. A holder that is just
    # initialising or polling has not claimed it, so leave it for the next pass.
    if grep -q '"state": "running"' "$STATUS_FILE" 2>/dev/null && claim_request; then
        log "an update is already running; this request is covered by it"
    fi
}

init_status() {
    if ! flock -n 9; then
        return 0
    fi
    mark_interrupted_run
    if [[ ! -f "$STATUS_FILE" ]]; then
        ST_STATE="idle"
        write_status
    fi
    flock -u 9
}

cmd_run() {
    setup_paths
    init_status
    handle_request
}

cmd_watch() {
    setup_paths
    init_status
    log "watching $REQUEST_FILE (updater $UPDATER_VERSION, contract $CONTRACT_VERSION)"
    while :; do
        handle_request
        sleep "$POLL_INTERVAL"
    done
}

cmd_recreate_self() {
    [[ -n "$PROJECT_DIR" ]] || die_usage "PICPEAK_PROJECT_DIR is not set."
    sleep 5
    discover_project || die_usage "$LAST_ERROR"
    compose --profile "$SELF_PROFILE" up -d --no-deps --no-build "$SELF_SERVICE"
}

usage() {
    cat <<EOF
PicPeak updater $UPDATER_VERSION (file contract $CONTRACT_VERSION)

Usage: picpeak-updater <command>

  init           Create status/status.json if missing and mark an interrupted run.
  run            Process a pending update request once (systemd path unit).
  watch          Poll for update requests forever (container variant).
  version        Print the updater version.

Environment:
  PICPEAK_PROJECT_DIR             Absolute path of the PicPeak compose project (required)
  PICPEAK_UPDATE_DIR              Request/status directory (default: \$PICPEAK_PROJECT_DIR/update)
  PICPEAK_UPDATER_PACKAGING       host | container (default: host)
  PICPEAK_UPDATER_HEALTH_TIMEOUT  Seconds to wait for a healthy stack (default: 600)
  PICPEAK_UPDATER_PULL_ATTEMPTS   Pull attempts before giving up (default: 5)
  PICPEAK_UPDATER_REQUEST_MAX_AGE Minutes a request may wait before it is discarded (default: 15)
EOF
}

main() {
    case "${1:-}" in
        init) setup_paths; init_status ;;
        run) cmd_run ;;
        watch) cmd_watch ;;
        recreate-self) cmd_recreate_self ;;
        version|--version) echo "$UPDATER_VERSION" ;;
        help|--help|-h|"") usage ;;
        *) usage; exit 2 ;;
    esac
}

# Sourced by the tests for the pure helpers; executed otherwise.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
