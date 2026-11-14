// V2I protocol shared by the ambulance OBU and the roadside RSU (ESP32-S3 + nRF24L01+ PA+LNA).
// Byte-for-byte the same frame as src/lib/rf24PacketCodec.ts.
//
// Arduino only compiles files inside a sketch's own folder, so an identical copy of this file sits
// in ambulance_tx_esp32s3/ and roadside_rx_esp32s3/. Edit this one, then copy it to both
// (scripts/sync-firmware-headers.mjs does that, and the tests fail if the copies differ).
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>

// ---- radio (both boards must match)
#define V2I_RF_CHANNEL 76            // 2476 MHz
#define V2I_PACKET_LEN 32
#define V2I_MAGIC 0xA5
static const uint8_t V2I_RF_ADDR[6] = {'V', '2', 'I', '0', '1', 0};

// ---- wiring, both boards (ESP32-S3-DevKitC-1). GPIO 38-42 keep clear of the LEDs on 4-21, of
//      USB (19/20), of the strapping pins (0/3/45/46) and of octal PSRAM (35-37).
#define PIN_NRF_CE   38
#define PIN_NRF_CSN  39
#define PIN_NRF_SCK  40
#define PIN_NRF_MOSI 41
#define PIN_NRF_MISO 42

enum V2ITurn : uint8_t { TURN_NONE = 0, TURN_STRAIGHT = 1, TURN_LEFT = 2, TURN_RIGHT = 3, TURN_UTURN = 4 };

#pragma pack(push, 1)
typedef struct {
    uint8_t  magic_sync;         //  0  0xA5
    uint8_t  ambulance_id;       //  1  101 = AMB-101
    int32_t  current_lat_e7;     //  2  degrees x 1e7
    int32_t  current_lon_e7;     //  6
    uint16_t heading_decideg;    // 10  0..3599
    uint16_t speed_decikmh;      // 12  km/h x 10
    int32_t  next_wp_lat_e7;     // 14  next junction ON the route (0,0 = none)
    int32_t  next_wp_lon_e7;     // 18
    int32_t  dest_lat_e7;        // 22  hospital
    int32_t  dest_lon_e7;        // 26
    uint8_t  turn_and_severity;  // 30  bits 0-3 turn, bits 4-7 severity (0 = siren off)
    uint8_t  crc8;               // 31  CRC-8 poly 0x07 over bytes 0..30
} V2IPacket_t;
#pragma pack(pop)

static_assert(sizeof(V2IPacket_t) == V2I_PACKET_LEN, "V2IPacket_t must be exactly 32 bytes");

static inline uint8_t v2i_crc8(const uint8_t *d, size_t n) {
    uint8_t crc = 0;
    for (size_t i = 0; i < n; i++) {
        crc ^= d[i];
        for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
    }
    return crc;
}

static inline void v2i_seal(V2IPacket_t *p) {
    p->magic_sync = V2I_MAGIC;
    p->crc8 = v2i_crc8((const uint8_t *)p, V2I_PACKET_LEN - 1);
}

static inline bool v2i_valid(const V2IPacket_t *p) {
    return p->magic_sync == V2I_MAGIC && p->crc8 == v2i_crc8((const uint8_t *)p, V2I_PACKET_LEN - 1);
}

static inline uint8_t v2i_turn(const V2IPacket_t *p) { return p->turn_and_severity & 0x0F; }

#define V2I_MAX_SPEED_DECIKMH 2000   // 200 km/h: anything faster is treated as a corrupt frame

// magic + CRC + every field inside its range (the same checks as decodePacket() in TypeScript)
static inline bool v2i_plausible(const V2IPacket_t *p) {
    if (!v2i_valid(p)) return false;
    if ((p->turn_and_severity & 0x0F) > TURN_UTURN) return false;
    if (p->heading_decideg > 3599 || p->speed_decikmh > V2I_MAX_SPEED_DECIKMH) return false;
    if (p->current_lat_e7 > 900000000 || p->current_lat_e7 < -900000000) return false;
    if (p->current_lon_e7 > 1800000000 || p->current_lon_e7 < -1800000000) return false;
    return true;
}
static inline uint8_t v2i_severity(const V2IPacket_t *p) { return p->turn_and_severity >> 4; }
static inline int32_t v2i_e7(double deg) { return (int32_t)lround(deg * 1e7); }

static inline const char *v2i_turn_name(uint8_t t) {
    switch (t) {
        case TURN_STRAIGHT: return "STRAIGHT";
        case TURN_LEFT: return "LEFT";
        case TURN_RIGHT: return "RIGHT";
        case TURN_UTURN: return "U_TURN";
        default: return "NONE";
    }
}

// ---- geodesy (same formulas as src/lib/geo.ts)
#define V2I_PI 3.14159265358979323846
#define V2I_EARTH_R 6371008.8

static inline double v2i_haversine_m(double lat1, double lon1, double lat2, double lon2) {
    double d2r = V2I_PI / 180.0;
    double dlat = (lat2 - lat1) * d2r, dlon = (lon2 - lon1) * d2r;
    double s = sin(dlat / 2) * sin(dlat / 2) + cos(lat1 * d2r) * cos(lat2 * d2r) * sin(dlon / 2) * sin(dlon / 2);
    return 2 * V2I_EARTH_R * atan2(sqrt(s), sqrt(1 - s < 0 ? 0 : 1 - s));
}

static inline double v2i_bearing_deg(double lat1, double lon1, double lat2, double lon2) {
    double d2r = V2I_PI / 180.0;
    double p1 = lat1 * d2r, p2 = lat2 * d2r, dl = (lon2 - lon1) * d2r;
    double y = sin(dl) * cos(p2), x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl);
    double b = atan2(y, x) * 180.0 / V2I_PI;
    return b < 0 ? b + 360.0 : b;
}

static inline double v2i_wrap180(double d) {
    d = fmod(d + 180.0, 360.0);
    if (d < 0) d += 360.0;
    d -= 180.0;
    return d == -180.0 ? 180.0 : d;
}

static inline void v2i_to_hex(const uint8_t *b, size_t n, char *out) {
    static const char *H = "0123456789ABCDEF";
    for (size_t i = 0; i < n; i++) { out[2 * i] = H[b[i] >> 4]; out[2 * i + 1] = H[b[i] & 15]; }
    out[2 * n] = 0;
}

static inline bool v2i_from_hex(const char *s, uint8_t *out, size_t n) {
    for (size_t i = 0; i < n; i++) {
        int v = 0;
        for (int k = 0; k < 2; k++) {
            char c = s[2 * i + k];
            int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
            if (d < 0) return false;
            v = v * 16 + d;
        }
        out[i] = (uint8_t)v;
    }
    return s[2 * n] == 0 || s[2 * n] == '\r' || s[2 * n] == '\n' || s[2 * n] == ',';
}
