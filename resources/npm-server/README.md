# Orca Server

Requires Node.js 24 or newer.

Run Orca on a development server without installing the Electron desktop application:

```bash
npx @stablyai/orca@latest
```

The command starts a foreground browserless host and prints access links for Orca desktop and web
clients. It defaults to Tailscale when available and otherwise stays on loopback for an SSH tunnel.

```bash
npx @stablyai/orca@latest serve --help
```

Browser panes, computer-use, emulators, and speech are not available in the browserless package.
