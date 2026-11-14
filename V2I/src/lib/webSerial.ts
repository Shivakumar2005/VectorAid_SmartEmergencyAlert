// A USB serial port that talks in lines (Web Serial API, Chrome / Edge on desktop).
// The boards print one JSON object per line and read one command per line, both at 115200 baud.

export const serialSupported = () => typeof navigator !== "undefined" && "serial" in navigator && !!navigator.serial;

export class LinePort {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private queue: string[] = [];
  private writing = false;
  private closed = false;
  dropped = 0;
  linesIn = 0;
  linesOut = 0;

  private constructor(private port: SerialPort, private onLine: (line: string) => void, private onClose: (why: string) => void) {}

  /** Opens the browser's port picker (must be called from a click). */
  static async request(onLine: (line: string) => void, onClose: (why: string) => void): Promise<LinePort> {
    if (!serialSupported()) throw new Error("Web Serial is not available: use Chrome or Edge on a desktop, over HTTPS or localhost");
    const port = await navigator.serial!.requestPort();
    await port.open({ baudRate: 115200, bufferSize: 16384 });
    const lp = new LinePort(port, onLine, onClose);
    lp.writer = port.writable!.getWriter();
    void lp.readLoop();
    return lp;
  }

  private async readLoop() {
    const dec = new TextDecoder();
    let buf = "";
    try {
      this.reader = this.port.readable!.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (line) {
            this.linesIn++;
            this.onLine(line);
          }
        }
        if (buf.length > 8192) buf = ""; // garbage without newlines (wrong baud rate?)
      }
    } catch (e) {
      if (!this.closed) this.onClose(e instanceof Error ? e.message : "read failed");
    } finally {
      this.reader?.releaseLock();
    }
    if (!this.closed) {
      this.closed = true;
      this.onClose("the board was unplugged or reset");
    }
  }

  /** Queues one line; drops the oldest if the board cannot keep up. */
  send(line: string) {
    if (this.closed) return;
    this.queue.push(line + "\n");
    if (this.queue.length > 64) {
      this.queue.shift();
      this.dropped++;
    }
    void this.flush();
  }

  private async flush() {
    if (this.writing || !this.writer) return;
    this.writing = true;
    const enc = new TextEncoder();
    try {
      while (this.queue.length && !this.closed) {
        const chunk = this.queue.splice(0, this.queue.length).join("");
        await this.writer.write(enc.encode(chunk));
        this.linesOut += chunk.split("\n").length - 1;
      }
    } catch (e) {
      if (!this.closed) {
        this.closed = true;
        this.onClose(e instanceof Error ? e.message : "write failed");
      }
    } finally {
      this.writing = false;
    }
  }

  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

// ------------------------------------------------------------------ messages from the boards
export interface TxStatus { t: "tx"; seq?: number; src: string; fix: number; sats: number; lat?: number; lng?: number; spd?: number; hdg?: number; next?: number; nj?: number; dist?: number; turn?: string; sev?: number; radio: number; ok?: number; fail?: number; hex?: string }
export interface RsuStatus { t: "rsu"; id: string; cfg: number; mode: string; phase: string; green: number; lamps: string; rem: number; served: number; arm: number; d: number; rx: number; bad: number; flt: number; pre: number; radio: number; wifi: number; upOk: number; upFail: number; upCode: number; amb: { id: number; d: number; forUs: boolean; turn: string; sev: number; spd: number }[] }
export interface Hello { t: "hello"; role: "TX" | "RSU"; radio: number; [k: string]: unknown }

export function parseBoardLine(line: string): TxStatus | RsuStatus | Hello | { t: string } | null {
  if (!line.startsWith("{")) return null;
  try {
    const o = JSON.parse(line) as { t?: unknown };
    return typeof o.t === "string" ? (o as { t: string }) : null;
  } catch {
    return null;
  }
}
