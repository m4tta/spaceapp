# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.
The API and worker tests also use the `sqlite3` and `rg` command-line tools.
Run tests as an unprivileged user so permission-denied fixtures behave as
intended. The browser lease tests expect Chrome at `/usr/bin/google-chrome`.

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network. The `smoke:offline` command below
does not need a provider account, API key, Docker, PostgreSQL or Temporal.

## Run the full app from source

Use Node >=22.12 <23, npm, and Docker Engine with Compose v2 or newer. After
the `npm ci` command above, start the source stack from the repository root:

```sh
npm run dev:stack
```

The command starts isolated PostgreSQL and Temporal containers, applies the
database migrations, and runs the API, Vite web server, worker, and CLI host
from this checkout. It installs the OpenCode version pinned in the Dockerfile
into its private state directory. It does not install a CLI globally or use
an installed SpaceApp's credentials or provider state.

Open the printed loopback URL and use the printed one-time setup token to
create your owner account and sign in. Open Getting Started and its OpenCode
pane. Reaching the native terminal UI does not require an AI provider account.
Using a model remains a separate provider setup step.

The foreground supervisor reports an unexpected service exit and stops the
other services. From another terminal in the same checkout:

```sh
npm run dev:stack -- down     # stop the source processes and containers
npm run dev:stack             # restart with the same local owner and data
npm run dev:stack -- rebuild  # rebuild and restart the source stack in this terminal
npm run dev:stack -- reset    # stop and remove only this dev stack's state/volumes
```

API source changes restart the API automatically. Web source changes use Vite
hot reload. After changing `packages/*` or worker source, run `rebuild` to stop
the stack, rebuild dependencies and the worker, and restart in the foreground
with the same owner and data. Browser-host/Chromium, companion services, and
root-only operations are disabled in this contributor stack.

The defaults bind only to `127.0.0.1`, independently of a normal install on
4910/4911:

| Service | Default port | Override |
| --- | --- | --- |
| API | 14910 | `SPACE_DEV_STACK_API_PORT` |
| Web | 14911 | `SPACE_DEV_STACK_WEB_PORT` |
| PostgreSQL | 15432 | `SPACE_DEV_STACK_POSTGRES_PORT` |
| Temporal | 17233 | `SPACE_DEV_STACK_TEMPORAL_PORT` |

For example, `SPACE_DEV_STACK_WEB_PORT=15911 npm run dev:stack` selects another
web port. Use the same overrides for subsequent lifecycle commands. Generated
secrets and application data live in the git-ignored `.dev-stack/` directory;
socket paths use a short private temporary directory recorded with that state.
Secrets are per-state-directory files with mode 0600. Do not commit or share
that directory. `SPACE_DEV_STACK_STATE_DIR` selects a different private state
directory when necessary.

On macOS, start Docker Desktop or Colima with Docker/Compose support before
running the command. On Windows 11, run every command inside a WSL2 Linux
distribution with Docker integration enabled. Keep the checkout and state on
the Linux filesystem rather than `/mnt/c` so Unix socket permissions, native
dependencies, file watching, and 0600 secret modes behave correctly. Native
Windows execution is not supported by this source-stack command.

If startup fails, check that Docker is reachable, the selected ports are free,
and the checkout uses the supported Node version. The first run needs network
access for the pinned container images and OpenCode package. A stopped or
failed stack can be restarted with the same state; use `reset` only when you
want to remove that contributor instance's data and create a new owner.

Run the end-to-end acceptance check with Docker available:

```sh
npm run smoke:dev-stack
```

It starts a separate temporary source stack without a TTY, completes normal
owner setup over the web proxy, attaches to the real OpenCode terminal, checks
web hot reload, API watch restart and worker failure reporting, and resets the
stack. On Linux it also identifies the real CLI process and checks that its
PTY descendants, containers, volumes, and temporary state were removed.
The `Contributor source stack` GitHub Actions job runs the same check on Linux.

## First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Make and verify a small change

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Checks before a commit

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.
