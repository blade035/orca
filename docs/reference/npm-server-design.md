# npm server design

## Summary

Orca should run as a remote host on a machine with Node.js without installing the Electron
desktop application. The npm distribution reuses the desktop host runtime, pairing protocol,
terminal daemon, and web client while omitting Electron-only capabilities such as browser panes.

The first-run contract is:

```bash
npx @stablyai/orca@latest
```

On a headless machine this starts a foreground server, chooses a safe reachable address, and
prints a web-client URL and pairing URL. A non-interactive `serve` command retains explicit
listener, advertised-address, port, and JSON controls.

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
- Support folder workspaces and Git worktrees.
- Preserve macOS, Linux, Windows, SSH, WSL, Git 2.25, and glibc 2.31 compatibility.

## Non-goals

- Hosting browser, emulator, computer-use, speech, or renderer-only features in the initial npm
  package.
- Replacing the remote wire protocol.
- Making a client-local fallback browser part of the remote host or giving it remote ownership.
- Automatically configuring a VPN, firewall, reverse proxy, or public network listener.
- Shipping an Electron binary inside an npm wrapper.

## User experience

### Guided foreground start

```bash
npx @stablyai/orca@latest
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
for `npx @stablyai/orca`.

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

SIGINT and SIGTERM stop listeners, flush the store, and detach from the terminal daemon. A normal
server shutdown does not kill daemon-owned terminals. Startup reconnects to the same daemon and
device identity.

Every listener, socket, timer, and signal handler installed by the Node composition root has a
matching cleanup path. Startup failure runs the same cleanup before exiting nonzero.

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

1. Publish the package under a release-candidate tag.
2. Keep desktop `orca serve` as the documented stable path while collecting package telemetry and
   install failures.
3. Promote npm/npx to the primary headless documentation after the Linux matrix is green.
4. Add service installation and readiness-based immutable updates.
5. Add desktop-managed SSH bootstrap using the same package.
6. Consider an opt-in browser sidecar only after the browserless server is stable.

## Implementation checklist

### Design and boundaries

- [x] Record goals, non-goals, security defaults, wire policy, and validation topology.
- [x] Add the Node server composition root.
- [x] Add the Node process-environment facade.
- [x] Keep the desktop composition root behavior unchanged.
- [x] Prohibit Electron runtime dependencies in the server build.

### Runtime

- [x] Initialize persistent state in an isolated server data directory.
- [x] Initialize or adopt the durable terminal daemon.
- [x] Register the headless PTY controller.
- [x] Start local and WebSocket RPC transports.
- [x] Serve the static web client.
- [x] Publish readiness schema version 1.
- [x] Generate runtime-scoped E2EE pairing offers.
- [x] Omit browser capabilities and fail remote browser requests explicitly.
- [x] Flush state and detach cleanly on signals and startup errors.

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

### Product onboarding

- [x] Add the npm command to the remote-host connection UI.
- [x] Explain Tailscale, SSH-tunnel, and explicit LAN choices.
- [x] Link the shorter npm-server documentation from the existing Linux guide.
- [x] Capture visual proof for the UI change.

### Tests

- [x] Unit-test CLI parsing, address discovery, paths, readiness, and shutdown.
- [x] Test the built package with the real WebSocket/E2EE transport.
- [x] Test folder workspaces and Git worktrees.
- [x] Test terminal marker delivery and daemon continuity across restart.
- [x] Run the existing cross-version wire regression and verify no wire shape or opcode changed.
- [x] Test missing browser capabilities, explicit rejection, and no local fallback in remote RPCs.
- [x] Run clean Docker tests on Ubuntu 20.04, 22.04, and 24.04 amd64 and 20.04 arm64.
- [x] Verify the glibc 2.31 floor and Node native ABI.
- [ ] Run a Windows package smoke test; macOS package verification passed locally.

### Release readiness

- [x] Run typecheck, lint, focused tests, and the full relevant test suite.
- [x] Audit network failure, retry, cleanup, and bounded resource behavior.
- [x] Audit security, package contents, scripts, and dependency changes.
- [x] Audit persisted-state and mobile/old-client compatibility.
- [x] Audit macOS, Linux, Windows, WSL, SSH, and path behavior; retain runtime gaps below.
- [ ] Attach package/Docker evidence and UI visual proof to the PR.
- [ ] Complete the PR description with validation commands and remaining platform gaps.

## Validation record and residual gaps

The publishable tarball passed its inventory, executable, license, dependency, web-client, real
E2EE, workspace, Git, PTY, shutdown, and restart-continuity oracle on macOS. Docker passed the same
installed tarball and runtime oracle on Ubuntu 20.04, 22.04, and 24.04 amd64 plus Ubuntu 20.04
arm64. The Ubuntu 20.04 runs used stock Git 2.25.1 and verified the active native PTY against glibc
2.31 without a compiler, Electron, Chromium, Xvfb, or FUSE installed.

Windows and WSL package smoke tests remain release-CI gaps. The code uses Node path/process APIs and
the PTY dependency contains Windows x64 and arm64 prebuilds, but support should not be promoted
without a real Windows install and PTY run. The PTY package also retains a deprecated transitive
`prebuild-install` fallback; clean installs select the bundled prebuild before that downloader, but
the dependency should be replaced when an equally portable maintained package is available.
