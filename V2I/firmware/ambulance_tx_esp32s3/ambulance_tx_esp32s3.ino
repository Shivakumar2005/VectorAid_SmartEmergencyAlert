// =============================================================================================
// Ambulance OBU (transmitter) - ESP32-S3-DevKitC-1 + u-blox NEO-M8N + nRF24L01+ PA+LNA
// Arduino IDE: board "ESP32S3 Dev Module", library "RF24" by TMRh20 (Library Manager).
//
// Broadcasts the 32-byte V2IPacket_t 10 times a second on channel 76 at 250 kbps:
// position, heading, speed, the NEXT junction on its route (+ the turn there), the hospital,
// and the severity (0 = siren off). Roadside units react only if they are that next junction.
//
// Position comes from the NEO-M8N, or - for a desk demo - from the web app over USB ("SIM"
// lines from the map simulation). AUTO uses SIM while SIM lines arrive, otherwise GPS.
//
// USB serial, 115200 baud, one line per command (the web app sends these through Web Serial):
//   ID,101                 ambulance number (AMB-101)
//   SEV,2                  severity 1..3; 0 = siren off (no pre-emption)
//   DEST,lat,lon           hospital
//   JCLR                   clear the route's junction list, then
//   J,i,lat,lon,turn       junction i on the route, in order; turn 0 none 1 straight 2 left 3 right 4 U
//   JEND                   list complete
//   SIM,lat,lon,kmh,hdg    simulated position (desk demo)
//   MODE,AUTO|GPS|SIM      position source
//   PA,LOW|MAX             radio power (LOW on one desk, MAX outdoors)
//   PING                   -> {"t":"hello",...}
// Out: one JSON line per packet: {"t":"tx",...,"hex":"A5..."}
// =============================================================================================
#include <SPI.h>
#include <RF24.h>
#include "v2i_protocol.h"

// ---- NEO-M8N on UART1 (GPS TX -> ESP32 RX pin)
static const int PIN_GPS_RX = 18;
static const int PIN_GPS_TX = 17;
static const uint32_t GPS_BAUD = 9600;

static const uint32_t TX_PERIOD_MS = 100;      // 10 Hz
static const uint32_t SIM_TIMEOUT_MS = 2000;   // AUTO falls back to GPS after this
static const float REACHED_M = 20.0f;          // inside the junction
static const float PASSED_M = 15.0f;           // left it again -> next junction
static const int MAX_JUNCTIONS = 32;

RF24 radio(PIN_NRF_CE, PIN_NRF_CSN);
SPIClass radioSpi(FSPI);
bool radio_ok = false;
uint8_t pa_level = RF24_PA_MAX;

struct Wp { double lat, lon; uint8_t turn; };
Wp route[MAX_JUNCTIONS];
int n_route = 0, next_idx = 0;
bool reached = false;
double dest_lat = 0, dest_lon = 0;
uint8_t amb_id = 101, severity = 2;

enum Src { SRC_AUTO, SRC_GPS, SRC_SIM } src_mode = SRC_AUTO;
struct Fix { bool valid; double lat, lon; float kmh, hdg; uint32_t ms; uint8_t sats; } gps = {false, 0, 0, 0, 0, 0, 0}, sim = {false, 0, 0, 0, 0, 0, 0};

uint32_t seq = 0, tx_fail = 0;
char line[160];
int line_n = 0;
char nmea[100];
int nmea_n = 0;

// ---------------------------------------------------------------- NMEA (RMC + GGA), empty fields kept
int nmea_fields(char *s, char **f, int max) {
    int n = 0;
    f[n++] = s;
    for (char *p = s; *p && n < max; p++) if (*p == ',') { *p = 0; f[n++] = p + 1; }
    return n;
}

double nmea_deg(const char *v, const char *hemi) {
    if (!*v) return NAN;
    double x = atof(v);
    int d = (int)(x / 100);
    double deg = d + (x - d * 100) / 60.0;
    return (*hemi == 'S' || *hemi == 'W') ? -deg : deg;
}

bool nmea_checksum_ok(const char *s) {
    const char *star = strchr(s, '*');
    if (!star || s[0] != '$') return false;
    uint8_t c = 0;
    for (const char *p = s + 1; p < star; p++) c ^= (uint8_t)*p;
    return (uint8_t)strtol(star + 1, nullptr, 16) == c;
}

void handle_nmea(char *s) {
    if (!nmea_checksum_ok(s)) return;
    *strchr(s, '*') = 0;
    char *f[20];
    int n = nmea_fields(s, f, 20);
    if (n >= 9 && !strcmp(f[0] + 3, "RMC")) {
        if (f[2][0] != 'A') { gps.valid = false; return; }
        double lat = nmea_deg(f[3], f[4]), lon = nmea_deg(f[5], f[6]);
        if (isnan(lat) || isnan(lon)) return;
        gps.lat = lat; gps.lon = lon;
        gps.kmh = atof(f[7]) * 1.852f;
        if (gps.kmh > 3.0f && f[8][0]) gps.hdg = atof(f[8]);   // course is noise when slow: keep the last one
        gps.valid = true;
        gps.ms = millis();
    } else if (n >= 8 && !strcmp(f[0] + 3, "GGA")) {
        gps.sats = (uint8_t)atoi(f[7]);
    }
}

// ---------------------------------------------------------------- USB commands
int split(char *s, char **f, int max) {
    int n = 0;
    char *save = nullptr;
    for (char *t = strtok_r(s, ",", &save); t && n < max; t = strtok_r(nullptr, ",", &save)) f[n++] = t;
    return n;
}

void say_hello() {
    Serial.printf("{\"t\":\"hello\",\"role\":\"TX\",\"radio\":%d,\"id\":%u,\"junctions\":%d}\n", radio_ok ? 1 : 0, amb_id, n_route);
}

void handle_line(char *s) {
    char *f[8];
    int n = split(s, f, 8);
    if (!n) return;
    if (!strcmp(f[0], "SIM") && n >= 5) {
        sim.lat = atof(f[1]); sim.lon = atof(f[2]); sim.kmh = atof(f[3]); sim.hdg = atof(f[4]);
        sim.valid = true; sim.ms = millis();
    } else if (!strcmp(f[0], "ID") && n >= 2) {
        amb_id = (uint8_t)atoi(f[1]);
    } else if (!strcmp(f[0], "SEV") && n >= 2) {
        int v = atoi(f[1]);
        severity = (uint8_t)(v < 0 ? 0 : v > 3 ? 3 : v);
    } else if (!strcmp(f[0], "DEST") && n >= 3) {
        dest_lat = atof(f[1]); dest_lon = atof(f[2]);
    } else if (!strcmp(f[0], "JCLR")) {
        n_route = 0; next_idx = 0; reached = false;
    } else if (!strcmp(f[0], "J") && n >= 5) {
        int i = atoi(f[1]);
        if (i >= 0 && i < MAX_JUNCTIONS) {
            route[i] = {atof(f[2]), atof(f[3]), (uint8_t)atoi(f[4])};
            if (i + 1 > n_route) n_route = i + 1;
        }
    } else if (!strcmp(f[0], "JEND")) {
        next_idx = 0; reached = false;
        Serial.printf("{\"t\":\"route\",\"junctions\":%d}\n", n_route);
    } else if (!strcmp(f[0], "MODE") && n >= 2) {
        src_mode = !strcmp(f[1], "GPS") ? SRC_GPS : !strcmp(f[1], "SIM") ? SRC_SIM : SRC_AUTO;
    } else if (!strcmp(f[0], "PA") && n >= 2) {
        pa_level = !strcmp(f[1], "LOW") ? RF24_PA_LOW : RF24_PA_MAX;
        if (radio_ok) radio.setPALevel(pa_level);
    } else if (!strcmp(f[0], "PING")) {
        say_hello();
    }
}

// ---------------------------------------------------------------- which junction is next
void update_next(double lat, double lon) {
    if (next_idx >= n_route) return;
    double d = v2i_haversine_m(lat, lon, route[next_idx].lat, route[next_idx].lon);
    if (d < REACHED_M) reached = true;
    if (reached && d > PASSED_M) { next_idx++; reached = false; return; }
    // missed it (GPS gap): clearly closer to the one after
    if (!reached && next_idx + 1 < n_route) {
        double d2 = v2i_haversine_m(lat, lon, route[next_idx + 1].lat, route[next_idx + 1].lon);
        if (d > 100 && d2 < d - 80) { next_idx++; reached = false; }
    }
}

void transmit() {
    uint32_t now = millis();
    bool use_sim = src_mode == SRC_SIM || (src_mode == SRC_AUTO && sim.valid && now - sim.ms < SIM_TIMEOUT_MS);
    Fix &p = use_sim ? sim : gps;
    bool fresh = p.valid && now - p.ms < SIM_TIMEOUT_MS;
    if (!fresh) {
        Serial.printf("{\"t\":\"tx\",\"src\":\"%s\",\"fix\":0,\"sats\":%u,\"radio\":%d}\n", use_sim ? "SIM" : "GPS", gps.sats, radio_ok ? 1 : 0);
        return;                                   // no position: nothing to broadcast
    }
    update_next(p.lat, p.lon);
    V2IPacket_t pkt;
    memset(&pkt, 0, sizeof(pkt));
    pkt.ambulance_id = amb_id;
    pkt.current_lat_e7 = v2i_e7(p.lat);
    pkt.current_lon_e7 = v2i_e7(p.lon);
    float h = fmodf(p.hdg + 360.0f, 360.0f);
    pkt.heading_decideg = (uint16_t)(lroundf(h * 10.0f) % 3600);
    float sp = p.kmh * 10.0f;
    pkt.speed_decikmh = (uint16_t)(sp < 0 ? 0 : sp > V2I_MAX_SPEED_DECIKMH ? V2I_MAX_SPEED_DECIKMH : lroundf(sp));  // RSUs drop > 200 km/h
    uint8_t turn = TURN_NONE;
    float dist = -1;
    if (next_idx < n_route) {
        pkt.next_wp_lat_e7 = v2i_e7(route[next_idx].lat);
        pkt.next_wp_lon_e7 = v2i_e7(route[next_idx].lon);
        turn = route[next_idx].turn;
        dist = (float)v2i_haversine_m(p.lat, p.lon, route[next_idx].lat, route[next_idx].lon);
    }
    pkt.dest_lat_e7 = v2i_e7(dest_lat);
    pkt.dest_lon_e7 = v2i_e7(dest_lon);
    pkt.turn_and_severity = (uint8_t)((turn & 0x0F) | (severity << 4));
    v2i_seal(&pkt);
    bool ok = radio_ok && radio.write(&pkt, V2I_PACKET_LEN);
    if (radio_ok && !ok) tx_fail++;
    seq++;
    char hex[65];
    v2i_to_hex((const uint8_t *)&pkt, V2I_PACKET_LEN, hex);
    Serial.printf("{\"t\":\"tx\",\"seq\":%lu,\"src\":\"%s\",\"fix\":1,\"sats\":%u,\"lat\":%.7f,\"lng\":%.7f,\"spd\":%.1f,\"hdg\":%.1f,"
                  "\"next\":%d,\"nj\":%d,\"dist\":%.0f,\"turn\":\"%s\",\"sev\":%u,\"radio\":%d,\"ok\":%d,\"fail\":%lu,\"hex\":\"%s\"}\n",
                  (unsigned long)seq, use_sim ? "SIM" : "GPS", gps.sats, p.lat, p.lon, p.kmh, h, next_idx, n_route, dist,
                  v2i_turn_name(turn), severity, radio_ok ? 1 : 0, ok ? 1 : 0, (unsigned long)tx_fail, hex);
}

void setup() {
    Serial.setRxBufferSize(4096);
    Serial.begin(115200);
    Serial1.begin(GPS_BAUD, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
    radioSpi.begin(PIN_NRF_SCK, PIN_NRF_MISO, PIN_NRF_MOSI, PIN_NRF_CSN);
    radio_ok = radio.begin(&radioSpi) && radio.isChipConnected();
    if (radio_ok) {
        radio.setChannel(V2I_RF_CHANNEL);
        // 250 kbps = best range. Some PA+LNA clones (Si24R1 chip) do not support it: then
        // setDataRate returns false and we fall back to 1 Mbps (set the RSU the same way).
        if (!radio.setDataRate(RF24_250KBPS)) radio.setDataRate(RF24_1MBPS);
        radio.setPALevel(pa_level);
        radio.setAutoAck(false);                 // broadcast: many RSUs listen, nobody acknowledges
        radio.setCRCLength(RF24_CRC_16);
        radio.setPayloadSize(V2I_PACKET_LEN);
        radio.openWritingPipe(V2I_RF_ADDR);
        radio.stopListening();
    }
    say_hello();
}

void loop() {
    while (Serial1.available()) {
        char c = (char)Serial1.read();
        if (c == '$') nmea_n = 0;
        if (c == '\n' || c == '\r') { if (nmea_n > 6) { nmea[nmea_n] = 0; handle_nmea(nmea); } nmea_n = 0; }
        else if (nmea_n < (int)sizeof(nmea) - 1) nmea[nmea_n++] = c;
    }
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') { if (line_n) { line[line_n] = 0; handle_line(line); line_n = 0; } }
        else if (line_n < (int)sizeof(line) - 1) line[line_n++] = c;
    }
    static uint32_t t_tx = 0, t_hello = 0;
    uint32_t now = millis();
    if (now - t_tx >= TX_PERIOD_MS) { t_tx = now; transmit(); }
    if (now - t_hello >= 5000) { t_hello = now; say_hello(); }
}
