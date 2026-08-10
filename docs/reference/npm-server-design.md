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

SIGINT, SIGTERM, and startup failure join one sequential teardown: stop RPC listeners; cancel local
or SSH prechecks, abort and drain headless automations, and wait for AgentHook shutdown through the
composition root; disconnect from the terminal daemon; flush the store; then release the profile
lock. A failed step is recorded while later steps still run. A normal server shutdown does not kill
daemon-owned terminals. Startup reconnects to the same daemon and device identity.

Every listener, socket, timer, and signal handler installed by the Node composition root has a
matching joined cleanup path before the process exits.

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

### Product onboarding

- [x] Add the npm command to the remote-host connection UI.
- [x] Explain Tailscale, SSH-tunnel, and explicit LAN choices.
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
- [ ] Pass the installed-package runtime oracle on Windows Server 2022 x64; macOS arm64 passed
      locally.
- [x] Prove both installed bins route zero-argument, `serve`, help/version, and non-server control
      commands exactly once without eagerly initializing the wrong runtime.
- [ ] Record installed CLI startup/readiness timing and subprocess counts on the final package.

### Accepted platform follow-ups

- [ ] Run the installed-package runtime oracle inside WSL.
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
- [ ] Attach package/Docker evidence and UI visual proof to the PR.
- [ ] Complete the PR description with validation commands and remaining platform gaps.

## Validation record and residual gaps

The installed-tarball history covers its inventory, executable, license, dependency, web-client,
real E2EE, workspace, Git, PTY, shutdown, and restart-continuity oracle on macOS; Ubuntu 20.04,
22.04, and 24.04 amd64; and Ubuntu 20.04 arm64. The final package was rerun on macOS arm64 and
Ubuntu 20.04 amd64. The Ubuntu 20.04 runs used stock Git 2.25.1 and verified the active native PTY
against glibc 2.31 without a compiler, Electron, Chromium, Xvfb, or FUSE installed.

The current focused selector passed 521 tests across 21 server, RPC, cross-version wire, onboarding,
browserless composition, automation, precheck, profile-lock, readiness, installed-process,
AgentHook, and shutdown files. The two workflow contract files passed 17 tests:

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  config/scripts/node-server-installed-process-harness.test.ts \
  config/scripts/node-server-verifier-host-path.test.ts \
  src/cli/runtime-client-deferral.test.ts \
  src/main/agent-hooks/server.test.ts \
  src/main/automations/headless-work-drain.test.ts \
  src/main/automations/precheck-runner.test.ts \
  src/main/automations/service-precheck.test.ts \
  src/main/automations/service.test.ts \
  src/main/runtime/pairing-endpoint.test.ts \
  src/main/runtime/runtime-rpc.test.ts \
  src/node-server/browserless-automation-dispatcher.test.ts \
  src/node-server/browserless-runtime-composition.test.ts \
  src/node-server/server-address-discovery.test.ts \
  src/node-server/server-cli-arguments.test.ts \
  src/node-server/server-paths.test.ts \
  src/node-server/server-profile-process-lock.test.ts \
  src/node-server/server-websocket-readiness.test.ts \
  src/node-server/server-window-graph.test.ts \
  src/renderer/src/components/settings/RuntimeHostAccessForm.test.tsx \
  src/renderer/src/components/sidebar/AddRemoteHostFields.test.tsx \
  tests/e2e/cross-version-wire/cross-version-terminal-wire.unit.test.ts
pnpm exec vitest run --config config/vitest.config.ts \
  config/scripts/pr-workflow-parallelism.test.mjs \
  config/scripts/node-server-package-workflow-contract.test.mjs
```

The final macOS arm64 installed-tarball oracle passed with 18,114,920 packed bytes and 55,066,712
unpacked bytes. Ubuntu 20.04 amd64 passed the same installed runtime oracle in Docker, including the
glibc 2.31 and `GLIBCXX_3.4.28` floors.

As an overlapping final packaging subset, the installed-process harness passed 2 tests and the
package-workflow contract passed 4 tests. These six tests are already included in the focused and
workflow counts above rather than added to them.

The required Windows Server 2022 x64 lane is pending on the current worktree, so Windows support is
not yet claimed. Once that lane passes the full clean-install, E2EE, workspace, native PTY, restart,
and cleanup journey, the explicit untested platform gaps remain WSL, Windows arm64, and nested SSH
connection-manager parity in the browserless host. The PTY dependency contains Windows x64 and
arm64 prebuilds, but a present binary is not runtime evidence for an untested target.

The package remains unpublished: the registry currently has neither `rc` nor `latest`. The PTY
package also retains a deprecated transitive `prebuild-install` fallback; clean installs select the
bundled prebuild before that downloader, but the dependency should be replaced when an equally
portable maintained package is available.
