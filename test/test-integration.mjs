/**
 * test-integration.mjs
 * Integration test: connects to a real Meshtastic radio on /dev/ttyUSB0,
 * downloads the node DB, monitors packets for 30s, then exits.
 *
 * Run with: node test/test-integration.mjs [--send]
 * Pass --send to also transmit one test text message (observes 30s rate-limit).
 *
 * The radio must be accessible at /dev/ttyUSB0.
 */

import { MeshtasticClient, nodeNumToId, portNumName, posIntToDeg, BROADCAST_NUM }
  from '../meshtastic-webserial.js';
import { NodeSerialAdapter } from './node-serial-adapter.mjs';

const SERIAL_PATH  = '/dev/ttyUSB0';
const MONITOR_SECS = 30;
const SEND_TEXT    = process.argv.includes('--send');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatNode(n) {
  const pos = n.position?.lat != null
    ? `  pos: (${n.position.lat.toFixed(5)}, ${n.position.lon.toFixed(5)}) ` +
      `alt=${n.position.altitude ?? '?'}m`
    : '';
  const dm = n.deviceMetrics
    ? `  batt=${n.deviceMetrics.batteryLevel}%  ` +
      `ch_util=${n.deviceMetrics.channelUtilization?.toFixed(1)}%  ` +
      `uptime=${Math.floor((n.deviceMetrics.uptimeSeconds ?? 0) / 3600)}h`
    : '';
  const heard = n.lastHeard
    ? `  heard=${new Date(n.lastHeard * 1000).toISOString()}`
    : '';
  return `  ${n.nodeId.padEnd(12)} ${(n.user?.longName ?? '?').padEnd(30)}` +
    `hops=${n.hopsAway ?? '?'}  snr=${n.snr?.toFixed(2) ?? '?'}dB${heard}${pos}${dm}`;
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log(`\n[${ts()}] Opening ${SERIAL_PATH} ...`);

const adapter = new NodeSerialAdapter(SERIAL_PATH);
const client  = new MeshtasticClient();

// Wire up all events for visibility
client.on('log',      ({ detail: d }) => console.log(`[${ts()}] LOG: ${d.line}`));
client.on('myinfo',   ({ detail: d }) => console.log(`[${ts()}] MyInfo: node ${nodeNumToId(d.myNodeNum)}  reboot_count=${d.rebootCount}`));
client.on('metadata', ({ detail: d }) => console.log(`[${ts()}] Metadata: fw=${d.firmwareVersion}  hw=${d.hwModel}`));
client.on('nodeinfo', ({ detail: d }) => {
  const n = d.node;
  console.log(`[${ts()}] NodeInfo: ${d.nodeId}  ${n.user?.longName ?? '?'}  hops=${n.hopsAway ?? '?'}  snr=${n.snr?.toFixed(2) ?? '?'}`);
});
client.on('text', ({ detail: d }) => {
  console.log(`[${ts()}] TEXT  from=${d.fromId}  to=${d.toId}  ch=${d.channel}: "${d.text}"`);
});
client.on('position', ({ detail: d }) => {
  console.log(`[${ts()}] POS   from=${d.fromId}  lat=${d.position.lat.toFixed(5)} lon=${d.position.lon.toFixed(5)} alt=${d.position.altitude ?? '?'}m`);
});
client.on('telemetry', ({ detail: d }) => {
  console.log(`[${ts()}] TELEM from=${d.fromId}  ${d.rawPayload?.length ?? 0}B payload`);
});
client.on('packet', ({ detail: d }) => {
  if (!d.decoded) {
    console.log(`[${ts()}] PKT   from=${d.fromId}  to=${d.toId}  ENCRYPTED  ch=${d.channel}`);
  }
});
client.on('rebooted', () => console.log(`[${ts()}] DEVICE REBOOTED`));
client.on('error',    ({ detail: d }) => console.error(`[${ts()}] ERROR:`, d.error));

// ─── Connect and download node DB ─────────────────────────────────────────────

console.log(`[${ts()}] Connecting (waiting for config download)...`);
const t0 = Date.now();

try {
  await client.connect(adapter, 20_000);
} catch (err) {
  console.error(`[${ts()}] Failed to connect: ${err.message}`);
  process.exit(1);
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n[${ts()}] Connected in ${elapsed}s`);

// ─── Print node summary ───────────────────────────────────────────────────────

const nodes = client.getNodes();
console.log(`\n${'─'.repeat(80)}`);
console.log(`  ${nodes.length} nodes in DB`);
console.log(`${'─'.repeat(80)}`);
nodes.forEach(n => console.log(formatNode(n)));
console.log(`${'─'.repeat(80)}\n`);

// ─── Optional send ────────────────────────────────────────────────────────────

if (SEND_TEXT) {
  console.log(`[${ts()}] Sending test message (rate-limit: 30s enforced)...`);
  try {
    await client.sendText('Meshtastic WebSerial test');
    console.log(`[${ts()}] Message sent OK`);
  } catch (err) {
    console.error(`[${ts()}] Send failed: ${err.message}`);
  }
}

// ─── Monitor for MONITOR_SECS ─────────────────────────────────────────────────

console.log(`[${ts()}] Monitoring for ${MONITOR_SECS}s (Ctrl-C to stop early)...\n`);

await new Promise(resolve => setTimeout(resolve, MONITOR_SECS * 1000));

// ─── Print final node summary (includes any updates received during monitor) ──

const finalNodes = client.getNodes();
console.log(`\n${'─'.repeat(80)}`);
console.log(`  Final snapshot: ${finalNodes.length} nodes`);
console.log(`${'─'.repeat(80)}`);
finalNodes.slice(0, 20).forEach(n => console.log(formatNode(n)));
if (finalNodes.length > 20) console.log(`  ... and ${finalNodes.length - 20} more`);
console.log(`${'─'.repeat(80)}\n`);

await client.disconnect();
console.log(`[${ts()}] Disconnected. Done.`);
