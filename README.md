# @firefly0621/dsh-remote-control

English | [中文](README.zh.md)

Host plugin for the remote-control capability: opens an **outbound** WebSocket connection to a relay server and serves plugin-inventory and settings commands to a paired mobile app. The dsh host needs no public IP and no inbound ports — it dials out, exactly like the OpenClaw/Claw mobile-control pattern.

## Install as a profile plugin

```sh
dsh plugin --profile web add @firefly0621/dsh-remote-control
```

The browser pairing panel (`@firefly0621/dsh-client-ui-remote-control`) is a dependency of this package, so one install brings the host plugin and the 设置 → 远程控制 settings page together.

**Connection is explicit**: the plugin stays disconnected until you press **连接** in the pairing panel; the QR + 6-digit pairing code appear only after the connection succeeds (the relay mints the code over the live link). **断开连接** drops it and clears the code. Start a relay locally (`@firefly0621/dsh-remote-relay`, default `ws://127.0.0.1:8787`) or point at your own — the plugin defaults to `ws://127.0.0.1:8787`, auto-generates a `deviceId`/`deviceSecret` (persisted in the settings namespace `remote-control`, secret redacted on every wire surface), and the relay address is editable live in the panel. A phone scans the QR (or types the code) once and stays paired — the app resumes with its stored token afterwards.

Production just configures the relay:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- update:
    - id: remote-control
      config:
        relayUrl: wss://relay.example.com
```

## Configuration

| Key | Type | Meaning |
|---|---|---|
| `relayUrl` | string | Public relay WSS URL, e.g. `wss://relay.example.com`; absent defaults to `ws://127.0.0.1:8787` (a locally running relay). Also editable live from the pairing panel (设置 → 远程控制); the panel-persisted value wins over cordis.yml. |
| `deviceId` | string | Stable device id; auto-generated and persisted when absent. |
| `deviceSecret` | string | Long-lived secret; auto-generated and persisted when absent. |

## Behavior

- Connection is explicit: the relay-address field's **连接** button persists the address and starts the outbound client, **断开连接** stops it and clears the code. On connect the plugin authenticates with `hello { deviceSecret }`; the relay mints a 6-digit pairing code and sends it back via `pairing.issue`. The web GUI panel shows the code plus a QR encoding `relay=<url>&code=<6位码>` once paired (with a 刷新 re-read), and connection failures surface as an error status with the reason.
- Commands over the wire:
  - `plugin.list` → current non-group Loader entries (id, module, enabled, fiber phase).
  - `settings.describe` → every registered settings namespace via `ctx.settings.describe({ redactSecrets: true })` — secret fields never leave the host.
  - `settings.mutate` → path-level edits with optimistic concurrency (`ctx.settings.mutate(ns, ops, expectedRevision)`), persisted by the settings provider.
  - `sessions.list` → the host's sessions: live-agent ones with their title (the session-title service's LLM/fallback title when mounted, else the first user message) plus persisted cold sessions, most recent first.
  - `sessions.create` → a new session on the default workspace and preset; the plugin owns the handle so the phone can delete it.
  - `sessions.delete` → deletes a session the plugin created (web-created sessions are refused).
  - `chat.history` → the projected conversation of one session (live or cold): user/assistant text plus tool rows with a truncated result summary and failure marker.
  - `chat.stats` → whole-log figures of one live session (turns, steps, LLM/tool/ttft/decode wall times, output tokens) from the `sessionStats` projection; null when that unit is absent or the session is cold.
  - `chat.send` → submits one message to a chosen `sessionId` (or the most recent active session when absent), resuming a persisted cold session under its stored preset first; the assistant reply streams back to the app as `event` pushes (`chat/start` / `chat/chunk` / `chat/done` / `chat/error`).
  - `models.list` → the available provider/model catalog plus the host default selection.
  - `models.set` → sets the model selection of one live session (takes effect from the next message).
- Device-originated relay commands: `sessions.list` / `sessions.revoke` power the GUI's bound-device list and removal; `resetIdentity` regenerates the identity and reconnects, orphaning every bound session.
- Connection management: 30s heartbeats, exponential-backoff reconnect (1s → 60s cap with jitter), full teardown on fiber disposal.

## Relay

The relay is `@firefly0621/dsh-remote-relay` (standalone Node service, also published to npm). Its deployment env: `PORT`, `NODE_ENV=production` (requires TLS), `TLS_CERT`/`TLS_KEY`, `DSH_RELAY_DEVICE_SECRETS`, optional `DSH_RELAY_ALLOW_AUTO_REGISTER=1` (first hello for an unknown random deviceId binds it — the zero-config mode), and optional `DSH_RELAY_DATA_DIR` (durable session storage so a paired phone resumes after a relay restart). See the [dsh-remote-relay repo](https://github.com/oThTJx/dsh-remote-relay).

## Model Experience

None, as this plugin serves host state to an app; it registers no prompt, tool, or provider request.

#### KV Cache effect

None; the plugin never assembles or sends a model request.

## Known Limitations and Deferred Work

- **No enable/disable/install/uninstall** — the Loader is the sole lifecycle authority and exposes no mutation path; inventory is read-only and settings edits only touch the user-settings document.
- **Pairing code is relay-minted** — the device displays but does not generate codes; rotating codes requires a relay-side change (the device can force one by reconnecting).
- **Relay sessions persist only with `DSH_RELAY_DATA_DIR`** — without it a relay restart clears sessions and phones must re-pair.
