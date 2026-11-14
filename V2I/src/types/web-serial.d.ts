// Minimal Web Serial API types (Chrome / Edge). https://wicg.github.io/serial/
interface SerialPortInfo { usbVendorId?: number; usbProductId?: number }
interface SerialPort extends EventTarget {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: "none" | "even" | "odd"; bufferSize?: number; flowControl?: "none" | "hardware" }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}
interface Serial extends EventTarget {
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}
interface Navigator { readonly serial?: Serial }
