// The 32-byte V2IPacket_t radio frame (nRF24L01+, one payload), little-endian, byte-for-byte the
// same as firmware/include/v2i_protocol.h.
//
//  off  size  field
//   0    1    magic_sync          0xA5
//   1    1    ambulance_id        101 = AMB-101
//   2    4    current_lat_e7      int32, degrees x 1e7
//   6    4    current_lon_e7      int32
//  10    2    heading_decideg     uint16, 0..3599
//  12    2    speed_decikmh       uint16, km/h x 10
//  14    4    next_wp_lat_e7      int32, next junction ON the ambulance's route (0,0 = none)
//  18    4    next_wp_lon_e7      int32
//  22    4    dest_lat_e7         int32, hospital
//  26    4    dest_lon_e7         int32
//  30    1    turn_and_severity   bits 0-3 turn at next_wp (0 none, 1 straight, 2 left, 3 right, 4 U-turn)
//                                 bits 4-7 severity (0 = siren off / not on an emergency run, 1..3)
//  31    1    crc8                CRC-8 (poly 0x07, init 0x00) over bytes 0..30
//
// Byte 31 is a CRC-8 only: one byte cannot also hold a sequence number. The nRF24 adds its own
// 16-bit CRC on air; this CRC-8 also catches corruption on the UART/USB paths.

import type { Turn } from "./geo";

export const PACKET_LEN = 32;
export const MAGIC = 0xa5;
/** Faster than this is treated as a corrupt frame (firmware: V2I_MAX_SPEED_DECIKMH). */
export const MAX_SPEED_KMH = 200;

export interface V2IPacket {
  ambulanceId: number;
  lat: number;
  lng: number;
  headingDeg: number;
  speedKmh: number;
  nextWpLat: number;
  nextWpLng: number;
  destLat: number;
  destLng: number;
  turn: Turn | "NONE";
  severity: number; // 0..3 (0 = not an emergency run)
}

const TURN_CODE: Record<Turn | "NONE", number> = { NONE: 0, STRAIGHT: 1, LEFT: 2, RIGHT: 3, U_TURN: 4 };
const CODE_TURN: (Turn | "NONE")[] = ["NONE", "STRAIGHT", "LEFT", "RIGHT", "U_TURN"];

export function crc8(bytes: Uint8Array, len = bytes.length): number {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

const e7 = (deg: number) => Math.round(deg * 1e7);
const clampU16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));

export function encodePacket(p: V2IPacket): Uint8Array {
  const buf = new Uint8Array(PACKET_LEN);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, MAGIC);
  dv.setUint8(1, Math.max(0, Math.min(255, Math.round(p.ambulanceId))));
  dv.setInt32(2, e7(p.lat), true);
  dv.setInt32(6, e7(p.lng), true);
  dv.setUint16(10, clampU16(((((p.headingDeg % 360) + 360) % 360) * 10) % 3600), true);
  dv.setUint16(12, clampU16(p.speedKmh * 10), true);
  dv.setInt32(14, e7(p.nextWpLat), true);
  dv.setInt32(18, e7(p.nextWpLng), true);
  dv.setInt32(22, e7(p.destLat), true);
  dv.setInt32(26, e7(p.destLng), true);
  const sev = Math.max(0, Math.min(15, Math.round(p.severity)));
  dv.setUint8(30, (TURN_CODE[p.turn] & 0x0f) | (sev << 4));
  dv.setUint8(31, crc8(buf, 31));
  return buf;
}

export interface DecodeResult {
  ok: boolean;
  errors: string[];
  packet: V2IPacket | null;
  crcExpected: number;
  crcReceived: number;
}

export function decodePacket(buf: Uint8Array): DecodeResult {
  const errors: string[] = [];
  if (buf.length !== PACKET_LEN) {
    return { ok: false, errors: [`length ${buf.length}, expected ${PACKET_LEN}`], packet: null, crcExpected: -1, crcReceived: -1 };
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint8(0) !== MAGIC) errors.push(`magic 0x${dv.getUint8(0).toString(16).padStart(2, "0")}, expected 0xa5`);
  const crcExpected = crc8(buf, 31);
  const crcReceived = dv.getUint8(31);
  if (crcExpected !== crcReceived) errors.push(`CRC-8 0x${crcReceived.toString(16).padStart(2, "0")}, expected 0x${crcExpected.toString(16).padStart(2, "0")}`);
  const ts = dv.getUint8(30);
  const turnCode = ts & 0x0f;
  if (turnCode > 4) errors.push(`turn code ${turnCode} unknown`);
  const heading = dv.getUint16(10, true);
  if (heading > 3599) errors.push(`heading ${heading} decideg out of range`);
  const packet: V2IPacket = {
    ambulanceId: dv.getUint8(1),
    lat: dv.getInt32(2, true) / 1e7,
    lng: dv.getInt32(6, true) / 1e7,
    headingDeg: heading / 10,
    speedKmh: dv.getUint16(12, true) / 10,
    nextWpLat: dv.getInt32(14, true) / 1e7,
    nextWpLng: dv.getInt32(18, true) / 1e7,
    destLat: dv.getInt32(22, true) / 1e7,
    destLng: dv.getInt32(26, true) / 1e7,
    turn: CODE_TURN[turnCode] ?? "NONE",
    severity: ts >> 4,
  };
  if (Math.abs(packet.lat) > 90 || Math.abs(packet.lng) > 180) errors.push("position out of range");
  if (packet.speedKmh > MAX_SPEED_KMH) errors.push(`speed ${packet.speedKmh} km/h above ${MAX_SPEED_KMH} km/h`);
  return { ok: errors.length === 0, errors, packet, crcExpected, crcReceived };
}

export function toHex(buf: Uint8Array, sep = " "): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2) throw new Error("hex string has an odd number of digits");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Field map for the hex inspector: [offset, length, name]. */
export const FIELD_MAP: [number, number, string][] = [
  [0, 1, "magic_sync"], [1, 1, "ambulance_id"], [2, 4, "current_lat_e7"], [6, 4, "current_lon_e7"],
  [10, 2, "heading_decideg"], [12, 2, "speed_decikmh"], [14, 4, "next_wp_lat_e7"], [18, 4, "next_wp_lon_e7"],
  [22, 4, "dest_lat_e7"], [26, 4, "dest_lon_e7"], [30, 1, "turn_and_severity"], [31, 1, "crc8"],
];
