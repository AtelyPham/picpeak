# In-app updates

PicPeak can update itself when an admin asks for it, with no terminal or SSH session. The updater does what the manual path does, `docker compose pull && docker compose up -d`, but it adds checks before it changes anything and a rollback when the new version does not start.

It is **off by default** and only works with the prebuilt images from `docker-compose.production.yml`.


## What it does

An update always goes to the newest image of the channel the install already follows (`PICPEAK_CHANNEL`, so `stable` or `beta`). The updater has no version argument, never edits `.env` and never downgrades.

1. **Checks the install.** It finds the compose project from the running backend container and uses the same compose files the stack was started with (Compose records them in a container label), so an install started with `-f docker-compose.production.yml` is handled even without `COMPOSE_FILE` in `.env`. It refuses source builds, meaning a backend image with no registry digest or a `build:` section in the compose config.
2. **Pulls** the images of every running service. A failed pull is retried with backoff (5 attempts by default). If every attempt fails, the updater reports the registry's error and restores the old local tags, so nothing has changed.
3. **Checks the new backend image**, still before recreating anything:
   - its version must not be older than the running one (no downgrades);
   - if it carries the label `io.picpeak.update.auto-from`, the running version must be at least that version. Otherwise the release needs manual steps (see [For maintainers](#for-maintainers-releases-that-need-manual-steps)).
4. **Recreates** the services and waits up to 10 minutes for all of them to be running and healthy. That includes the backend's migrations on first boot.
5. **If the new version does not become healthy:**
   - When the new backend image ships no new migrations, the updater retags the old images, brings them back up and reports `rolled_back`.
   - When it does ship new migrations, they may already have run, and the old code against a migrated database is worse than a stopped update. The updater stops and reports `migrations_may_have_run`; see [Recovering](#recovering-after-migrations_may_have_run).

The **backup** is not the updater's job. The backend takes it with the existing backup service before it files the request, so the updater needs no database credentials.

## Updating from the admin UI

When in-app updates are enabled and the updater is reachable, the **Update PicPeak** dialog (from the update notice) and the **Update available** dialog (from the version link in the sidebar) start with an **Update from here** section:

1. A **super admin who signs in with a password** confirms with that password. SSO-only accounts have no usable local password, so they are told to use a password-based super admin instead. Other admins see that a super admin can do it, and only the phase and state of a running update, not who asked or why something failed.
2. The backend takes a **database dump** (the same one as Settings → Backup, written to the database backup destination). If the dump fails, nothing is requested and nothing changes.
3. The backend files the request and the updater takes over. The dialog follows its steps through the restart, during which the site is unavailable for a minute or two, and ends on the result with the updater's own explanation.

**A request does not wait forever.** While it waits for the updater, the dialog offers **Cancel request**. If nothing takes it within **10 minutes** (`PICPEAK_SELF_UPDATE_REQUEST_TTL_MINUTES`), the backend withdraws it. If the updater still finds a request older than **15 minutes** (`PICPEAK_UPDATER_REQUEST_MAX_AGE`, for example after being stopped for days), it discards it with `refused`/`request_expired` instead of updating unattended with a backup that old.

Failed attempts (a wrong password, or a request refused because an update is running or the feature is unavailable) are limited to five per admin per 15 minutes. The limit is kept in memory, so a backend restart resets it. Every request, refusal, cancellation, expiry and the updater's final result is recorded in the activity log.

The manual commands stay available under **Update manually instead**. Their checklist ("I have backed up my database", …) belongs to that path only: the one-click path takes the backup itself.

What the backend needs, all in `docker-compose.production.yml`:

- `PICPEAK_SELF_UPDATE=true` in `.env`. Anything else, including unset, keeps the feature off and the dialogs unchanged.
- `update/request` mounted read-write at `/app/update/request` and `update/status` mounted **read-only** at `/app/update/status`. The entrypoint hands `request/` to UID 1001 (shallowly) so the backend can write there; if it cannot, the dialog says so before any dump is taken.

> **Upgrade note.** These two bind mounts are part of every production install from this version on. On the next `docker compose up -d`, Docker creates a root-owned `./update/` with `request/` and `status/` in the install directory, even where `PICPEAK_SELF_UPDATE` stays unset. Nothing reads them while the feature is off.

## Enabling it

There are two packagings of the same script, `updater/picpeak-updater.sh`.

### Host agent (recommended)

For installs made with `scripts/picpeak-setup.sh` on a host where systemd is running (not WSL, and not inside a container). A systemd path unit starts one update run whenever a request appears. Nothing in a container holds the Docker socket.

New install: answer **yes** to "Enable in-app updates?" in the wizard, or pass the flag:

```bash
sudo ./scripts/picpeak-setup.sh --docker --unattended --enable-self-update
```

Existing install:

```bash
sudo ./scripts/picpeak-setup.sh --update --enable-self-update
```

This sets `PICPEAK_SELF_UPDATE=true` in `.env`, creates `update/request` (owned by UID 1001, the backend) and `update/status` (owned by root), copies the script to `/usr/local/lib/picpeak/` and enables `picpeak-updater.path`.

Logs: `sudo journalctl -u picpeak-updater`

**Keeping the agent current:** the agent never downloads code to run as root by itself. Every `picpeak-setup.sh --update` refreshes it from the checkout it has just pulled. The status file reports `updater_version` and `contract`, so the admin UI can say when the agent is older than the backend expects.

### Container (hosts without a shell)

For NAS and container-only hosts (Portainer stacks, ZimaOS/CasaOS and similar). Add this to `.env`:

```dotenv
PICPEAK_SELF_UPDATE=true
COMPOSE_PROFILES=updater
PICPEAK_PROJECT_DIR=/absolute/path/to/the/directory/with/docker-compose.production.yml
```

Then run `docker compose up -d`.

The `updater` service has no port and no network. It holds `/var/run/docker.sock`, **which is root on the host**. Only enable it where the host agent is not an option.

`PICPEAK_PROJECT_DIR` must be the real host path. The project directory is mounted read-only at that identical path inside the container, because compose resolves the stack's relative bind mounts (`./storage`, `./data`, …) against it. A different path would recreate PicPeak on empty storage. The updater checks the path against the compose labels of the running backend and refuses to run on a mismatch.

The updater image is versioned separately (`ghcr.io/picpeak/picpeak/updater:1` follows the latest 1.x). After each run it pulls its own tag. When the image has changed, it hands its restart to a short-lived container started from the new image, so it never stops itself mid-run.

To stay on one exact updater release instead of following the major, pin it in `.env`, for example `PICPEAK_UPDATER_TAG=1.0.0`. It then only changes when you change that value.

### Turning it off

- Host agent: `sudo ./scripts/picpeak-setup.sh --update --disable-self-update`. This removes the units and the script, and sets `PICPEAK_SELF_UPDATE=false`. Only disabling the unit with `systemctl` does not last: the next `--update` refreshes an installed agent and enables it again. `picpeak-setup.sh --uninstall` also removes the agent.
- Container: remove `updater` from `COMPOSE_PROFILES`, then `docker compose up -d --remove-orphans`.

## File contract (version 1)

The backend and the updater share no network path and no secret, only two directories under `update/` (`APP_UPDATE`, default `./update`):

| Path | Written by | Backend access |
|---|---|---|
| `update/request/update-requested` | backend | read-write |
| `update/status/status.json` | updater only | **read-only** |

**Request.** The backend creates `request/update-requested`, ideally by writing a temporary file and renaming it. Only the name's existence counts: the updater never reads the content. It removes the entry before doing anything else, so a failing run is never retriggered. `request/` belongs to the backend, so the updater only uses operations that act on the name itself and never follow a link or descend into a directory: `unlink` for a file, symlink or FIFO, and `rmdir` for an empty directory. A non-empty directory is renamed to `status/.rejected-request`, which only updaters can write. It is never deleted recursively. While one is already there, further directory markers are refused (and logged) until an operator removes it. A compromised backend can therefore trigger exactly one thing, a legitimate update to the published channel tag.

A request that arrives while another updater is *running an update* is removed without starting a second one, because that run already goes to the same channel tag. If the other updater is only starting up or polling, the request stays for the next pass.

`request/` is owned by UID 1001 (the backend user) with mode 0750. The setup script creates it; the updater creates it itself when it is missing, which is the case for container-variant installs.

**Lock.** Runs serialise on `status/.lock`. Because both packagings see the same directory, a host agent and a container enabled on the same install never run at once. The lock file is created with mode 0600: `flock` only needs a read-only descriptor, so a lock the backend could open is one it could hold forever.

**Status.** The updater replaces `status/status.json` atomically at every step:

```json
{
  "contract": 1,
  "updater_version": "1.0.0",
  "packaging": "host",
  "state": "succeeded",
  "reason": null,
  "step": "health",
  "message": "Updated PicPeak from 3.159.0 to 3.160.0.",
  "from_version": "3.159.0",
  "to_version": "3.160.0",
  "image": "ghcr.io/picpeak/picpeak/backend:stable",
  "started_at": "2026-10-03T10:00:00Z",
  "finished_at": "2026-10-03T10:03:12Z",
  "updated_at": "2026-10-03T10:03:12Z"
}
```

| `state` | Meaning |
|---|---|
| `idle` | Agent installed, no update has run yet |
| `running` | In progress; `step` is `discover`, `pull`, `verify`, `recreate`, `health` or `rollback` |
| `succeeded` | Updated from `from_version` to `to_version` |
| `up_to_date` | The channel has nothing newer; nothing was changed |
| `refused` | A check failed before anything changed; see `reason` |
| `failed` | See `reason` and `message` |
| `rolled_back` | The new version did not start; the previous one is running again |

| `reason` | State | Meaning |
|---|---|---|
| `source_build` | refused | Built from source; update manually |
| `downgrade` | refused | The channel tag points at an older version |
| `manual_required` | refused | The release needs manual steps; follow its release notes |
| `unknown_version` | refused | A version or label could not be read |
| `not_found` | failed | No backend container for this project dir, or the backend is not running |
| `pull_failed` | failed | The registry pull failed after every retry; nothing was changed |
| `migrations_may_have_run` | failed | The new version did not start and was left in place (see below) |
| `rollback_failed` | failed | The new version did not start and neither did the old one |
| `internal_error` | failed | A Docker command failed unexpectedly; `step` says where |
| `request_expired` | refused | The request was older than `PICPEAK_UPDATER_REQUEST_MAX_AGE` minutes when the updater saw it; nothing was changed |
| `interrupted` | failed | The run was stopped mid-way (reboot or shutdown, `systemctl stop`, a stopped or killed container) |

The contract number changes only for incompatible changes. The container image's major version follows it.

## Recovering after `migrations_may_have_run`

The new version did not start, and its migrations may have changed the database. Rolling back only the images is not safe, so the updater did not do it.

1. Check the backend log: `docker compose logs backend`. Often the cause is environmental (disk full, a mount that is missing) and a restart with `docker compose up -d` fixes it.
2. If the new version has to go, restore the backup the backend took before the update, from **Admin → Settings → Backup**. That is the same restore flow as for any other backup, and it needs a running backend.
3. If the admin UI is not reachable, open an issue with the backend log. Do not start the old version against the migrated database.

## For maintainers: releases that need manual steps

Some releases cannot be reached by `pull && up -d`: a compose file change, a new required environment variable, a Postgres major upgrade. Mark those in their release PR by putting the release's own version in `updater/AUTO_UPDATE_FROM`:

```text
3.160.0
```

CI bakes the value into every backend image as `io.picpeak.update.auto-from` until it is changed again. The updater refuses installs older than that version and points them at the release notes. Installs that skip over the release later are refused as well, because they are still older than the floor. Leave the file empty (comments only) while every release can be reached automatically.

## Limitations

- **Source builds** are detected and refused. That includes the README Quick Start, whose plain `docker compose up -d` uses `docker-compose.yml` and builds the images locally. Switch to the prebuilt images in `docker-compose.production.yml` (or install with `picpeak-setup.sh`) to use in-app updates.
- **Native (non-Docker) installs** and the **single-container (AIO)** image are not supported yet.
- **The compose file is not updated.** The updater only changes images. Releases that need a new compose file must set `AUTO_UPDATE_FROM`.
- **Old images are kept.** Run `docker image prune` now and then to reclaim disk space.
