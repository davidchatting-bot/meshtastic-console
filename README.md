# Meshtastic WebSerial Console

A lightweight, zero-dependency browser console for Meshtastic radios — live node map, signal stats, GPS positions, and traceroute.

**Live:** https://davidchatting-bot.github.io/meshtastic-console/

## Usage

Open the page in **Chrome or Edge**, plug in your Meshtastic radio via USB, and click **Connect to Radio**. The console downloads the node DB from the radio and then monitors the mesh live.

No install, no build step, no account needed.

## What it shows

| Column | Source |
|--------|--------|
| Node ID / Name | NodeInfo broadcasts |
| Hardware | HW model from NodeInfo |
| Hops | Distance in hops from your radio |
| SNR | Signal-to-noise ratio (dB), updated on every received packet |
| Last Heard | Timestamp from received packets, live clock |
| Position | GPS coordinates with OpenStreetMap link |
| Battery | Device metrics telemetry |
| Uptime | Device metrics telemetry |
| Traceroute | On-demand — click **⟿ trace** on any row |

Click any column header to sort. The event log at the bottom shows all received packets in real time.

## Traceroute

Click **⟿ trace** on a node row to send a traceroute request. Each intermediate node appends its ID and SNR to the route; the destination replies and the full path is displayed inline:

```
local → !abc1 (5.2dB) → !abc2 (3.1dB) → destination
```

Traceroutes share the 30-second rate limit with text messages — the button is rate-limited automatically.

## Local server (optional)

If your radio is attached to a different machine on your network, run the included bridge server:

```bash
npm install
node server.mjs
```

This serves the console over HTTP and bridges the serial port over WebSocket. Access it from any browser on your network at the printed URL.

> **Note:** WebSerial only works from HTTPS or localhost. The GitHub Pages URL above is HTTPS. The local server serves HTTP — WebSerial works there via localhost, and the WebSocket bridge handles connections from other machines.

## `meshtastic-webserial.js` — the library

A single ES module (~500 lines, zero dependencies) that implements the Meshtastic serial protocol.

```js
import { MeshtasticClient, nodeNumToId } from './meshtastic-webserial.js';

const port   = await navigator.serial.requestPort();
const client = new MeshtasticClient();
await client.connect(port);

client.on('text',       ({ detail }) => console.log(detail.text));
client.on('position',   ({ detail }) => console.log(detail.position));
client.on('telemetry',  ({ detail }) => console.log(detail));
client.on('traceroute', ({ detail }) => console.log(detail.route));

await client.sendText('hello mesh');           // 30s rate limit enforced
await client.sendTraceroute(0x9ee71364);       // sends traceroute, fires 'traceroute' event on reply
```

### Events

| Event | Detail fields |
|-------|---------------|
| `connected` | `nodeCount` |
| `disconnected` | — |
| `nodeinfo` | `nodeId`, `node` |
| `text` | `fromId`, `toId`, `channel`, `text` |
| `position` | `fromId`, `position.lat/lon/altitude` |
| `telemetry` | `fromId`, `rawPayload` |
| `traceroute` | `fromId`, `route[]`, `snrTowards[]`, `routeBack[]`, `snrBack[]` |
| `packet` | raw annotated `MeshPacket` |
| `log` | `line` — device debug output |

### Why a new library?

The official [`@meshtastic/js`](https://github.com/meshtastic/js) covers everything including BLE, TCP, config, and admin. This library's niche is **zero dependencies, no build step, usable directly from a `<script type="module">` tag or GitHub Pages**.
