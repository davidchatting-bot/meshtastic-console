/**
 * test-encoding.mjs
 * Unit tests for protobuf encoding/decoding and frame building.
 * Run with: node test/test-encoding.mjs
 */

import { _proto, makeWantConfigFrame, makeHeartbeatFrame, makeTextFrame,
         nodeNumToId, idToNodeNum, posIntToDeg, BROADCAST_NUM, PortNum } from '../meshtastic-webserial.js';

const {
  encodeVarint, encodeFixed32, concat,
  fVarint, fLen, fFixed32,
  readVarint, readFixed32, readFloat, readSFixed32, readLenDelim,
  decodeMessage, buildFrame,
  S_FROM_RADIO, S_MESH_PACKET, S_NODE_INFO, S_USER, S_POSITION,
  S_DEVICE_METRICS, S_MY_NODE_INFO, S_DATA,
} = _proto;

// ─── Minimal test harness ─────────────────────────────────────────────────────

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`       ${e.message}`);
    failed++;
  }
}

function eq(a, b, msg = '') {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n       expected: ${sb}\n       got:      ${sa}`);
}

function hexEq(a, b, msg = '') {
  const ha = [...a].map(x => x.toString(16).padStart(2,'0')).join('');
  const hb = [...b].map(x => x.toString(16).padStart(2,'0')).join('');
  if (ha !== hb) throw new Error(`${msg}\n       expected: ${hb}\n       got:      ${ha}`);
}

function approxEq(a, b, epsilon = 0.001, msg = '') {
  if (Math.abs(a - b) > epsilon) throw new Error(`${msg}: ${a} ≉ ${b}`);
}

// ─── varint encoding ──────────────────────────────────────────────────────────

console.log('\nVarint encoding');

test('encode 0', () => hexEq(encodeVarint(0), [0x00]));
test('encode 1', () => hexEq(encodeVarint(1), [0x01]));
test('encode 127', () => hexEq(encodeVarint(127), [0x7F]));
test('encode 128', () => hexEq(encodeVarint(128), [0x80, 0x01]));
test('encode 300', () => hexEq(encodeVarint(300), [0xAC, 0x02]));
test('encode 0xFFFFFFFF (BROADCAST)', () => hexEq(encodeVarint(0xFFFFFFFF), [0xFF, 0xFF, 0xFF, 0xFF, 0x0F]));
test('encode 2665977060 (node num)', () => {
  const bytes = encodeVarint(2665977060);
  eq(bytes.length, 5);
});

console.log('\nVarint decode round-trip');

for (const v of [0, 1, 127, 128, 300, 16383, 16384, 0xFFFF, 0xFFFFFFFF, 2665977060]) {
  test(`round-trip ${v}`, () => {
    const encoded = encodeVarint(v);
    const view = new DataView(encoded.buffer);
    const { value } = readVarint(view, 0);
    eq(value, v >>> 0);
  });
}

// ─── fixed32 ─────────────────────────────────────────────────────────────────

console.log('\nFixed32 encoding');

test('encode 0x9ee794e4', () => {
  const bytes = encodeFixed32(0x9ee794e4);
  eq(bytes.length, 4);
  // little-endian: e4 94 e7 9e
  hexEq(bytes, [0xe4, 0x94, 0xe7, 0x9e]);
});

test('fixed32 round-trip', () => {
  const v = 0x9ee794e4;
  const bytes = encodeFixed32(v);
  const view = new DataView(bytes.buffer);
  const { value } = readFixed32(view, 0);
  eq(value >>> 0, v >>> 0);
});

// ─── sfixed32 (lat/lon) ───────────────────────────────────────────────────────

console.log('\nSFixed32 (latitude/longitude)');

test('negative latitude round-trip', () => {
  // Build a Position message with latitudeI = -15466496 (lon in NE England)
  const lonI = -15466496;
  const fieldBytes = concat(
    encodeVarint((2 << 3) | 5), // field 2, wire type 5
    encodeFixed32(lonI >>> 0),   // sfixed32 encoded as fixed32 bit pattern
  );
  const view = new DataView(fieldBytes.buffer);
  const pos = readVarint(view, 0); // tag
  const { value } = readSFixed32(view, pos.pos);
  eq(value, lonI);
});

test('posIntToDeg converts correctly', () => {
  approxEq(posIntToDeg(549715968), 54.9716, 0.0001);
  approxEq(posIntToDeg(-15466496), -1.5466, 0.0001);
});

// ─── nodeId helpers ───────────────────────────────────────────────────────────

console.log('\nNode ID helpers');

test('nodeNumToId', () => eq(nodeNumToId(2665977060), '!9ee794e4'));
test('nodeNumToId zero-pads', () => eq(nodeNumToId(0x00001234), '!00001234'));
test('idToNodeNum', () => eq(idToNodeNum('!9ee794e4'), 2665977060));
test('round-trip nodeId', () => eq(idToNodeNum(nodeNumToId(2665977060)), 2665977060));
test('BROADCAST_NUM', () => eq(BROADCAST_NUM, 0xFFFFFFFF));

// ─── decodeMessage: User ──────────────────────────────────────────────────────

console.log('\nDecodeMessage: User');

// Build a User protobuf manually and decode it
function makeUserBytes(id, longName, shortName) {
  const enc = new TextEncoder();
  return concat(
    fLen(1, enc.encode(id)),
    fLen(2, enc.encode(longName)),
    fLen(3, enc.encode(shortName)),
  );
}

test('decode User fields', () => {
  const bytes = makeUserBytes('!9ee794e4', 'Meshtastic 94e4', '94e4');
  const user = decodeMessage(bytes, S_USER);
  eq(user.id, '!9ee794e4');
  eq(user.longName, 'Meshtastic 94e4');
  eq(user.shortName, '94e4');
});

test('decode User with unknown fields is tolerant', () => {
  // Add a field not in the schema (field 99, varint)
  const base = makeUserBytes('!abc', 'Test', 'TST');
  const extra = concat(base, fVarint(99, 42));
  const user = decodeMessage(extra, S_USER);
  eq(user.id, '!abc');
});

// ─── decodeMessage: NodeInfo ──────────────────────────────────────────────────

console.log('\nDecodeMessage: NodeInfo');

function makeNodeInfoBytes(num, snr, hopsAway) {
  const userBytes = makeUserBytes(nodeNumToId(num), 'Node ' + num, 'N1');
  return concat(
    fVarint(1, num),
    fLen(2, userBytes),
    // snr: field 4, float, wire type 5
    concat(encodeVarint((4 << 3) | 5), (() => {
      const b = new ArrayBuffer(4);
      new DataView(b).setFloat32(0, snr, true);
      return new Uint8Array(b);
    })()),
    fVarint(9, hopsAway),
  );
}

test('decode NodeInfo num and hopsAway', () => {
  const bytes = makeNodeInfoBytes(2665977060, 5.75, 0);
  const ni = decodeMessage(bytes, S_NODE_INFO);
  eq(ni.num, 2665977060);
  eq(ni.hopsAway, 0);
});

test('decode NodeInfo snr (float)', () => {
  const bytes = makeNodeInfoBytes(2665977060, 5.75, 2);
  const ni = decodeMessage(bytes, S_NODE_INFO);
  approxEq(ni.snr, 5.75);
});

test('decode NodeInfo nested User', () => {
  const bytes = makeNodeInfoBytes(2665977060, 0, 0);
  const ni = decodeMessage(bytes, S_NODE_INFO);
  eq(ni.user.id, nodeNumToId(2665977060));
});

// ─── decodeMessage: MeshPacket ────────────────────────────────────────────────

console.log('\nDecodeMessage: MeshPacket');

function makeTextPacketBytes(fromNum, toNum, text) {
  const payload = new TextEncoder().encode(text);
  const dataBytes = concat(
    fVarint(1, PortNum.TEXT_MESSAGE_APP),
    fLen(2, payload),
  );
  return concat(
    fFixed32(1, fromNum),
    fFixed32(2, toNum),
    fLen(4, dataBytes),
  );
}

test('decode MeshPacket from/to', () => {
  const bytes = makeTextPacketBytes(2665977060, BROADCAST_NUM, 'hello');
  const pkt = decodeMessage(bytes, S_MESH_PACKET);
  eq(pkt.from >>> 0, 2665977060);
  eq(pkt.to >>> 0, BROADCAST_NUM);
});

test('decode MeshPacket decoded.portnum', () => {
  const bytes = makeTextPacketBytes(2665977060, BROADCAST_NUM, 'hello');
  const pkt = decodeMessage(bytes, S_MESH_PACKET);
  eq(pkt.decoded.portnum, PortNum.TEXT_MESSAGE_APP);
});

test('decode MeshPacket decoded.payload as text', () => {
  const bytes = makeTextPacketBytes(2665977060, BROADCAST_NUM, 'hello mesh');
  const pkt = decodeMessage(bytes, S_MESH_PACKET);
  const text = new TextDecoder().decode(pkt.decoded.payload);
  eq(text, 'hello mesh');
});

// ─── Frame building ───────────────────────────────────────────────────────────

console.log('\nFrame building');

test('buildFrame has correct header magic', () => {
  const frame = buildFrame(new Uint8Array([0x01, 0x02]));
  eq(frame[0], 0x94);
  eq(frame[1], 0xC3);
  eq(frame[2], 0x00); // len hi
  eq(frame[3], 0x02); // len lo
  eq(frame[4], 0x01);
  eq(frame[5], 0x02);
});

test('buildFrame length field big-endian', () => {
  const payload = new Uint8Array(300).fill(0xAB);
  const frame = buildFrame(payload);
  eq(frame[2], (300 >> 8) & 0xFF); // 0x01
  eq(frame[3], 300 & 0xFF);        // 0x2C
  eq(frame.length, 304);
});

test('makeWantConfigFrame structure', () => {
  const frame = makeWantConfigFrame(0x12345678);
  eq(frame[0], 0x94); eq(frame[1], 0xC3);
  // payload: field 3, wire type 0 → tag byte = 0x18
  eq(frame[4], 0x18);
});

test('makeHeartbeatFrame structure', () => {
  const frame = makeHeartbeatFrame();
  eq(frame[0], 0x94); eq(frame[1], 0xC3);
  // payload: field 7, wire type 2 → tag = 0x3A, length = 0
  eq(frame[4], 0x3A);
  eq(frame[5], 0x00); // empty sub-message
  eq(frame.length, 6);
});

test('makeTextFrame has correct portnum in payload', () => {
  const frame = makeTextFrame('hi');
  // Decode the payload back
  const payloadBytes = frame.slice(4);
  const toRadio = decodeMessage(payloadBytes, {
    1: { name: 'packet', type: 'message', subSchema: S_MESH_PACKET }
  });
  eq(toRadio.packet.decoded.portnum, PortNum.TEXT_MESSAGE_APP);
});

test('makeTextFrame encodes text correctly', () => {
  const frame = makeTextFrame('hello');
  const payloadBytes = frame.slice(4);
  const toRadio = decodeMessage(payloadBytes, {
    1: { name: 'packet', type: 'message', subSchema: S_MESH_PACKET }
  });
  const text = new TextDecoder().decode(toRadio.packet.decoded.payload);
  eq(text, 'hello');
});

test('makeTextFrame sets to = BROADCAST by default', () => {
  const frame = makeTextFrame('test');
  const payloadBytes = frame.slice(4);
  const toRadio = decodeMessage(payloadBytes, {
    1: { name: 'packet', type: 'message', subSchema: S_MESH_PACKET }
  });
  eq(toRadio.packet.to >>> 0, BROADCAST_NUM);
});

test('makeTextFrame respects custom destination', () => {
  const dest = 0x9ee71364;
  const frame = makeTextFrame('dm', dest, 0);
  const payloadBytes = frame.slice(4);
  const toRadio = decodeMessage(payloadBytes, {
    1: { name: 'packet', type: 'message', subSchema: S_MESH_PACKET }
  });
  eq(toRadio.packet.to >>> 0, dest >>> 0);
});

// ─── FromRadio round-trip ─────────────────────────────────────────────────────

console.log('\nFromRadio decode');

test('decode config_complete_id (field 7)', () => {
  const configId = 0xDEADBEEF >>> 0;
  const bytes = fVarint(7, configId);
  const msg = decodeMessage(bytes, S_FROM_RADIO);
  eq(msg.configCompleteId, configId);
});

test('decode myInfo.myNodeNum', () => {
  const myInfoBytes = fVarint(1, 2665977060);
  const bytes = fLen(3, myInfoBytes);
  const msg = decodeMessage(bytes, S_FROM_RADIO);
  eq(msg.myInfo.myNodeNum, 2665977060);
});

test('decode nodeInfo inside FromRadio', () => {
  const userBytes = makeUserBytes('!9ee794e4', 'Meshtastic 94e4', '94e4');
  const nodeInfoBytes = concat(fVarint(1, 2665977060), fLen(2, userBytes));
  const bytes = fLen(4, nodeInfoBytes);
  const msg = decodeMessage(bytes, S_FROM_RADIO);
  eq(msg.nodeInfo.num, 2665977060);
  eq(msg.nodeInfo.user.longName, 'Meshtastic 94e4');
});

// ─── MeshtasticClient event loop (no hardware) ────────────────────────────────

console.log('\nMeshtasticClient (offline)');

import { MeshtasticClient } from '../meshtastic-webserial.js';

// Async rate-limit test (runs outside the sync harness)
(async () => {
  const client = new MeshtasticClient();
  const writes = [];
  let resolveRead;

  client._writer = {
    write: async (b) => writes.push(b),
    close: async () => {},
  };
  client._running = false;

  const before = Date.now();
  client._lastSendTime = before - 29_000;
  await client.sendText('rate-limit-test');
  const elapsed = Date.now() - before;

  if (elapsed < 900) {
    console.error('  ✗  rate-limit wait (async)');
    console.error(`       Expected ≥1s wait, got ${elapsed}ms`);
    failed++;
  } else {
    console.log('  ✓  rate-limit wait (async)');
    passed++;
  }
})();

test('processChunk feeds the state machine (frame detection)', () => {
  const client = new MeshtasticClient();
  const frames = [];
  client._handleFrame = (b) => frames.push(b);

  // Build a valid frame: [0x94, 0xC3, 0x00, 0x05, 0x01, 0x02, 0x03, 0x04, 0x05]
  const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  const frame = buildFrame(payload);
  client._processChunk(frame);
  eq(frames.length, 1);
  hexEq(frames[0], payload);
});

test('processChunk handles split delivery', () => {
  const client = new MeshtasticClient();
  const frames = [];
  client._handleFrame = (b) => frames.push(b);

  const payload = new Uint8Array([0xAA, 0xBB]);
  const frame = buildFrame(payload);

  // Deliver in three separate chunks
  client._processChunk(frame.slice(0, 2));
  eq(frames.length, 0);
  client._processChunk(frame.slice(2, 4));
  eq(frames.length, 0);
  client._processChunk(frame.slice(4));
  eq(frames.length, 1);
  hexEq(frames[0], payload);
});

test('processChunk skips log bytes before START1', () => {
  const client = new MeshtasticClient();
  const logLines = [];
  client.addEventListener('log', e => logLines.push(e.detail.line));

  const frames = [];
  client._handleFrame = (b) => frames.push(b);

  // Some log text then a real frame
  const log = new TextEncoder().encode('DEBUG: ok\n');
  const payload = new Uint8Array([0xFF]);
  const frame = buildFrame(payload);
  client._processChunk(concat(log, frame));

  eq(logLines.length, 1);
  eq(logLines[0], 'DEBUG: ok');
  eq(frames.length, 1);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

setTimeout(() => {
  const total = passed + failed;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${passed}/${total} tests passed${failed > 0 ? `, ${failed} failed` : ''}`);
  if (failed > 0) process.exit(1);
}, 1500); // allow async rate-limit test to settle
