# Orca Server

Requires Node.js 24.x.

Run Orca on a development server without installing the Electron desktop application:

```bash
npx @stablyai/orca@rc
```

The command starts a foreground browserless host and prints access links for Orca desktop and web
clients. It defaults to Tailscale when available and otherwise stays on loopback for an SSH tunnel.

A connected Orca desktop client can update the server remotely. Orca stages and preflights the
exact package version, restarts the host worker, and reconnects while daemon-owned terminals keep
running. To update locally, press `Ctrl+C` and run the `npx` command again.

```bash
npx @stablyai/orca@rc serve --help
```

Browser panes, computer-use, emulators, and speech are not available in the browserless package.
