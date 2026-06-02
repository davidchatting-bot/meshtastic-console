/**
 * node-serial-adapter.mjs
 * Wraps the Node.js `serialport` package behind a WebSerial-compatible interface
 * so the library can be tested in Node.js without a browser.
 *
 * The adapter implements:
 *   port.open({ baudRate })
 *   port.readable   → { getReader() → { read(), releaseLock(), cancel() } }
 *   port.writable   → { getWriter() → { write(Uint8Array), releaseLock() } }
 *   port.close()
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { SerialPort } = require('serialport');

export class NodeSerialAdapter {
  constructor(path) {
    this._path = path;
    this._sp   = null;
    this._readQueue    = [];   // buffered incoming Uint8Array chunks
    this._readWaiters  = [];   // pending Promise resolvers from read()
    this._closed       = false;
  }

  async open({ baudRate }) {
    this._sp = new SerialPort({ path: this._path, baudRate, autoOpen: false });

    await new Promise((res, rej) => {
      this._sp.open(err => err ? rej(err) : res());
    });

    this._sp.on('data', chunk => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (this._readWaiters.length > 0) {
        this._readWaiters.shift()({ value: bytes.slice(), done: false });
      } else {
        this._readQueue.push(bytes.slice());
      }
    });

    this._sp.on('close', () => {
      this._closed = true;
      // Drain any waiting readers
      while (this._readWaiters.length) {
        this._readWaiters.shift()({ value: undefined, done: true });
      }
    });

    this._sp.on('error', err => {
      // Drain waiting readers with done=true so the read loop exits
      while (this._readWaiters.length) {
        this._readWaiters.shift()({ value: undefined, done: true });
      }
    });
  }

  get readable() {
    const self = this;
    let locked = false;
    return {
      getReader() {
        if (locked) throw new Error('readable is already locked');
        locked = true;
        let cancelled = false;
        return {
          read() {
            if (cancelled || self._closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            if (self._readQueue.length > 0) {
              return Promise.resolve({ value: self._readQueue.shift(), done: false });
            }
            return new Promise(resolve => self._readWaiters.push(resolve));
          },
          releaseLock() { locked = false; },
          cancel() {
            cancelled = true;
            // Unblock any pending read()
            while (self._readWaiters.length) {
              self._readWaiters.shift()({ value: undefined, done: true });
            }
          },
        };
      },
    };
  }

  get writable() {
    const self = this;
    let locked = false;
    return {
      getWriter() {
        if (locked) throw new Error('writable is already locked');
        locked = true;
        return {
          write(data) {
            return new Promise((res, rej) => {
              self._sp.write(Buffer.from(data), err => err ? rej(err) : res());
            });
          },
          close() {
            return Promise.resolve();
          },
          releaseLock() { locked = false; },
        };
      },
    };
  }

  async close() {
    if (this._sp && this._sp.isOpen) {
      await new Promise((res, rej) => this._sp.close(err => err ? rej(err) : res()));
    }
  }
}
