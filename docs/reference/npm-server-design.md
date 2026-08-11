# npm server design

## Summary

Orca should run as a remote host on a machine with Node.js without installing the Electron
desktop application. The npm distribution reuses the desktop host runtime, pairing protocol,
terminal daemon, and web client while omitting Electron-only capabilities such as browser panes.

The promoted stable first-run contract is:

```bash
npx @stablyai/orca@latest
```

On a headless machine this starts a foreground server, chooses a safe reachable address, and
prints a web-client URL and pairing URL. A non-interactive `serve` command retains explicit
listener, advertised-address, port, and JSON controls.

The package is not published yet, so that command does not resolve during development. Release
candidate testing uses `npx @stablyai/orca@rc`; `@latest` becomes valid only after an exact
validated candidate is promoted.

## Problem

`orca serve` currently launches the packaged Electron executable. Linux hosts therefore need the
full AppImage, Electron libraries, FUSE or AppImage extraction, Chromium sandbox support, and
Xvfb. Pairing also requires operators to understand the difference between the bound listener and
the address embedded in an access link.

The remote runtime already owns the product behavior needed by a server: E2EE pairing, device
credentials, WebSocket transport, the web client, terminal persistence, workspaces, files, Git,
agents, and orchestration. The missing boundary is the process environment around that runtime.

## Goals

- Install and run the host through npm/npx without Electron, Chromium, Xvfb, or FUSE.
- Preserve the existing RPC, E2EE pairing, readiness, and persisted-state contracts.
- Keep one implementation of workspace, terminal, Git, file, agent, and orchestration behavior.
- Make zero-argument startup useful over SSH without exposing a public interface by accident.
- Keep desktop `orca serve` working during migration.
- Let the npm host and desktop app coexist safely as distinct hosts.
- Support folder workspaces and Git worktrees.
- Preserve macOS, Linux, Windows, SSH, WSL, Git 2.25, and glibc 2.31 compatibility.

## Non-goals

- Hosting browser, emulator, computer-use, speech, or renderer-only features in the initial npm
  package.
- Replacing the remote wire protocol.
- Making a client-local fallback browser part of the remote host or giving it remote ownership.
- Automatically configuring a VPN, firewall, reverse proxy, or public network listener.
- Shipping an Electron binary inside an npm wrapper.
- Letting two processes write one profile or automatically handing an npm host to the desktop app
  in the initial release.

## User experience

### Guided foreground start

After stable promotion:

```bash
npx @stablyai/orca@latest
```

Before promotion, release-candidate operators use the non-default dist-tag:

```bash
npx @stablyai/orca@rc
```

Startup chooses an advertised address in this order:

1. an explicit operator value;
2. a detected Tailscale IPv4 address;
3. loopback with a copyable SSH-tunnel command.

LAN exposure remains explicit. Public addresses require an explicit advertised address. Discovery
does not modify Tailscale or firewall configuration.

Human output distinguishes the two network roles:

```text
Orca server ready
Bound endpoint: ws://127.0.0.1:6768
Advertised endpoint: ws://127.0.0.1:6768
Web client URL: http://127.0.0.1:6768/web-index.html#pairing=...
Pairing URL: orca://pair?code=...
```

### Automation

```bash
orca-ide serve --port 6768 --pairing-address 100.64.1.20 --json
```

Existing serve flags and readiness schema version 1 remain valid. New fields must be optional.

### Package and executable names

The public package is `@stablyai/orca`. The durable executable is `orca-ide`, avoiding conflicts
with the Linux screen reader. The package also exposes `orca` so npm can select the expected bin
for `npx @stablyai/orca`. The package is currently unpublished; source documentation must not
describe `@latest` as available until registry promotion is complete.

## Architecture

```text
Electron entry ----+
                   +--> shared host runtime --> RPC / pairing / files / Git / PTY
Node server entry -+
       |                                   |
       +--> Node process environment       +--> optional capabilities
            paths, version, lifecycle           Electron browser backend
            networking, notifications           browserless Node backend
```

The Node distribution has three build outputs:

- the server CLI and composition root;
- the terminal daemon entry;
- the static web client.

Native packages remain npm dependencies so they target the host Node ABI. The npm package must not
depend on or contain Electron, Electron Updater, browser tooling, emulator tooling, or speech
models.

### Transitional process boundary

Some shared modules still import Electron-owned process primitives. The Node build resolves those
imports to a narrow process-environment facade. Every exposed member has either a Node
implementation or a fail-closed unsupported result. Browser and renderer behavior is never
emulated. The facade is a migration boundary; new host-runtime code must depend on concrete host
interfaces rather than adding facade surface.

CI inspects the built package, dependency manifest, and bundle metadata so an Electron runtime
dependency cannot enter transitively.

The package executable is the only process entry owner. Importing the reusable server composition
must never start a listener by itself; this keeps `--help`, version, and non-server control commands
from accidentally launching a second host.

### Browserless service composition

The Node composition root owns the non-Electron services that desktop runtime setup normally
wires. It installs Claude and Codex account services, rate-limit collection and settings sync, and
the account subscription backing exposed by runtime RPCs. A durable agent-session claim signer is
loaded from the server profile.

AgentHook supplies lifecycle and status snapshots, compatibility authority, PTY environment, and
live Claude rate-limit observations. Headless PTY registration resolves managed Claude and Codex
launch environments. The composition also installs orchestration transport and startup recovery,
scheduled and manual headless automation dispatch, artifact cloud sharing, AI Vault Codex discovery
and resume resolution, and commit-message agent environment resolution.

## Capability behavior

The Node host publishes the existing runtime capabilities except those requiring a browser
backend. In particular it omits:

- `browser.screencast.v1`;
- `browser.headless.v1`;
- `browser.certificate-trust.v1`.

Clients must treat the missing capability as unsupported on that host. A remote browser request
must not fall back to the viewing computer.

No protocol version bump is required. The server uses existing message shapes and optional
capabilities. Mixed-version testing covers an old client with the Node host and a new client with
the Electron host.

## Storage and security

The server stores state beneath an OS-standard Orca data directory. The directory is created with
owner-only permissions where the platform supports POSIX modes. Pairing identity and device files
reuse the current secure-file handling and survive package updates.

The npm host deliberately uses a different default profile from the desktop app: `Orca Server`
under the platform application-data directory on macOS and Windows, and `orca` under the XDG state
directory on Linux. An explicit `--data-dir` or `ORCA_SERVER_DATA_DIR` still selects one npm profile
for service deployments. A process-incarnation-fenced lock prevents two npm processes from writing
that profile concurrently; different npm profiles and the desktop default profile can remain live
at the same time.

Foreground startup prints a pairing credential unless `--no-pairing` is set. Automation and
service workflows that retain logs must either use that flag or treat readiness output as a secret.
Pairing material stays in URL fragments for the web client so reverse proxies and referrer headers
do not receive it.

The default listener is loopback unless the operator selects a private reachable interface. A
detected Tailscale address is private but is not proof of authorization; E2EE pairing remains
mandatory.

## Native dependency policy

The supported package must install on Linux x64 and arm64 without a compiler. `node-pty` and file
watcher binaries are checked in clean containers. Linux binaries must retain the Ubuntu 20.04 /
glibc 2.31 floor. macOS and Windows receive package smoke tests before release support is claimed.

The initial Node engine remains aligned with the repository. Supporting an older active LTS can be
considered only after the server build and native dependency matrix pass there.

## Shutdown and persistence

SIGINT and SIGTERM synchronously cancel startup before joining its current phase. Teardown then
stops RPC listeners; cancels local or SSH prechecks, aborts and drains headless automations, and
waits for AgentHook shutdown through the composition root; disconnects from the terminal daemon;
flushes the store; and releases the profile lock. Startup failures join the same coordinator. A
failed step is recorded while later steps still run. A normal server shutdown does not kill
daemon-owned terminals. Startup reconnects to the same daemon and device identity. A failed
shutdown that does not settle within 30 seconds exits unsuccessfully instead of leaving a wedged
server process.

Cancellation after worktree creation begins reconciles authoritative Git state even if Git
mutated before reporting an abort. Destructive rollback requires the exact branch, requested or
canonical path, and managed-worktree instance. Empty or unavailable SSH inventory is ambiguous and
fails closed. SSH setup mutations use client-scoped IDs and a relay settlement/release handshake,
so rollback cannot race a late setup write; old relays retain the original success path and fail
closed when a failed mutation cannot be confirmed settled.

Every listener, socket, timer, and signal handler installed by the Node composition root has a
matching joined cleanup path before the process exits.

## Safe npm server updates

The npm executable is a supervisor, not the long-lived host itself:

```text
npx / orca-ide supervisor
  ├─ restartable versioned host worker
  └─ separately owned terminal daemon and PTYs
```

The supervisor starts the host worker over an IPC channel and waits for readiness containing the
exact package version and runtime ID. Stopping or replacing a worker uses the normal joined host
shutdown, which disconnects from the terminal daemon without killing daemon-owned terminals.
Restarting the terminal daemon is never part of an npm package update.

The existing remote-server update RPC and client UI remain the only remote update contract. A new
client may add an optional exact target version to the existing check request; older hosts ignore
it and newer hosts must continue to support requests where it is absent. No terminal-stream opcode
or required response field is added.

An automatic npm update follows this transaction:

1. Resolve an exact published `@stablyai/orca` version. Never activate a dist-tag or range.
2. Install it into a temporary directory beneath the server profile's runtime directory.
3. Run the candidate's side-effect-free preflight with the same Node executable. Preflight verifies
   package identity, exact version, required files, external dependencies, and native module load.
4. Write an install-complete sentinel and atomically rename the candidate into its immutable
   version directory.
5. Return the accepted install result with an unguessable receipt bound to the authenticated paired
   device. The same device may retry a lost install response and recover the same receipt; another
   device cannot retrieve or acknowledge it. The client echoes the receipt on a later authenticated
   status request, and requests without it cannot trigger activation.
6. Persist a pending handoff before stopping the current worker.
7. Start the candidate privately and require an exact-version prepared message while its RPC
   listener remains closed.
8. Atomically select that immutable version, then grant the prepared candidate permission to open
   RPC and require its applied acknowledgement.
9. Require public readiness for the exact candidate version and runtime ID.
10. Require an applied success acknowledgement for the same receipt before the paired client can
    display the update as complete.
11. On any failure, restore the previous durable selection, restart the previous worker, and expose
    a redacted originating failure so the client does not wait for a generic timeout.

Only one check, download, or activation may run per profile. A repeated request for an already
complete immutable version reuses it after preflight. Incomplete staging directories are removed;
an existing complete version is never overwritten. Paths received over IPC are not trusted: the
supervisor derives candidate paths from the profile and exact version and verifies their sentinel.

The foreground local recovery path stays intentionally unsurprising:

```bash
# Stop only the npm supervisor and host; daemon-backed terminals remain alive.
Ctrl+C
npx @stablyai/orca@latest
```

Remote update from a connected client is the primary no-shell path. The server checks, stages,
preflights, restarts, and reconnects while the client displays the existing checking, downloading,
restarting, success, or actionable failure states. A foreground supervisor crash cannot promise
availability, but relaunching the command adopts the last successfully selected immutable runtime
and reconnects to the durable terminal daemon.

Worker shutdown uses a joined supervisor-to-worker IPC request on macOS, Linux, and Windows, with a
bounded OS-level kill only as a failure fallback. The install-response acknowledgement replaces a
timing delay: replacement cannot begin until a client has received the result and echoes its unique
receipt on a later authenticated status request. Other clients cannot trigger the handoff by
checking status, and each remote RPC may use a fresh WebSocket connection.

Remote updates replace the versioned host worker but intentionally do not replace the already
running supervisor executable. Worker-compatible releases update remotely. A release that changes
the supervisor protocol requires the documented local `Ctrl+C` plus `npx` relaunch; candidate
preflight rejects an incompatible protocol before the active worker is stopped.

The first release does not install a system service or mutate a global npm installation. A future
service command may supervise the same versioned-worker protocol; it must not introduce a second
update backend or move PTY ownership into the host worker.

Update acceptance requires two independent continuity signals: the terminal daemon PID and PTY
identity remain unchanged, and a marker written after the replacement becomes ready is observed on
the paired client. Reconnect alone is insufficient. Tests also cover failed preflight, candidate
exit before readiness, rollback, duplicate requests, signal races, stale IPC, and a newer client
against an older manually updated server.

## Desktop coexistence and handoff

The initial npm host and desktop app use separate default data directories. They can run on the
same machine without sharing writable state, but they appear as separate Orca hosts and opening
the desktop app does not take ownership of the npm host.

The intended follow-up is a coordinated handoff, not an attempt to turn the running Node process
into Electron. Standalone-backend architectures keep the host process independent and let desktop
clients attach to or supervise it. Orca can move toward that model while keeping browser panes
desktop-local.

The current npm profile lock is only a same-profile single-writer guard. It does not let desktop
discover the npm host, transfer ownership, reuse its identity, or reconnect clients, and therefore
must not be presented as desktop takeover support.

A safe handoff requires:

1. one cross-process profile lease with an owner identity and generation;
2. an authenticated local request from the desktop app to the npm host;
3. a host checkpoint followed by listener shutdown and explicit lease release;
4. desktop acquisition of the next generation before it opens the profile;
5. reuse of the device registry, E2EE keypair, runtime metadata, and durable terminal daemon;
6. client reconnect without re-pairing and terminal input/output after daemon adoption;
7. bounded rollback to the npm host if desktop startup fails before readiness.

No implementation may copy a live profile, infer ownership from a PID file alone, or let both
processes publish runtime metadata. A desktop-only browser backend must remain a capability of the
desktop owner rather than silently executing remote browser work on a viewing client.

## Packaging gates

The publishable tarball must:

- contain the server, daemon, web client, license, README, and package manifest;
- exclude Electron, desktop assets, source maps with local paths, test fixtures, and secrets;
- have no runtime dependency on `electron` or `electron-updater`;
- expose executable `orca` and `orca-ide` bins;
- report the exact package version in runtime status;
- pass `npm pack --dry-run` inventory and size assertions.

## Validation topology

The deterministic integration oracle is:

1. start the built Node server with isolated state and port `0`;
2. parse readiness schema version 1;
3. prove the web client is served;
4. decode the pairing offer and authenticate over the real WebSocket transport;
5. call `status.get` and assert browser capabilities are absent;
6. add and open a folder workspace;
7. spawn a terminal, send a unique marker, and observe it through the paired stream;
8. restart the server and prove device identity and terminal continuity;
9. stop the server and prove no listener or child-process leak.

Docker runs the same package on Ubuntu 20.04, 22.04, and 24.04 where images and Node availability
permit. The test records host runtime identity, daemon PID, connection identity, PTY identity, and
the terminal marker.

## Rollout

Registry bootstrap is the only external prerequisite. The `@stablyai` npm organization must own
`@stablyai/orca`, and that package must trust `.github/workflows/release-cut.yml` as an npm Trusted
Publisher. Trusted publishing uses GitHub OIDC and requires no long-lived `NPM_TOKEN` secret. If npm
does not allow configuring a trusted publisher before the package exists, publish the first exact
`rc` tarball once with an organization-scoped granular token and required 2FA, configure the trusted
publisher immediately, then remove the bootstrap token. Release CI verifies the existing registry
SHA-1 against its locally packed tarball and verifies or repairs the expected dist-tag before
treating a retry as complete. Only a plain `X.Y.Z-rc.N` advances `rc`; suffixed prereleases use the
non-user-facing `build` tag.

1. Publish an immutable candidate with an explicit non-default tag, for example
   `npm publish --tag rc`; never let the first publication implicitly claim `latest`.
2. Verify the registry dist-tags, install `@rc` on the supported package matrix, and retain the
   exact version that passed.
3. Keep desktop `orca serve` as the documented stable path while collecting candidate install
   failures.
4. Promote that exact version with `npm dist-tag add @stablyai/orca@<version> latest` only after
   required gates pass. Ship UI and stable docs that recommend `@latest` no earlier than this step.
5. Move `rc` to later candidates independently; rollback `latest` to a previously validated exact
   version rather than republishing mutable bytes.
6. Add service installation, readiness-based immutable updates, and desktop-managed SSH bootstrap.
7. Consider an opt-in browser sidecar only after the browserless server is stable.

## Implementation checklist

### Design and boundaries

- [x] Record goals, non-goals, security defaults, wire policy, and validation topology.
- [x] Add the Node server composition root.
- [x] Add the Node process-environment facade.
- [x] Keep the desktop composition root behavior unchanged.
- [x] Prohibit Electron runtime dependencies in the server build.
- [x] Keep executable dispatch in the package entry so importing server composition has no startup
      side effect.

### Runtime

- [x] Initialize persistent state in an isolated server data directory.
- [x] Initialize or adopt the durable terminal daemon.
- [x] Register the headless PTY controller.
- [x] Wire Claude and Codex accounts, rate limits, subscriptions, and runtime-target settings sync.
- [x] Load the durable agent-session claim signer from the server profile.
- [x] Wire AgentHook lifecycle, snapshots, compatibility authority, PTY environment, and rate-limit
      observations.
- [x] Resolve account-aware Claude and Codex PTY launches.
- [x] Wire orchestration transport plus prepare, refresh, and reconcile recovery.
- [x] Dispatch scheduled and manual automations without a renderer.
- [x] Wire artifact sharing, AI Vault Codex resume, and commit-message agent environments.
- [x] Start local and WebSocket RPC transports.
- [x] Serve the static web client.
- [x] Publish readiness schema version 1.
- [x] Generate runtime-scoped E2EE pairing offers.
- [x] Omit browser capabilities and fail remote browser requests explicitly.
- [x] Join RPC stop, composition drain, daemon disconnect, store flush, and lock release in order on
      signals and startup errors.
- [x] Cancel startup before signal teardown and prove pre-readiness SIGTERM prints no credential,
      exits cleanly, and leaves the profile reusable.
- [x] Run the npm host as a supervised worker while leaving the terminal daemon independent.
- [x] Stage exact immutable npm versions, preflight them, and select them atomically.
- [x] Roll back to the previous worker when candidate readiness fails.
- [x] Persist handoff failure state so a reconnected client receives the exact failure.
- [x] Wire the npm backend into the existing remote-server updater RPC and UI.

### CLI and networking

- [x] Support zero-argument guided startup.
- [x] Retain `serve`, `--port`, `--pairing-address`, `--no-pairing`, and `--json`.
- [x] Detect Tailscale without changing its configuration.
- [x] Default to loopback and print an SSH-tunnel path when no private address is selected.
- [x] Validate ports and advertised addresses before starting.
- [x] Support credential-free automation with `--no-pairing`.

### npm package

- [x] Add `@stablyai/orca` package metadata and both executable names.
- [x] Build the server and daemon as plain Node outputs.
- [x] Include the built web client.
- [x] Install native dependencies for the Node ABI.
- [x] Add tarball inventory, size, executable, license, and dependency gates.
- [x] Verify the tarball contains no Electron runtime.
- [ ] Publish the first immutable candidate under the non-default `rc` dist-tag.
- [ ] Promote the exact matrix-validated candidate to `latest` before stable onboarding ships.

### Candidate onboarding

- [x] Add the release-candidate npm command to the remote-host connection UI.
- [x] Explain Tailscale, SSH-tunnel, and explicit LAN choices.
- [ ] Switch stable docs and product onboarding from `@rc` to `@latest` after exact-version
      promotion.
- [x] Link the shorter npm-server documentation from the existing Linux guide.
- [x] Capture visual proof for the UI change.

### Desktop coexistence

- [x] Use separate npm and desktop profiles so both installations can run safely today.
- [x] Fence one npm profile to one live writer without blocking different profiles.
- [x] Document the ownership, identity, daemon, and rollback contract for a future handoff.

### Future desktop handoff follow-up (not part of the initial release)

- [ ] Add a cross-process profile lease with generation fencing.
- [ ] Let desktop discover and authenticate to the local npm host.
- [ ] Checkpoint and transfer ownership without two live profile writers.
- [ ] Preserve pairing identity and daemon-backed terminal continuity across the handoff.
- [ ] Add failure-before-yield, failure-after-yield, mixed-version, and rollback oracles.
- [ ] Add packaged macOS, Linux, and Windows desktop-handoff journeys.

### Tests

- [x] Unit-test CLI parsing, address discovery, paths, readiness, and shutdown.
- [x] Test the built package with the real WebSocket/E2EE transport.
- [x] Test folder workspaces and Git worktrees.
- [x] Test terminal marker delivery and daemon continuity across restart.
- [x] Run the existing cross-version wire regression and verify no wire shape or opcode changed.
- [x] Test missing browser capabilities, explicit rejection, and no local fallback in remote RPCs.
- [x] Run clean Docker tests on Ubuntu 20.04, 22.04, and 24.04 amd64 and 20.04 arm64.
- [x] Verify the glibc 2.31 floor and Node native ABI.
- [x] Pass the installed-package runtime oracle on Windows Server 2022 x64; macOS arm64 passed
      locally.
- [x] Prove both installed bins route zero-argument, `serve`, help/version, and non-server control
      commands exactly once without eagerly initializing the wrong runtime.
- [x] Record installed CLI startup/readiness timing and subprocess counts on the final package.
- [x] Prove exact-version replacement with unchanged daemon PID and PTY identity.
- [x] Prove terminal output and input after replacement with pre/post-handoff markers.
- [x] Prove failed preflight never stops the current worker.
- [x] Prove candidate failure rolls back and reports an actionable error without a reconnect timeout.
- [x] Prove duplicate, stale, and concurrent activation requests cannot replace the selected worker.
- [ ] Run the update oracle against locally packed old/new tarballs and in the Linux Docker matrix.

### Accepted platform follow-ups

- [x] Run the installed-package runtime oracle inside WSL.
- [ ] Run the installed-package runtime oracle on Windows arm64 hardware.
- [ ] Add and validate nested SSH connection-manager lifecycle parity for the browserless host.

### Release readiness

- [x] Run typecheck, lint, focused tests, and the full relevant test suite.
- [x] Audit network failure, retry, cleanup, and bounded resource behavior.
- [x] Audit security, package contents, scripts, and dependency changes.
- [x] Audit persisted-state and mobile/old-client compatibility.
- [x] Audit macOS, Linux, Windows, WSL, SSH, and path behavior; retain runtime gaps below.
- [x] Re-run the final-head focused selector and workflow contract suite and record their actual
      counts below.
- [x] Attach package/Docker evidence and UI visual proof to the PR.
- [x] Complete the PR description with validation commands and remaining platform gaps.

## Validation record and residual gaps

The installed-tarball history covers its inventory, executable, license, dependency, web-client,
real E2EE, workspace, Git, PTY, shutdown, and restart-continuity oracle on macOS; Ubuntu 20.04,
22.04, and 24.04 amd64; and Ubuntu 20.04 arm64. Earlier package candidates were rerun on all three
amd64 Ubuntu versions. The Ubuntu 20.04 runs used stock Git 2.25.1 and verified the active native
PTY against glibc 2.31 without a compiler, Electron, Chromium, Xvfb, or FUSE installed.

The current combined selector passed 650 tests across 48 safe-update, server, RPC, cross-version
wire, onboarding, browserless composition, automation, precheck, profile-lock, readiness,
installed-process, AgentHook, and shutdown files. Four workflow and release-contract files passed
66 tests with one platform-specific skip:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  config/scripts/node-server-installed-process-harness.test.ts \
  config/scripts/node-server-verifier-daemon-cleanup.test.ts \
  config/scripts/node-server-verifier-git-fixture.test.ts \
  config/scripts/node-server-verifier-host-path.test.ts \
  src/cli/runtime-client-deferral.test.ts \
  src/main/agent-hooks/server.test.ts \
  src/main/automations/headless-completion-settlement.test.ts \
  src/main/automations/headless-work-drain.test.ts \
  src/main/automations/precheck-runner.test.ts \
  src/main/automations/service-precheck.test.ts \
  src/main/automations/service.test.ts \
  src/main/runtime/pairing-endpoint.test.ts \
  src/main/runtime/runtime-rpc.test.ts \
  src/main/server/serve-readiness.test.ts \
  src/node-server/browserless-automation-dispatcher.test.ts \
  src/node-server/browserless-runtime-composition.test.ts \
  src/node-server/package-cli-deferral.test.ts \
  src/node-server/server-address-discovery.test.ts \
  src/node-server/server-bind-host.test.ts \
  src/node-server/server-cli-arguments.test.ts \
  src/node-server/server-paths.test.ts \
  src/node-server/server-profile-environment.test.ts \
  src/node-server/server-profile-process-lock.test.ts \
  src/node-server/server-shutdown-coordinator.test.ts \
  src/node-server/server-signal-shutdown.test.ts \
  src/node-server/server-websocket-readiness.test.ts \
  src/node-server/server-window-graph.test.ts \
  src/renderer/src/components/settings/NodeServerSetupCallout.test.tsx \
  src/renderer/src/components/settings/RuntimeHostAccessForm.test.tsx \
  src/renderer/src/components/sidebar/AddRemoteHostFields.test.tsx \
  tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts \
  src/node-server/npm-supervisor-worker-transition.test.ts \
  src/node-server/npm-supervised-worker.test.ts \
  src/node-server/npm-pinned-runtime.test.ts \
  src/node-server/npm-server-updater.test.ts \
  src/node-server/npm-serve-supervisor.test.ts \
  src/node-server/npm-supervisor-protocol.test.ts \
  src/node-server/npm-supervisor-state.test.ts \
  src/node-server/npm-process-runner.test.ts \
  src/node-server/npm-update-error-classification.test.ts \
  src/node-server/npm-runtime-version.test.ts \
  src/renderer/src/runtime/remote-server-install-failure-probe.test.ts \
  src/renderer/src/runtime/remote-server-update-errors.test.ts \
  src/renderer/src/runtime/remote-server-restart-wait.test.ts \
  src/renderer/src/runtime/remote-server-update-coordinator.test.ts \
  src/main/runtime/remote-server-updater.test.ts \
  src/main/runtime/rpc/methods/updater.test.ts \
  config/scripts/node-server-package-workflow-contract.test.mjs
pnpm exec vitest run --config config/vitest.config.ts \
  config/scripts/pr-workflow-parallelism.test.mjs \
  config/scripts/node-server-package-workflow-contract.test.mjs \
  config/scripts/generate-skill-bundle-manifest.test.mjs \
  config/scripts/package-electron-runtime-contract.test.mjs
```

The current macOS arm64 installed-tarball oracle passed with 18,220,887 packed bytes and 55,957,304
unpacked bytes. Its POSIX startup oracle also sent SIGTERM before readiness, observed no credential
output, and restarted the same profile successfully. The final Ubuntu 20.04 amd64 package passed
the same safe-update journey in Docker and verified the glibc 2.31 and `GLIBCXX_3.4.28` floors.
Earlier package candidates also passed Ubuntu 22.04 and 24.04 amd64 plus Ubuntu 20.04 arm64.

The physical Windows x64 safe-update oracle passed in 51.227 seconds with 18,250,120 packed bytes
and 55,957,163 unpacked bytes. It covered successful exact activation, rejected preflight without
stopping the healthy worker, failed-candidate rollback, unchanged daemon PID/file/launch nonce,
PTY reattachment and post-update terminal I/O, selected-version relaunch, and zero residual test
processes.

The final cancellation lifecycle gate passed 1,463 tests across eleven deterministic files with one
unrelated platform-specific skip in 10.29 seconds. It covers commit-point reconciliation,
repo-scoped fork-remote lifecycle serialization and compensation, strict empty-inventory handling,
instance-fenced removal, relay filesystem mutation settlement, legacy relay fallback, and the
failed-shutdown watchdog. A Docker rerun after these lifecycle edits was blocked by an unrelated
wedged local Docker Desktop daemon; the required Ubuntu and Windows package lanes passed on the
exact source candidate in CI.

Ten fresh-profile installed-package trials on macOS arm64 reached the first schema-v1 readiness
line in 352.705–748.323 ms, with a 369.474 ms median. Recursive process snapshots at one and three
seconds were stable in every trial: one server, one daemon, no daemon PTY children, and no other
subprocesses. Every measured server and daemon exited cleanly after its trial.

The exact code candidate `4bb4ff8753d2160041bd7ab1acbe26bc14e37958` also passed on the paired
Windows host: Node typecheck, the node-server build, clean pack/install, and the full runtime
oracle. The native Windows package measured 18,243,548 packed bytes and 55,905,519 unpacked bytes.
The same candidate passed the clean installed-package and runtime oracle inside Ubuntu 24.04 WSL;
that package measured 18,242,422 packed bytes and 55,905,664 unpacked bytes. Process inspection
found no test-owned server or daemon after either oracle.

As an overlapping final packaging subset, the installed-process harness passed 2 tests and the
package-workflow contract passed 4 tests. These six tests are already included in the focused and
workflow counts above rather than added to them.

The required Windows Server 2022 x64 lane passed the full clean-install, E2EE, workspace, native
PTY, restart, and cleanup journey on the exact code candidate. The explicit untested platform gaps
remain Windows arm64 and nested SSH connection-manager parity in the browserless host. The PTY
dependency contains Windows arm64 prebuilds, but a present binary is not runtime evidence for that
untested target.

The package remains unpublished: the registry currently has neither `rc` nor `latest`. The PTY
package also retains a deprecated transitive `prebuild-install` fallback; clean installs select the
bundled prebuild before that downloader, but the dependency should be replaced when an equally
portable maintained package is available.
