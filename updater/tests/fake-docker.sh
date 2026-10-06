#!/usr/bin/env bash
# Stand-in for the docker CLI used by run-tests.sh. It models just enough of a
# compose stack (services, a registry, local tags, running containers) for
# picpeak-updater.sh to walk every path. State lives in $FAKE_STATE:
#
#   images/<id>/version|label|migrations|local   per-image facts
#   registry/<svc>     image id the channel tag points at upstream
#   tags/<svc>         image id the local tag points at
#   running/<svc>      image id the running container uses
#   pull_failures      number of pulls that fail before one succeeds
#   broken             image ids that run but never become healthy
#   crashing           image ids whose container restarts in a loop
#   no_container       services whose container is gone entirely
#   no_healthcheck     services without a healthcheck
#   oneoff_leftover    an exited `compose run backend` container exists
#   slow_up            `compose up` takes a second (to signal a run mid-way)
#   config_files       value of the compose config_files label (optional)
#   fail_label_read    when present, reading an image label fails
#   calls              every invocation, appended
#
# $FAKE_WORKING_DIR is the compose working_dir the backend was started from.
# The updater service, when present, is running/updater (tag ":1").
set -euo pipefail

S="$FAKE_STATE"
echo "$*" >> "$S/calls"

ref_of() {
    if [[ "$1" == updater ]]; then echo "ghcr.io/picpeak/picpeak/updater:1"
    else echo "ghcr.io/picpeak/picpeak/$1:stable"; fi
}
svc_of_ref() { local r="${1##*/}"; echo "${r%%:*}"; }
services() { ls "$S/running"; }
listed() { grep -qx "$1" "$S/$2" 2>/dev/null; }

if [[ "$1" == "compose" ]]; then
    # Skip the global options (--project-directory DIR -p NAME [-f FILE]...)
    shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project-directory|-p|-f|--profile) shift 2 ;;
            *) break ;;
        esac
    done
    case "$1" in
        config)
            [[ -f "$S/build_context" ]] && printf 'services:\n  backend:\n    build:\n      context: ./backend\n'
            exit 0 ;;
        pull)
            shift; [[ "${1:-}" == "--quiet" ]] && shift
            n=$(cat "$S/pull_failures" 2>/dev/null || echo 0)
            if (( n > 0 )); then
                echo $(( n - 1 )) > "$S/pull_failures"
                echo "Error response from daemon: toomanyrequests: retry later" >&2
                exit 1
            fi
            for svc in "$@"; do cp "$S/registry/$svc" "$S/tags/$svc"; done
            exit 0 ;;
        up)
            shift
            if [[ -f "$S/slow_up" ]]; then /bin/sleep 1; fi
            # Real compose reports progress on stderr even when it succeeds.
            echo " Container picpeak-backend  Recreated" >&2
            echo " Container picpeak-backend  Started" >&2
            for a in "$@"; do
                [[ "$a" == -* ]] && continue
                cp "$S/tags/$a" "$S/running/$a"
            done
            exit 0 ;;
        ps)
            svc="${!#}"
            listed "$svc" no_container || echo "c-$svc"
            exit 0 ;;
    esac
    echo "fake compose: unhandled $*" >&2; exit 99
fi

case "$1" in
    ps)
        args="$*"
        if [[ "$args" == *"com.docker.compose.service=backend"* ]]; then
            if [[ "$args" == *"working_dir=${FAKE_WORKING_DIR} "* || "$args" == *"working_dir=${FAKE_WORKING_DIR}" ]]; then
                echo "c-backend"
            fi
            if [[ -f "$S/oneoff_leftover" && "$args" != *"oneoff=False"* ]]; then echo "c-oneoff"; fi
        elif [[ "$args" == *"com.docker.compose.service=updater"* ]]; then
            if [[ -f "$S/running/updater" ]]; then echo "c-updater"; fi
        elif [[ "$args" == *"status=running"* ]]; then
            for s in $(services); do echo "c-$s"; done
        fi
        exit 0 ;;
    inspect)
        fmt="$3"; cid="$4"; svc="${cid#c-}"
        id=$(cat "$S/running/$svc" 2>/dev/null || true)
        case "$fmt" in
            *com.docker.compose.service*) printf '%s\t%s\t%s\n' "$svc" "$(ref_of "$svc")" "$id" ;;
            *com.docker.compose.project\"*) echo "picpeak" ;;
            *config_files*) cat "$S/config_files" 2>/dev/null || echo "<no value>" ;;
            *Config.Image*) ref_of "$svc" ;;
            *State.Status*) if listed "$id" crashing; then echo restarting; else echo running; fi ;;
            *State.Health*)
                if listed "$svc" no_healthcheck || listed "$id" crashing; then echo ""
                elif listed "$id" broken; then echo unhealthy
                else echo healthy; fi ;;
            *.Image*) echo "$id" ;;
            *) echo "fake inspect: $fmt" >&2; exit 99 ;;
        esac
        exit 0 ;;
    image)
        fmt="$4"; target="$5"
        if [[ "$target" == ghcr.io/* ]]; then
            f="$S/tags/$(svc_of_ref "$target")"
            [[ -f "$f" ]] || exit 1
            target=$(cat "$f")
        fi
        case "$fmt" in
            *RepoDigests*) [[ -f "$S/images/$target/local" ]] && echo 0 || echo 1 ;;
            *auto-from*)
                [[ -f "$S/fail_label_read" ]] && { echo "Error: daemon unreachable" >&2; exit 1; }
                cat "$S/images/$target/label" 2>/dev/null || echo "<no value>" ;;
            *.Id*) echo "$target" ;;
        esac
        exit 0 ;;
    pull)
        ref="${!#}"; svc=$(svc_of_ref "$ref")
        [[ -f "$S/registry/$svc" ]] || { echo "pull access denied for $ref" >&2; exit 1; }
        cp "$S/registry/$svc" "$S/tags/$svc"; exit 0 ;;
    run) exit 0 ;;
    tag)
        echo "$2" > "$S/tags/$(svc_of_ref "$3")"; exit 0 ;;
    create)
        echo "tmp-$2"; exit 0 ;;
    cp)
        id="${2#tmp-}"; id="${id%%:*}"; path="${2#*:}"
        d=$(mktemp -d)
        if [[ "$path" == /app/package.json ]]; then
            printf '{\n  "name": "picpeak-backend",\n  "version": "%s",\n' "$(cat "$S/images/$id/version")" > "$d/package.json"
            tar -cf - -C "$d" package.json
        else
            mkdir -p "$d/migrations/core"
            while read -r m; do [[ -n "$m" ]] && touch "$d/migrations/core/$m"; done < "$S/images/$id/migrations"
            tar -cf - -C "$d" migrations
        fi
        rm -rf "$d"; exit 0 ;;
    rm) exit 0 ;;
esac
echo "fake docker: unhandled $*" >&2
exit 99
