/**
 * meshtastic-webserial.js
 * WebSerial API library for Meshtastic devices.
 *
 * Wire protocol: START1(0x94) START2(0xC3) [2-byte big-endian length] [protobuf FromRadio/ToRadio]
 * Baud rate: 115200, hardware: Heltec V3 / any CP2102-based Meshtastic node.
 *
 * Rate-limit: sendText() enforces a minimum of 30 seconds between transmissions.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const START1 = 0x94;
const START2 = 0xC3;
const MAX_FRAME_SIZE = 512;
const MIN_SEND_INTERVAL_MS = 30_000;
export const BROADCAST_NUM = 0xFFFFFFFF;

export const PortNum = Object.freeze({
  UNKNOWN_APP: 0,
  TEXT_MESSAGE_APP: 1,
  REMOTE_HARDWARE_APP: 2,
  POSITION_APP: 3,
  NODEINFO_APP: 4,
  ROUTING_APP: 5,
  ADMIN_APP: 6,
  TEXT_MESSAGE_COMPRESSED_APP: 7,
  WAYPOINT_APP: 8,
  AUDIO_APP: 9,
  DETECTION_SENSOR_APP: 10,
  ALERT_APP: 11,
  KEY_VERIFICATION_APP: 12,
  REPLY_APP: 32,
  IP_TUNNEL_APP: 33,
  PAXCOUNTER_APP: 34,
  STORE_FORWARD_PLUSPLUS_APP: 35,
  NODE_STATUS_APP: 36,
  SERIAL_APP: 64,
  STORE_FORWARD_APP: 65,
  RANGE_TEST_APP: 66,
  TELEMETRY_APP: 67,
  ZPS_APP: 68,
  SIMULATOR_APP: 69,
  TRACEROUTE_APP: 70,
  NEIGHBORINFO_APP: 71,
  ATAK_PLUGIN: 72,
  MAP_REPORT_APP: 73,
});

const PORT_NUM_NAMES = Object.fromEntries(Object.entries(PortNum).map(([k, v]) => [v, k]));

// ─── Protobuf encoding ────────────────────────────────────────────────────────

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7F;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return new Uint8Array(bytes);
}

function encodeFixed32(value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, value >>> 0, true);
  return new Uint8Array(buf);
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}

function fieldTag(num, wireType) { return encodeVarint((num << 3) | wireType); }

// Wire type 0 – varint
function fVarint(num, value) {
  return concat(fieldTag(num, 0), encodeVarint(value));
}

// Wire type 2 – length-delimited (bytes / string / sub-message)
function fLen(num, bytes) {
  return concat(fieldTag(num, 2), encodeVarint(bytes.length), bytes);
}

// Wire type 5 – fixed 32-bit
function fFixed32(num, value) {
  return concat(fieldTag(num, 5), encodeFixed32(value));
}

// ─── Protobuf decoding ────────────────────────────────────────────────────────

function readVarint(view, pos) {
  let result = 0, shift = 0, b;
  do {
    if (pos >= view.byteLength) break;
    b = view.getUint8(pos++);
    result |= (b & 0x7F) << shift;
    shift += 7;
  } while (b & 0x80 && shift < 35);
  // drain any remaining bytes of an overlong (64-bit) varint
  while (b & 0x80 && pos < view.byteLength) b = view.getUint8(pos++);
  return { value: result >>> 0, pos };
}

function readFixed32(view, pos) {
  return { value: view.getUint32(pos, true), pos: pos + 4 };
}

function readSFixed32(view, pos) {
  return { value: view.getInt32(pos, true), pos: pos + 4 };
}

function readFloat(view, pos) {
  return { value: view.getFloat32(pos, true), pos: pos + 4 };
}

function readFixed64(view, pos) {
  const lo = view.getUint32(pos, true);
  const hi = view.getUint32(pos + 4, true);
  // Return as number (may lose precision for huge values, but node nums fit in 32 bits)
  return { value: lo + hi * 0x100000000, pos: pos + 8 };
}

function readLenDelim(view, pos) {
  const r = readVarint(view, pos);
  const start = r.pos;
  const end = start + r.value;
  return { bytes: new Uint8Array(view.buffer, view.byteOffset + start, r.value).slice(), pos: end };
}

/**
 * Generic protobuf message decoder.
 * schema: { [fieldNumber]: { name, type, repeated?, subSchema? } }
 * type: 'uint32'|'int32'|'bool'|'string'|'bytes'|'float'|'fixed32'|'sfixed32'|'message'
 * Set repeated:true for repeated fields; packed encoding is handled automatically.
 */
function decodeMessage(bytes, schema) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = {};
  let pos = 0;

  const push = (def, v) => {
    if (def.repeated) { (result[def.name] ??= []).push(v); }
    else { result[def.name] = v; }
  };

  while (pos < bytes.byteLength) {
    const tagResult = readVarint(view, pos);
    pos = tagResult.pos;
    if (pos > bytes.byteLength) break;

    const fieldNum = tagResult.value >>> 3;
    const wireType = tagResult.value & 0x07;
    const def = schema[fieldNum];

    switch (wireType) {
      case 0: { // varint
        const r = readVarint(view, pos); pos = r.pos;
        if (def) {
          // int32 negative values arrive as large unsigned varints; reinterpret as signed
          const v = def.type === 'bool'  ? r.value !== 0
                  : def.type === 'int32' ? (r.value | 0)
                  : r.value;
          push(def, v);
        }
        break;
      }
      case 1: { // 64-bit
        const r = readFixed64(view, pos); pos = r.pos;
        if (def) push(def, r.value);
        break;
      }
      case 2: { // length-delimited
        const r = readLenDelim(view, pos); pos = r.pos;
        if (!def) break;
        if (def.type === 'string') {
          push(def, new TextDecoder().decode(r.bytes));
        } else if (def.type === 'bytes') {
          push(def, r.bytes);
        } else if (def.type === 'message') {
          push(def, decodeMessage(r.bytes, def.subSchema));
        } else if (def.repeated) {
          // Packed repeated field — unpack all values from the byte run
          const pv = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength);
          let pp = 0;
          while (pp < r.bytes.byteLength) {
            if (def.type === 'fixed32') {
              (result[def.name] ??= []).push(pv.getUint32(pp, true)); pp += 4;
            } else { // int32 / uint32
              const vr = readVarint(pv, pp); pp = vr.pos;
              (result[def.name] ??= []).push(def.type === 'int32' ? (vr.value | 0) : vr.value);
            }
          }
        } else {
          result[def.name] = r.bytes;
        }
        break;
      }
      case 5: { // 32-bit
        if (!def) { pos += 4; break; }
        const v = def.type === 'float'   ? readFloat(view, pos).value
                : def.type === 'sfixed32'? readSFixed32(view, pos).value
                :                          readFixed32(view, pos).value;
        pos += 4;
        push(def, v);
        break;
      }
      default:
        pos = bytes.byteLength; // unknown wire type — abort frame
    }
  }

  return result;
}

// ─── Protobuf schemas ─────────────────────────────────────────────────────────

const S_DEVICE_METRICS = {
  1: { name: 'batteryLevel',       type: 'uint32'  },
  2: { name: 'voltage',            type: 'float'   },
  3: { name: 'channelUtilization', type: 'float'   },
  4: { name: 'airUtilTx',          type: 'float'   },
  5: { name: 'uptimeSeconds',      type: 'uint32'  },
};

const S_USER = {
  1: { name: 'id',             type: 'string' },
  2: { name: 'longName',       type: 'string' },
  3: { name: 'shortName',      type: 'string' },
  4: { name: 'macaddr',        type: 'bytes'  },
  5: { name: 'hwModel',        type: 'uint32' },
  6: { name: 'isLicensed',     type: 'bool'   },
  7: { name: 'role',           type: 'uint32' },
  8: { name: 'publicKey',      type: 'bytes'  },
  9: { name: 'isUnmessagable', type: 'bool'   },
};

const S_POSITION = {
  1:  { name: 'latitudeI',      type: 'sfixed32' },
  2:  { name: 'longitudeI',     type: 'sfixed32' },
  3:  { name: 'altitude',       type: 'int32'    },
  4:  { name: 'time',           type: 'fixed32'  },
  5:  { name: 'locationSource', type: 'uint32'   },
  15: { name: 'groundSpeed',    type: 'uint32'   },
  16: { name: 'groundTrack',    type: 'uint32'   },
};

const S_NODE_INFO = {
  1:  { name: 'num',           type: 'uint32'  },
  2:  { name: 'user',          type: 'message', subSchema: S_USER           },
  3:  { name: 'position',      type: 'message', subSchema: S_POSITION       },
  4:  { name: 'snr',           type: 'float'   },
  5:  { name: 'lastHeard',     type: 'fixed32' },
  6:  { name: 'deviceMetrics', type: 'message', subSchema: S_DEVICE_METRICS },
  7:  { name: 'channel',       type: 'uint32'  },
  8:  { name: 'viaMqtt',       type: 'bool'    },
  9:  { name: 'hopsAway',      type: 'uint32'  },
  10: { name: 'isFavorite',    type: 'bool'    },
};

const S_DATA = {
  1: { name: 'portnum',      type: 'uint32'  },
  2: { name: 'payload',      type: 'bytes'   },
  3: { name: 'wantResponse', type: 'bool'    },
  4: { name: 'dest',         type: 'fixed32' },
  5: { name: 'source',       type: 'fixed32' },
  6: { name: 'requestId',    type: 'fixed32' },
};

const S_MESH_PACKET = {
  1:  { name: 'from',     type: 'fixed32' },
  2:  { name: 'to',       type: 'fixed32' },
  3:  { name: 'channel',  type: 'uint32'  },
  4:  { name: 'decoded',  type: 'message', subSchema: S_DATA },
  5:  { name: 'encrypted',type: 'bytes'   },
  6:  { name: 'id',       type: 'fixed32' },
  7:  { name: 'rxTime',   type: 'fixed32' },
  8:  { name: 'rxSnr',    type: 'float'   },
  9:  { name: 'hopLimit', type: 'uint32'  },
  10: { name: 'wantAck',  type: 'bool'    },
  12: { name: 'rxRssi',   type: 'int32'   },
  14: { name: 'viaMqtt',  type: 'bool'    },
  15: { name: 'hopStart', type: 'uint32'  },
};

const S_MY_NODE_INFO = {
  1:  { name: 'myNodeNum',    type: 'uint32' },
  8:  { name: 'rebootCount',  type: 'uint32' },
  13: { name: 'pioEnv',       type: 'string' },
  14: { name: 'firmwareEdition', type: 'uint32' },
  15: { name: 'nodedbCount',  type: 'uint32' },
};

const S_DEVICE_METADATA = {
  1:  { name: 'firmwareVersion',    type: 'string' },
  2:  { name: 'deviceStateVersion', type: 'uint32' },
  4:  { name: 'hasWifi',            type: 'bool'   },
  5:  { name: 'hasBluetooth',       type: 'bool'   },
  9:  { name: 'hwModel',            type: 'uint32' },
  11: { name: 'hasPKC',             type: 'bool'   },
};

const S_FROM_RADIO = {
  1:  { name: 'id',             type: 'uint32'  },
  2:  { name: 'packet',         type: 'message', subSchema: S_MESH_PACKET     },
  3:  { name: 'myInfo',         type: 'message', subSchema: S_MY_NODE_INFO    },
  4:  { name: 'nodeInfo',       type: 'message', subSchema: S_NODE_INFO       },
  7:  { name: 'configCompleteId', type: 'uint32' },
  8:  { name: 'rebooted',       type: 'bool'    },
  13: { name: 'metadata',       type: 'message', subSchema: S_DEVICE_METADATA },
};

// SNR values in RouteDiscovery are stored as int32 in units of 0.25 dB
const S_ROUTE_DISCOVERY = {
  1: { name: 'route',      type: 'fixed32', repeated: true },
  2: { name: 'snrTowards', type: 'int32',   repeated: true },
  3: { name: 'routeBack',  type: 'fixed32', repeated: true },
  4: { name: 'snrBack',    type: 'int32',   repeated: true },
};

// ─── Frame builder ────────────────────────────────────────────────────────────

function buildFrame(protoBytes) {
  const len = protoBytes.length;
  if (len > MAX_FRAME_SIZE) throw new Error(`Frame too large: ${len} > ${MAX_FRAME_SIZE}`);
  const frame = new Uint8Array(4 + len);
  frame[0] = START1;
  frame[1] = START2;
  frame[2] = (len >> 8) & 0xFF;
  frame[3] = len & 0xFF;
  frame.set(protoBytes, 4);
  return frame;
}

// ─── ToRadio frame constructors ───────────────────────────────────────────────

export function makeWantConfigFrame(configId) {
  return buildFrame(fVarint(3, configId));
}

export function makeHeartbeatFrame() {
  // heartbeat = field 7, sub-message (empty Heartbeat message)
  return buildFrame(fLen(7, new Uint8Array(0)));
}

export function makeTextFrame(text, to = BROADCAST_NUM, channel = 0) {
  const payload = new TextEncoder().encode(text);
  const dataBytes = concat(
    fVarint(1, PortNum.TEXT_MESSAGE_APP),
    fLen(2, payload),
  );
  const packetId = (Math.random() * 0xFFFFFFFE + 1) >>> 0;
  const packetBytes = concat(
    fFixed32(2, to),
    fVarint(3, channel),
    fLen(4, dataBytes),
    fFixed32(6, packetId),
    fVarint(9, 3),    // hopLimit = 3
  );
  return buildFrame(fLen(1, packetBytes));
}

export function makeTracerouteFrame(destNum, channel = 0) {
  const dataBytes = concat(
    fVarint(1, PortNum.TRACEROUTE_APP),
    fLen(2, new Uint8Array(0)), // empty RouteDiscovery — filled in by hops
    fVarint(3, 1),              // want_response = true
  );
  const packetId = (Math.random() * 0xFFFFFFFE + 1) >>> 0;
  const packetBytes = concat(
    fFixed32(2, destNum),
    fVarint(3, channel),
    fLen(4, dataBytes),
    fFixed32(6, packetId),
    fVarint(9, 7),  // hop_limit = 7 (allows full route discovery)
  );
  return buildFrame(fLen(1, packetBytes));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function nodeNumToId(num) {
  return '!' + (num >>> 0).toString(16).padStart(8, '0');
}

export function idToNodeNum(id) {
  return parseInt(id.replace('!', ''), 16) >>> 0;
}

export function portNumName(num) {
  return PORT_NUM_NAMES[num] ?? `UNKNOWN(${num})`;
}

/** Convert position integer (1e-7 degrees) to decimal degrees. */
export function posIntToDeg(i) { return i / 1e7; }

// ─── MeshtasticClient ─────────────────────────────────────────────────────────

/**
 * WebSerial-based Meshtastic client.
 *
 * Usage:
 *   const port = await navigator.serial.requestPort();
 *   const client = new MeshtasticClient();
 *   await client.connect(port);
 *   client.on('text', e => console.log(e.detail));
 *   await client.sendText('hello');
 */
export class MeshtasticClient extends EventTarget {
  constructor() {
    super();
    this._port     = null;
    this._writer   = null;
    this._reader   = null;
    this._running  = false;

    // receive state machine
    this._rxState      = 0;   // 0=START1 1=START2 2=LEN_HI 3=LEN_LO 4=PAYLOAD
    this._rxPayloadLen = 0;
    this._rxPayload    = new Uint8Array(MAX_FRAME_SIZE);
    this._rxPayloadPos = 0;
    this._rxLogLine    = '';

    this._configId      = (Math.random() * 0xFFFFFFFE + 1) >>> 0;
    this._lastSendTime  = 0;

    /** Map of nodeId → nodeInfo object, populated during config download. */
    this.nodes     = new Map();
    this.myInfo    = null;   // MyNodeInfo
    this.metadata  = null;   // DeviceMetadata
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Open a WebSerial port and wait for the full config download from the radio.
   * @param {SerialPort} port  A WebSerial SerialPort (or compatible mock)
   * @param {number} [timeoutMs=20000]
   */
  async connect(port, timeoutMs = 20_000) {
    this._port = port;
    await port.open({ baudRate: 115200 });
    this._writer = port.writable.getWriter();
    this._running = true;
    this._readLoop().catch(err => this._emit('error', { error: err }));

    // Wakeup sequence: send 32 × START2 to resync device parser
    await this._write(new Uint8Array(32).fill(START2));
    await sleep(150);
    await this._write(makeWantConfigFrame(this._configId));

    await Promise.race([
      new Promise(resolve => this.addEventListener('connected', resolve, { once: true })),
      sleep(timeoutMs).then(() => { throw new Error('connect timeout'); }),
    ]);
  }

  /** Close the connection gracefully. */
  async disconnect() {
    this._running = false;
    try { this._reader?.cancel(); } catch {}
    try { await this._writer?.close(); } catch {}
    try { await this._port?.close(); } catch {}
    this._emit('disconnected', {});
  }

  /**
   * Send a text message. Enforces 30-second minimum between sends.
   * @param {string} text
   * @param {number} [to=BROADCAST_NUM]  Destination node number
   * @param {number} [channel=0]
   */
  async sendText(text, to = BROADCAST_NUM, channel = 0) {
    const now = Date.now();
    const elapsed = now - this._lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      const wait = MIN_SEND_INTERVAL_MS - elapsed;
      console.warn(`[meshtastic] rate-limit: waiting ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
    await this._write(makeTextFrame(text, to, channel));
    this._lastSendTime = Date.now();
  }

  /** Send a heartbeat to keep the connection alive. */
  async sendHeartbeat() {
    await this._write(makeHeartbeatFrame());
  }

  /**
   * Send a traceroute request to a node. Shares the 30-second send rate limit.
   * Fires a 'traceroute' event when the response arrives.
   * @param {number} destNum  Destination node number
   * @param {number} [channel=0]
   */
  async sendTraceroute(destNum, channel = 0) {
    const now = Date.now();
    const elapsed = now - this._lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - elapsed);
    }
    await this._write(makeTracerouteFrame(destNum, channel));
    this._lastSendTime = Date.now();
  }

  /**
   * Returns a snapshot array of all known nodes, sorted by last-heard descending.
   * Each node has position lat/lon added as decimal degrees where available.
   */
  getNodes() {
    return [...this.nodes.values()]
      .map(n => ({
        ...n,
        nodeId: nodeNumToId(n.num),
        position: n.position
          ? { ...n.position,
              lat: posIntToDeg(n.position.latitudeI ?? 0),
              lon: posIntToDeg(n.position.longitudeI ?? 0) }
          : null,
      }))
      .sort((a, b) => (b.lastHeard ?? 0) - (a.lastHeard ?? 0));
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  async _write(bytes) {
    await this._writer.write(bytes);
  }

  async _readLoop() {
    this._reader = this._port.readable.getReader();
    try {
      while (this._running) {
        const { value, done } = await this._reader.read();
        if (done) break;
        this._processChunk(value);
      }
    } catch (e) {
      if (this._running) this._emit('error', { error: e });
    } finally {
      this._reader.releaseLock();
      this._running = false;
    }
  }

  _processChunk(chunk) {
    for (const byte of chunk) {
      switch (this._rxState) {
        case 0: // waiting for START1
          if (byte === START1) {
            this._rxState = 1;
          } else {
            this._handleLogByte(byte);
          }
          break;

        case 1: // waiting for START2
          if (byte === START2) {
            this._rxState = 2;
          } else {
            this._rxState = 0;
            this._handleLogByte(byte);
          }
          break;

        case 2: // high byte of length
          this._rxPayloadLen = byte << 8;
          this._rxState = 3;
          break;

        case 3: // low byte of length
          this._rxPayloadLen |= byte;
          this._rxPayloadPos = 0;
          if (this._rxPayloadLen === 0) {
            this._handleFrame(new Uint8Array(0));
            this._rxState = 0;
          } else if (this._rxPayloadLen > MAX_FRAME_SIZE) {
            this._rxState = 0; // discard oversized frame
          } else {
            this._rxState = 4;
          }
          break;

        case 4: // reading payload
          this._rxPayload[this._rxPayloadPos++] = byte;
          if (this._rxPayloadPos === this._rxPayloadLen) {
            this._handleFrame(this._rxPayload.slice(0, this._rxPayloadLen));
            this._rxState = 0;
          }
          break;
      }
    }
  }

  _handleLogByte(byte) {
    const ch = String.fromCharCode(byte);
    if (ch === '\n') {
      if (this._rxLogLine) {
        this._emit('log', { line: this._rxLogLine });
        this._rxLogLine = '';
      }
    } else if (ch !== '\r') {
      this._rxLogLine += ch;
    }
  }

  _handleFrame(bytes) {
    let msg;
    try {
      msg = decodeMessage(bytes, S_FROM_RADIO);
    } catch {
      return; // malformed frame
    }

    this._emit('frame', { raw: bytes, decoded: msg });

    if (msg.myInfo) {
      this.myInfo = msg.myInfo;
      this._emit('myinfo', msg.myInfo);
    }

    if (msg.metadata) {
      this.metadata = msg.metadata;
      this._emit('metadata', msg.metadata);
    }

    if (msg.nodeInfo) {
      const nodeId = nodeNumToId(msg.nodeInfo.num);
      this.nodes.set(nodeId, { ...msg.nodeInfo, nodeId });
      this._emit('nodeinfo', { nodeId, node: msg.nodeInfo });
    }

    if (msg.rebooted) {
      this._emit('rebooted', {});
    }

    if (msg.configCompleteId !== undefined) {
      if (msg.configCompleteId === this._configId) {
        this._emit('connected', { nodeCount: this.nodes.size, myInfo: this.myInfo });
      }
    }

    if (msg.packet) {
      this._handlePacket(msg.packet);
    }
  }

  _handlePacket(pkt) {
    // Annotate with friendly id strings
    const annotated = {
      ...pkt,
      fromId: nodeNumToId(pkt.from ?? 0),
      toId:   pkt.to === BROADCAST_NUM ? 'broadcast' : nodeNumToId(pkt.to ?? 0),
    };

    this._emit('packet', annotated);

    const decoded = pkt.decoded;
    if (!decoded) return;

    const portnum = decoded.portnum;
    annotated.portnumName = portNumName(portnum);

    switch (portnum) {
      case PortNum.TEXT_MESSAGE_APP: {
        const text = new TextDecoder().decode(decoded.payload ?? new Uint8Array(0));
        this._emit('text', { ...annotated, text });
        break;
      }
      case PortNum.NODEINFO_APP: {
        try {
          const user = decodeMessage(decoded.payload ?? new Uint8Array(0), S_USER);
          this._emit('nodeinfo_packet', { ...annotated, user });
        } catch {}
        break;
      }
      case PortNum.POSITION_APP: {
        try {
          const pos = decodeMessage(decoded.payload ?? new Uint8Array(0), S_POSITION);
          const lat = posIntToDeg(pos.latitudeI ?? 0);
          const lon = posIntToDeg(pos.longitudeI ?? 0);
          this._emit('position', { ...annotated, position: { ...pos, lat, lon } });
        } catch {}
        break;
      }
      case PortNum.TELEMETRY_APP:
        this._emit('telemetry', { ...annotated, rawPayload: decoded.payload });
        break;
      case PortNum.ROUTING_APP:
        this._emit('routing', annotated);
        break;
      case PortNum.TRACEROUTE_APP: {
        try {
          const rd = decodeMessage(decoded.payload ?? new Uint8Array(0), S_ROUTE_DISCOVERY);
          // SNR values are in 0.25 dB units
          const snrTowards = (rd.snrTowards ?? []).map(v => v / 4);
          const snrBack    = (rd.snrBack    ?? []).map(v => v / 4);
          this._emit('traceroute', {
            ...annotated,
            route:      rd.route      ?? [],
            snrTowards,
            routeBack:  rd.routeBack  ?? [],
            snrBack,
          });
        } catch { this._emit('traceroute', { ...annotated, route: [], snrTowards: [] }); }
        break;
      }
      default:
        this._emit('data', annotated);
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new _CustomEvent(type, { detail }));
  }

  /**
   * Convenience alias for addEventListener.
   * client.on('text', ({ detail }) => console.log(detail.text))
   */
  on(type, handler) {
    this.addEventListener(type, handler);
    return this;
  }

  off(type, handler) {
    this.removeEventListener(type, handler);
    return this;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// CustomEvent is available in browsers and Node.js ≥18.7 but may need a shim.
const _CustomEvent = typeof CustomEvent !== 'undefined'
  ? CustomEvent
  : class CustomEvent extends Event {
      constructor(type, opts = {}) { super(type, opts); this.detail = opts.detail ?? null; }
    };

// ─── Named exports for testing protobuf primitives ────────────────────────────

export const _proto = {
  encodeVarint, encodeFixed32, concat,
  fVarint, fLen, fFixed32,
  readVarint, readFixed32, readFloat, readSFixed32, readLenDelim,
  decodeMessage,
  buildFrame,
  S_FROM_RADIO, S_MESH_PACKET, S_NODE_INFO, S_USER, S_POSITION,
  S_DEVICE_METRICS, S_MY_NODE_INFO, S_DEVICE_METADATA, S_DATA,
  S_ROUTE_DISCOVERY,
};
