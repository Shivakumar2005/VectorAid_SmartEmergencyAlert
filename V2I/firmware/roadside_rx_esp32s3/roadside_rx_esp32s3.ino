// =============================================================================================
// Roadside unit (RSU, receiver + traffic-light controller) - ESP32-S3-DevKitC-1 + nRF24L01+ PA+LNA
// Arduino IDE: board "ESP32S3 Dev Module", library "RF24" by TMRh20 (Library Manager).
//
// Runs the junction's traffic lights (split phasing: green 12 s -> yellow 3 s -> all-red 2 s per
// arm) and pre-empts them for an ambulance whose radio packet names THIS junction as its next one
// (all logic in v2i_rsu_logic.h, identical to the web simulation and tested on a laptop).
//
// LEDs: arm k uses R = GPIO_POOL[3k], Y = GPIO_POOL[3k+1], G = GPIO_POOL[3k+2], through a
// 220-330 ohm resistor to GND each (active high). Arm 0 = 4/5/6, arm 1 = 7/15/16,
// arm 2 = 17/18/8, arm 3 = 9/10/11, arm 4 = 12/13/14.
//
// USB serial, 115200 baud, one line per command (the web app sends CFG and PKT through Web Serial):
//   CFG,J01,lat,lon,n,b0,b1,..   junction id, position and the compass bearing of each arm (saved)
//   CLR                          forget the configuration (lights flash yellow)
//   PKT,<64 hex chars>           a 32-byte frame injected over USB (one-board demo, no radio needed)
//   PA,LOW|MAX                   radio power
//   TEST                         light every LED once, in order (wiring check, ~5 s)
//   STATUS / PING                print the configuration
// Optional cloud uplink (HTTPS POST to /api/v2i/telemetry, HMAC-SHA256 signed). Type these in the
// Arduino Serial Monitor - never through a web page - they are stored in the board's flash:
//   WIFI,<ssid>,<password>       SECRET,<V2I_HMAC_SECRET>       URL,https://<app>.vercel.app/api/v2i/telemetry
//   UPLINK,1[,period_s] / UPLINK,0
// Out: {"t":"rsu",...} 10 times a second.
// =============================================================================================
#include <SPI.h>
#include <RF24.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <time.h>
#include "mbedtls/md.h"
#include "v2i_protocol.h"
#include "v2i_rsu_logic.h"

// Paste a root CA (PEM) here to make the board verify the server's certificate. With nullptr the
// board still signs every message (nobody can forge or replay telemetry), but it cannot tell
// whether it is talking to the real server, so someone on the network path could read it.
static const char *ROOT_CA_PEM = nullptr;

static const uint32_t STATUS_PERIOD_MS = 100;

RF24 radio(PIN_NRF_CE, PIN_NRF_CSN);
SPIClass radioSpi(FSPI);
bool radio_ok = false;
uint8_t pa_level = RF24_PA_MAX;

rsu::Brain brain;
Preferences prefs;

struct Uplink {
    bool enabled = false;
    uint16_t period_s = 2;
    char ssid[33] = "", pass[65] = "", url[160] = "", secret[129] = "";
} up;
uint32_t boot_count = 0;
uint64_t up_counter = 0;
volatile int up_last_code = 0;
volatile uint32_t up_ok = 0, up_fail = 0;
SemaphoreHandle_t body_mutex;
char up_body[1400];
bool up_body_fresh = false;

char line[200];
int line_n = 0;

// ---------------------------------------------------------------- lamps
void lamps_write() {
    static uint32_t blink_ms = 0;
    bool configured = brain.cfg.valid;
    int n = configured ? brain.cfg.n_arms : 4;
    bool blink_on = ((millis() - blink_ms) / 500) % 2 == 0;
    for (int a = 0; a < rsu::MAX_ARMS; a++) {
        char l = a < n ? (configured ? brain.lamp((uint8_t)a) : (blink_on ? 'Y' : '-')) : '-';
        digitalWrite(rsu::GPIO_POOL[3 * a + 0], l == 'R');
        digitalWrite(rsu::GPIO_POOL[3 * a + 1], l == 'Y');
        digitalWrite(rsu::GPIO_POOL[3 * a + 2], l == 'G');
    }
}

void lamp_test() {
    for (int i = 0; i < 3 * rsu::MAX_ARMS; i++) digitalWrite(rsu::GPIO_POOL[i], LOW);
    for (int i = 0; i < 3 * rsu::MAX_ARMS; i++) {
        digitalWrite(rsu::GPIO_POOL[i], HIGH);
        Serial.printf("{\"t\":\"test\",\"arm\":%d,\"lamp\":\"%c\",\"gpio\":%u}\n", i / 3, "RYG"[i % 3], rsu::GPIO_POOL[i]);
        delay(300);
        digitalWrite(rsu::GPIO_POOL[i], LOW);
    }
}

// ---------------------------------------------------------------- configuration in flash
void save_cfg() {
    prefs.begin("v2i", false);
    prefs.putString("id", brain.cfg.id);
    prefs.putDouble("lat", brain.cfg.lat);
    prefs.putDouble("lon", brain.cfg.lon);
    prefs.putUChar("n", brain.cfg.n_arms);
    prefs.putBytes("bear", brain.cfg.arm_bearing, sizeof(brain.cfg.arm_bearing));
    prefs.end();
}

void load_cfg() {
    prefs.begin("v2i", false);
    boot_count = prefs.getUInt("boots", 0) + 1;        // part of the uplink sequence number
    prefs.putUInt("boots", boot_count);
    uint8_t n = prefs.getUChar("n", 0);
    if (n >= 2) {
        float b[rsu::MAX_ARMS] = {0};
        prefs.getBytes("bear", b, sizeof(b));
        String id = prefs.getString("id", "J01");
        brain.configure(id.c_str(), prefs.getDouble("lat", 0), prefs.getDouble("lon", 0), n, b);
    }
    up.enabled = prefs.getBool("up", false);
    up.period_s = prefs.getUShort("upp", 2);
    prefs.getString("ssid", up.ssid, sizeof(up.ssid));
    prefs.getString("pass", up.pass, sizeof(up.pass));
    prefs.getString("url", up.url, sizeof(up.url));
    prefs.getString("sec", up.secret, sizeof(up.secret));
    prefs.end();
}

void save_str(const char *key, const char *v) { prefs.begin("v2i", false); prefs.putString(key, v); prefs.end(); }

void print_status() {
    Serial.printf("{\"t\":\"hello\",\"role\":\"RSU\",\"radio\":%d,\"cfg\":%d,\"id\":\"%s\",\"lat\":%.7f,\"lng\":%.7f,\"n\":%u,\"bearings\":[",
                  radio_ok ? 1 : 0, brain.cfg.valid ? 1 : 0, brain.cfg.id, brain.cfg.lat, brain.cfg.lon, brain.cfg.n_arms);
    for (int i = 0; i < brain.cfg.n_arms; i++) Serial.printf("%s%.1f", i ? "," : "", brain.cfg.arm_bearing[i]);
    // never print the secret or the Wi-Fi password, only whether they are set
    Serial.printf("],\"uplink\":%d,\"period\":%u,\"wifi\":\"%s\",\"wifiUp\":%d,\"url\":\"%s\",\"secret\":%d,\"boots\":%lu}\n",
                  up.enabled ? 1 : 0, up.period_s, up.ssid, WiFi.status() == WL_CONNECTED ? 1 : 0, up.url, up.secret[0] ? 1 : 0,
                  (unsigned long)boot_count);
}

// ---------------------------------------------------------------- USB commands
// rest_after(s, k): pointer to the text after the k-th comma (keeps commas inside passwords)
const char *rest_after(const char *s, int k) {
    while (k > 0 && *s) { if (*s == ',') k--; s++; }
    return k == 0 ? s : nullptr;
}

void handle_line(char *s) {
    if (!strncmp(s, "PKT,", 4)) {
        uint8_t buf[V2I_PACKET_LEN];
        if (v2i_from_hex(s + 4, buf, V2I_PACKET_LEN)) brain.on_packet(buf, millis());
        else brain.rx_bad++;
        return;
    }
    if (!strncmp(s, "WIFI,", 5)) {
        const char *pw = rest_after(s, 2);
        const char *ss = s + 5;
        size_t n = pw ? (size_t)(pw - 1 - ss) : strlen(ss);
        if (n >= sizeof(up.ssid)) n = sizeof(up.ssid) - 1;
        memcpy(up.ssid, ss, n); up.ssid[n] = 0;
        strncpy(up.pass, pw ? pw : "", sizeof(up.pass) - 1); up.pass[sizeof(up.pass) - 1] = 0;
        save_str("ssid", up.ssid); save_str("pass", up.pass);
        WiFi.disconnect();
        Serial.println("{\"t\":\"ack\",\"cmd\":\"WIFI\"}");
        return;
    }
    if (!strncmp(s, "SECRET,", 7)) {
        strncpy(up.secret, s + 7, sizeof(up.secret) - 1); up.secret[sizeof(up.secret) - 1] = 0;
        save_str("sec", up.secret);
        Serial.printf("{\"t\":\"ack\",\"cmd\":\"SECRET\",\"len\":%u}\n", (unsigned)strlen(up.secret));
        return;
    }
    if (!strncmp(s, "URL,", 4)) {
        strncpy(up.url, s + 4, sizeof(up.url) - 1); up.url[sizeof(up.url) - 1] = 0;
        save_str("url", up.url);
        Serial.println("{\"t\":\"ack\",\"cmd\":\"URL\"}");
        return;
    }
    char *f[2 + rsu::MAX_ARMS + 4];
    int n = 0;
    char *save = nullptr;
    for (char *t = strtok_r(s, ",", &save); t && n < (int)(sizeof(f) / sizeof(f[0])); t = strtok_r(nullptr, ",", &save)) f[n++] = t;
    if (!n) return;
    if (!strcmp(f[0], "CFG") && n >= 5) {
        int arms = atoi(f[4]);
        if (arms < 2 || arms > rsu::MAX_ARMS || n < 5 + arms) { Serial.println("{\"t\":\"err\",\"cmd\":\"CFG\",\"why\":\"need 2..5 arms with a bearing each\"}"); return; }
        float b[rsu::MAX_ARMS];
        for (int i = 0; i < arms; i++) b[i] = atof(f[5 + i]);
        brain.configure(f[1], atof(f[2]), atof(f[3]), (uint8_t)arms, b);
        save_cfg();
        print_status();
    } else if (!strcmp(f[0], "CLR")) {
        brain.cfg = rsu::Config();
        prefs.begin("v2i", false); prefs.putUChar("n", 0); prefs.end();
        print_status();
    } else if (!strcmp(f[0], "PA") && n >= 2) {
        pa_level = !strcmp(f[1], "LOW") ? RF24_PA_LOW : RF24_PA_MAX;
        if (radio_ok) radio.setPALevel(pa_level);
    } else if (!strcmp(f[0], "UPLINK") && n >= 2) {
        up.enabled = atoi(f[1]) == 1;
        if (n >= 3) { int p = atoi(f[2]); up.period_s = (uint16_t)(p < 1 ? 1 : p > 3600 ? 3600 : p); }
        prefs.begin("v2i", false); prefs.putBool("up", up.enabled); prefs.putUShort("upp", up.period_s); prefs.end();
        print_status();
    } else if (!strcmp(f[0], "TEST")) {
        lamp_test();
    } else if (!strcmp(f[0], "STATUS") || !strcmp(f[0], "PING")) {
        print_status();
    }
}

// ---------------------------------------------------------------- status JSON (USB, 10 Hz) and cloud body
int amb_json(char *o, size_t cap, bool cloud) {
    int k = 0;
    bool first = true;
    uint32_t now = millis();
    for (auto &t : brain.tr) {
        if (!t.used || now - t.last_ms > rsu::FRESH_MS) continue;
        k += snprintf(o + k, cap - k,
                      cloud ? "%s{\"ambId\":\"AMB-%u\",\"lat\":%.7f,\"lng\":%.7f,\"speedKmh\":%.1f,\"headingDeg\":%.1f,\"distM\":%.1f,\"forUs\":%s,\"turn\":\"%s\",\"severity\":%u}"
                            : "%s{\"id\":%u,\"lat\":%.7f,\"lng\":%.7f,\"spd\":%.1f,\"hdg\":%.1f,\"d\":%.1f,\"forUs\":%s,\"turn\":\"%s\",\"sev\":%u}",
                      first ? "" : ",", t.id, t.lat, t.lon, t.speed_kmh, t.heading, t.dist, t.for_us ? "true" : "false",
                      v2i_turn_name(t.turn), t.sev);
        first = false;
        if (k >= (int)cap) return (int)cap - 1;
    }
    return k;
}

void lamps_string(char *o) {
    int n = brain.cfg.valid ? brain.cfg.n_arms : 0;
    for (int a = 0; a < n; a++) o[a] = brain.lamp((uint8_t)a);
    o[n] = 0;
}

void print_rsu() {
    char lamps[8], ambs[700];
    lamps_string(lamps);
    amb_json(ambs, sizeof(ambs), false);
    const rsu::Track *s = brain.served_track();
    Serial.printf("{\"t\":\"rsu\",\"id\":\"%s\",\"cfg\":%d,\"mode\":\"%s\",\"phase\":\"%s\",\"green\":%u,\"lamps\":\"%s\",\"rem\":%.1f,"
                  "\"served\":%u,\"arm\":%d,\"d\":%.1f,\"rx\":%lu,\"bad\":%lu,\"flt\":%lu,\"pre\":%lu,\"radio\":%d,\"wifi\":%d,\"upOk\":%lu,\"upFail\":%lu,\"upCode\":%d,\"amb\":[%s]}\n",
                  brain.cfg.id, brain.cfg.valid ? 1 : 0, brain.cfg.valid ? rsu::mode_name(brain.ctl.mode) : "UNCONFIGURED",
                  rsu::phase_name(brain.ctl.phase), brain.ctl.green, lamps, brain.ctl.remaining(), brain.served,
                  s ? s->approach : -1, s ? s->dist : -1.0f, (unsigned long)brain.rx_ok, (unsigned long)brain.rx_bad,
                  (unsigned long)brain.filtered, (unsigned long)brain.preemptions, radio_ok ? 1 : 0,
                  WiFi.status() == WL_CONNECTED ? 1 : 0, (unsigned long)up_ok, (unsigned long)up_fail, up_last_code, ambs);
}

// Body for POST /api/v2i/telemetry: must match TelemetrySchema in src/lib/server/schemas.ts.
void build_cloud_body() {
    char lamps[8], ambs[900];
    lamps_string(lamps);
    amb_json(ambs, sizeof(ambs), true);
    char served[16] = "null";
    if (brain.served) snprintf(served, sizeof(served), "\"AMB-%u\"", brain.served);
    xSemaphoreTake(body_mutex, portMAX_DELAY);
    snprintf(up_body, sizeof(up_body),
             "{\"deviceId\":\"RSU-%s\",\"junctionId\":\"%s\",\"uptimeS\":%lu,\"mode\":\"%s\",\"phase\":\"%s\",\"lamps\":\"%s\","
             "\"servedAmbId\":%s,\"rxOk\":%lu,\"rxBad\":%lu,\"filtered\":%lu,\"preemptions\":%lu,\"ambulances\":[%s]}",
             brain.cfg.id, brain.cfg.id, (unsigned long)(millis() / 1000), brain.cfg.valid ? rsu::mode_name(brain.ctl.mode) : "UNCONFIGURED",
             rsu::phase_name(brain.ctl.phase), lamps, served, (unsigned long)brain.rx_ok, (unsigned long)brain.rx_bad,
             (unsigned long)brain.filtered, (unsigned long)brain.preemptions, ambs);
    up_body_fresh = true;
    xSemaphoreGive(body_mutex);
}

// ---------------------------------------------------------------- cloud uplink task (core 0)
bool hmac_hex(const char *key, const char *msg, size_t len, char *out_hex) {
    uint8_t mac[32];
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (mbedtls_md_hmac(info, (const uint8_t *)key, strlen(key), (const uint8_t *)msg, len, mac) != 0) return false;
    static const char *H = "0123456789abcdef";   // lowercase, as the server expects
    for (int i = 0; i < 32; i++) { out_hex[2 * i] = H[mac[i] >> 4]; out_hex[2 * i + 1] = H[mac[i] & 15]; }
    out_hex[64] = 0;
    return true;
}

void uplink_task(void *) {
    static char body[1400], msg[1500];
    bool time_started = false;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(up.period_s * 1000UL));
        if (!up.enabled || !up.ssid[0] || !up.url[0] || !up.secret[0]) continue;
        if (WiFi.status() != WL_CONNECTED) {
            WiFi.mode(WIFI_STA);
            WiFi.begin(up.ssid, up.pass);
            for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) vTaskDelay(pdMS_TO_TICKS(250));
            if (WiFi.status() != WL_CONNECTED) { up_fail++; up_last_code = -1; continue; }
        }
        if (!time_started) { configTime(0, 0, "pool.ntp.org", "time.google.com"); time_started = true; }
        time_t now = time(nullptr);
        if (now < 1700000000) { up_last_code = -2; continue; }          // clock not set yet: the server would reject it
        xSemaphoreTake(body_mutex, portMAX_DELAY);
        bool fresh = up_body_fresh;
        strncpy(body, up_body, sizeof(body) - 1);
        body[sizeof(body) - 1] = 0;
        up_body_fresh = false;
        xSemaphoreGive(body_mutex);
        if (!fresh) continue;
        // strictly increasing across reboots: boot count in the high digits
        unsigned long long seq = (unsigned long long)boot_count * 1000000000ULL + (++up_counter);
        int ml = snprintf(msg, sizeof(msg), "%ld.%llu.%s", (long)now, seq, body);
        char sig[65];
        if (ml <= 0 || ml >= (int)sizeof(msg) || !hmac_hex(up.secret, msg, (size_t)ml, sig)) { up_fail++; continue; }
        char ts[16], sq[24];
        snprintf(ts, sizeof(ts), "%ld", (long)now);
        snprintf(sq, sizeof(sq), "%llu", seq);
        WiFiClientSecure client;
        if (ROOT_CA_PEM) client.setCACert(ROOT_CA_PEM); else client.setInsecure();
        HTTPClient http;
        http.setTimeout(5000);
        if (!http.begin(client, up.url)) { up_fail++; up_last_code = -3; continue; }
        http.addHeader("Content-Type", "application/json");
        http.addHeader("X-V2I-Timestamp", ts);
        http.addHeader("X-V2I-Sequence", sq);
        http.addHeader("X-V2I-Signature", sig);
        int code = http.POST((uint8_t *)body, strlen(body));
        http.end();
        up_last_code = code;
        if (code >= 200 && code < 300) up_ok++; else up_fail++;
    }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
    Serial.setRxBufferSize(4096);
    Serial.begin(115200);
    for (int i = 0; i < 3 * rsu::MAX_ARMS; i++) { pinMode(rsu::GPIO_POOL[i], OUTPUT); digitalWrite(rsu::GPIO_POOL[i], LOW); }
    load_cfg();
    radioSpi.begin(PIN_NRF_SCK, PIN_NRF_MISO, PIN_NRF_MOSI, PIN_NRF_CSN);
    radio_ok = radio.begin(&radioSpi) && radio.isChipConnected();
    if (radio_ok) {
        radio.setChannel(V2I_RF_CHANNEL);
        if (!radio.setDataRate(RF24_250KBPS)) radio.setDataRate(RF24_1MBPS);   // must match the ambulance
        radio.setPALevel(pa_level);
        radio.setAutoAck(false);
        radio.setCRCLength(RF24_CRC_16);
        radio.setPayloadSize(V2I_PACKET_LEN);
        radio.openReadingPipe(1, V2I_RF_ADDR);
        radio.startListening();
    }
    body_mutex = xSemaphoreCreateMutex();
    xTaskCreatePinnedToCore(uplink_task, "uplink", 12288, nullptr, 1, nullptr, 0);
    print_status();
}

void loop() {
    if (radio_ok) {
        uint8_t buf[V2I_PACKET_LEN];
        while (radio.available()) { radio.read(buf, V2I_PACKET_LEN); brain.on_packet(buf, millis()); }
    }
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') { if (line_n) { line[line_n] = 0; handle_line(line); line_n = 0; } }
        else if (line_n < (int)sizeof(line) - 1) line[line_n++] = c;
    }
    static uint32_t t_tick = 0, t_status = 0, t_body = 0;
    uint32_t now = millis();
    if (now - t_tick >= 20) { t_tick = now; brain.tick(now); lamps_write(); }
    if (now - t_status >= STATUS_PERIOD_MS) { t_status = now; print_rsu(); }
    if (now - t_body >= 1000) { t_body = now; build_cloud_body(); }
}
