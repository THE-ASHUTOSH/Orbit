# Protocol

One source of truth: `packages/protocol/src/index.ts`. Client messages are zod
schemas, and the TypeScript types are inferred from them, so the validator and
the type cannot drift. Both `apps/server` and `apps/web` import the same package.

Transport: one WebSocket at `/ws`, authenticated by the session cookie at upgrade
time. Text frames carry JSON control messages; binary frames carry video.

## Rules

1. **Identity is never on the wire.** The server takes `userId` from the
   authenticated session. A `userId` field in a client message would be ignored -
   there isn't one.
2. **Everything inbound is validated.** `ClientMessage.safeParse` gates every
   message; a failure is answered with `error: invalid_message` and logged at
   debug, never thrown.
3. **Errors are codes, not stack traces.** `ErrorCode` is a closed set with
   human-readable text in `ERROR_MESSAGES`. Internal detail stays in the logs.
4. **Frames are binary.** Base64 in JSON would cost 33% bandwidth plus a decode
   on the hot path.

## Client → server

| Type | Purpose | Requires |
|---|---|---|
| `input.mouse` | `mousemove` / `mousedown` / `mouseup` / `wheel` | control |
| `input.keyboard` | `keydown` / `keyup` with `key`, `code`, `location`, modifiers | control |
| `input.text` | committed IME composition or paste | control |
| `input.touch` | `touchstart` / `touchmove` / `touchend` / `touchcancel` | control |
| `cursor` | cursor telemetry for the overlay (never reaches Chromium) | view |
| `tab.subscribe` | start receiving frames for a tab | view |
| `tab.unsubscribe` | stop receiving frames | - |
| `tab.create` | new tab, optional `url` and `label` | role `tab.create` |
| `tab.close` | close a tab | the owner or an admin (role `tab.close` alone when `TAB_OWNERSHIP=false`) |
| `tab.navigate` | navigate a tab | control |
| `tab.action` | `reload` / `back` / `forward` / `stop` / `duplicate` | control |
| `tab.rename` | set the tab label | the owner or an admin (control when `TAB_OWNERSHIP=false`) |
| `tab.resize` | change the streamed viewport | control |
| `tab.zoom` | zoom 0.25-4, applied by resizing the remote viewport | control |
| `tab.reopen` | reopen the most recently closed tab | role `tab.create` |
| `context.probe` | ask what is under a page coordinate, for the right-click menu | view |
| `tab.access.request` | ask the tab's owner for control of it | view |
| `tab.access.respond` | the owner's answer: grant or refuse | tab admin (i.e. the owner) |
| `clipboard.write` | insert text into the page | control + `CLIPBOARD_ENABLED` |
| `file.chooser.respond` | answer a page's file dialog with uploaded names | control + `UPLOADS_ENABLED` |
| `ping` | round-trip measurement | - |

### Input envelope

Every input message carries:

```jsonc
{
  "eventId": "evt_41_x8s2p1",   // unique; the server drops repeats
  "clientSequence": 1042,        // monotonic per connection; older is a replay
  "clientSentAt": 1787251590394, // client clock, for latency reporting only
  "tabId": "tab_01M0G7NPGH15PMAPATDF6E"
}
```

`clientSentAt` is never used for ordering. Ordering is server arrival order, so a
client cannot jump the queue by lying about its clock.

Example:

```jsonc
{
  "type": "input.mouse", "event": "mousemove",
  "eventId": "evt_7_ab12cd", "clientSequence": 7, "clientSentAt": 1787251590394,
  "tabId": "tab_01M0G7NPGH15PMAPATDF6E",
  "x": 531, "y": 302, "buttons": 0, "modifiers": 0, "button": "none"
}
```

```jsonc
{
  "type": "input.keyboard", "event": "keydown",
  "eventId": "evt_8_ef34gh", "clientSequence": 8,
  "tabId": "tab_01M0G7NPGH15PMAPATDF6E",
  "key": "Enter", "code": "Enter", "location": 0, "repeat": false, "modifiers": 0
}
```

`modifiers` is Chromium's bitmask: `Alt=1, Ctrl=2, Meta=4, Shift=8` (`MOD` and
`modifiersFrom()` are exported for it).

## Server → client

| Type | When |
|---|---|
| `hello` | immediately on connect: protocol version, self, server time, full `BrowserState` |
| `state` | full state resync (e.g. after a browser restart) |
| `browser.status` | `starting` / `running` / `restarting` / `crashed` / `stopped` |
| `tab.created` / `tab.closed` / `tab.updated` | tab lifecycle, including adopted popups |
| `tab.navigation` | url / title / loading changed |
| `tab.permissions` | this user's effective permission on a tab |
| `presence` | full user list with state, current tab, last activity |
| `cursors` | batched cursor positions for one tab (20Hz, not per event) |
| `stream.started` / `stream.stopped` | stream lifecycle with the negotiated size |
| `input.ack` | per-event timings: `serverReceiveTime`, `dispatchedAt`, `queueDepth` |
| `clipboard.data` | text copied inside the page |
| `context.info` | answer to `context.probe`: `link`, `image`, `selection` |
| `tab.access.requested` | someone is asking the owner for control (sent to the owner; to admins if the owner is offline) |
| `tab.access.decided` | the owner answered a request this client made |
| `file.chooser` | the page opened a file dialog |
| `download` | download started / progress / completed / canceled |
| `metrics` | server metrics, admins only, every 2s |
| `server.shutdown` | graceful shutdown notice |
| `pong` | reply to `ping`, with server time |
| `error` | `{ code, message, tabId? }` |

`BrowserState` is the whole authoritative picture - `browserId`, `status`,
`tabs[]` (each with url, title, loading, canGoBack/Forward, size, `ownerId`,
viewers),
`users[]`, `limits`, `features`.

## Binary frames

Little-endian, one frame per message:

```
offset  size  field
0       1     magic (0xCB)
1       1     flags (reserved, 0)
2       2     header length
4       N     UTF-8 JSON FrameHeader
4+N     ...   JPEG bytes
```

```ts
interface FrameHeader {
  tabId: string;
  seq: number;        // per-tab monotonic
  width: number;
  height: number;
  scrollX: number;    // page scroll, so overlays can pin to content
  scrollY: number;
  capturedAt: number; // CDP capture timestamp, ms epoch
  sentAt: number;     // server clock when written to the socket
  format: 'jpeg';
}
```

`encodeFrame` / `decodeFrame` are in the protocol package and used by the server,
the web client and the benchmark - one implementation, covered by a round-trip
test.

`capturedAt` is what makes end-to-end latency measurable on the client's own
clock: after an `input.ack` gives `dispatchedAt`, the first frame with
`capturedAt >= dispatchedAt` is the frame that shows that input. See
[performance.md](performance.md).

## Rate limits and backpressure

- Token bucket per connection at `MAX_MESSAGE_RATE` msg/s (default 200). Over
  budget → `error: rate_limited`; a persistent offender is closed with 1008.
- Frames are dropped for a client whose socket has more than
  `BACKPRESSURE_BYTES` queued (default 256KB).
- Cursor updates are batched server-side to one message per tab per 50ms.
- Mouse moves are coalesced client-side to one per animation frame, and again in
  the arbiter if one is still queued for that user.

## Versioning

`hello.protocolVersion` (currently `1`). Additive changes - a new message type, a
new optional field - do not bump it; a client ignores types it does not know.
Removing or changing the meaning of a field does bump it, and the client should
tell the user to reload rather than misinterpret messages.
