'use strict';

/**
 * Pion ↔ pi RPC transport.
 *
 * Wraps one long-lived `pi --mode rpc` child process. The protocol (pi docs/rpc.md) is
 * JSONL over stdin/stdout: the host writes `{id, type, ...}` commands, pi answers each
 * with a `response` record echoing the `id`, and independently streams session events
 * (same shapes as `--mode json`, so the panel's existing handleEvent works unchanged).
 *
 * Framing is done by hand: pi's docs explicitly forbid readline-based splitting because
 * U+2028/U+2029 are legal inside JSON strings and readline would break such lines apart.
 */

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

/**
 * Incremental LF splitter. Feed raw Buffers; calls `onLine` with each complete line
 * (CR stripped, so CRLF input works too). Empty lines are skipped.
 */
function createLineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return function feed(chunk) {
    buf += decoder.write(chunk);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  };
}

const REQUEST_TIMEOUT_MS = 15000;
const GRACEFUL_STOP_MS = 2000;

class RpcSession {
  /**
   * @param {object} opts
   * @param {string} opts.bin        pi executable
   * @param {string[]} opts.args     argv after the bin (must include --mode rpc)
   * @param {string} opts.cwd
   * @param {object} opts.env
   * @param {(record: object) => void} opts.onEvent   session/extension-UI records
   * @param {(tail: string) => void} [opts.onStderr]  called with the rolling stderr tail
   * @param {(info: object) => void} [opts.onExit]    {code, signal, expected}
   */
  constructor(opts) {
    this.opts = opts;
    this.proc = null;
    this.dead = true;          // true = not running / needs (re)start
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, timer }
    this._feed = null;
    this.stderrTail = '';
  }

  get alive() {
    return !!(this.proc && this.proc.exitCode === null && !this.dead);
  }

  /** Spawn pi and start pumping records. Rejects only on synchronous spawn failure. */
  start() {
    if (this.alive) return;
    if (this.proc) this.kill();
    this._rejectAll(new Error('pi rpc session restarted'));
    this.stderrTail = '';
    this.dead = false;

    const o = this.opts;
    let child;
    try {
      child = spawn(o.bin, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.dead = true;
      throw e;
    }
    this.proc = child;
    this._nextId = 1;

    this._feed = createLineSplitter((line) => this._handleLine(line));
    child.stdout.on('data', (buf) => { if (this._feed) this._feed(buf); });
    child.stdout.on('error', () => {});

    child.stderr.on('data', (buf) => {
      this.stderrTail = (this.stderrTail + buf.toString()).slice(-4000);
      if (o.onStderr) o.onStderr(this.stderrTail);
    });
    child.stderr.on('error', () => {});

    child.on('error', (err) => {
      // Spawn failures (ENOENT etc.) — surface via onExit so the caller can show it.
      this.dead = true;
      this._rejectAll(err);
      if (o.onExit) o.onExit({ code: null, signal: null, error: err, expected: false });
    });

    child.on('close', (code, signal) => {
      const expected = this.dead; // dead was set by stop()/kill paths
      this.dead = true;
      this._feed = null;
      this._rejectAll(new Error('pi rpc process exited (code=' + code + ' signal=' + signal + ')'));
      if (o.onExit) o.onExit({ code, signal, expected });
    });
  }

  _handleLine(line) {
    let rec;
    try { rec = JSON.parse(line); } catch (e) { return; } // stray non-JSON line: ignore
    if (!rec || typeof rec !== 'object') return;
    if (rec.type === 'response') {
      const p = rec.id ? this._pending.get(rec.id) : null;
      if (p) {
        this._pending.delete(rec.id);
        if (p.timer) clearTimeout(p.timer);
        if (rec.success) p.resolve(rec.data == null ? {} : rec.data);
        else p.reject(new Error(rec.error || ('command failed: ' + (rec.command || '?'))));
      }
      // Unmatched responses (e.g. parse errors) are protocol noise — drop them.
      return;
    }
    if (this.opts.onEvent) this.opts.onEvent(rec);
  }

  /**
   * Send one command and resolve with its response `data`.
   * Rejects on failure response, timeout, or process exit.
   */
  request(cmd, timeoutMs) {
    if (!this.alive) return Promise.reject(new Error('pi rpc 进程未运行'));
    const id = 'pion-' + this._nextId++;
    const msg = Object.assign({ id }, cmd);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('pi rpc 命令超时: ' + cmd.type));
      }, timeoutMs || REQUEST_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Graceful shutdown: close stdin (pi treats that as a shutdown request), then SIGKILL. */
  stop() {
    const child = this.proc;
    if (!child || this.dead) return;
    this.dead = true;
    try { child.stdin.end(); } catch (e) { /* already gone */ }
    setTimeout(() => this.kill(), GRACEFUL_STOP_MS);
  }

  /** Hard kill, ignoring any graceful path. Safe to call repeatedly. */
  kill() {
    const child = this.proc;
    if (!child) return;
    this.dead = true;
    try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }

  _rejectAll(err) {
    for (const [id, p] of this._pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }
}

module.exports = { createLineSplitter, RpcSession };
