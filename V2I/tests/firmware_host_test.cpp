// Runs the roadside unit's real logic (firmware/roadside_rx_esp32s3/v2i_rsu_logic.h) on a laptop.
//   g++ -std=c++17 -O2 -Wall -Wextra -o rsu_test tests/firmware_host_test.cpp && ./rsu_test
// (npm run test:firmware does exactly that.)
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>
#include "../firmware/roadside_rx_esp32s3/v2i_rsu_logic.h"

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; std::printf("  FAIL %s:%d  ", __FILE__, __LINE__); std::printf(__VA_ARGS__); std::printf("\n"); } } while (0)

// The same packet as tests/core.test.ts; both languages must give this exact hex.
static const char *GOLDEN_HEX = "A5650211BC071C18412E9406320279DCBB073C08422E23A8BA072E89422E32D6";

static const double J_LAT = 12.97, J_LON = 77.59;
static const double M_PER_DEG = 111320.0;

static void offset(double lat0, double lon0, double bearing_deg, double d, double &lat, double &lon) {
    double b = bearing_deg * V2I_PI / 180.0;
    lat = lat0 + d * cos(b) / M_PER_DEG;
    lon = lon0 + d * sin(b) / (M_PER_DEG * cos(lat0 * V2I_PI / 180.0));
}

static V2IPacket_t make_packet(uint8_t id, double lat, double lon, float hdg, float kmh, double wp_lat, double wp_lon, uint8_t turn, uint8_t sev) {
    V2IPacket_t p;
    std::memset(&p, 0, sizeof(p));
    p.ambulance_id = id;
    p.current_lat_e7 = v2i_e7(lat);
    p.current_lon_e7 = v2i_e7(lon);
    p.heading_decideg = (uint16_t)(lroundf(fmodf(hdg + 360.0f, 360.0f) * 10.0f) % 3600);
    p.speed_decikmh = (uint16_t)lroundf(kmh * 10.0f);
    p.next_wp_lat_e7 = v2i_e7(wp_lat);
    p.next_wp_lon_e7 = v2i_e7(wp_lon);
    p.turn_and_severity = (uint8_t)((turn & 0x0F) | (sev << 4));
    v2i_seal(&p);
    return p;
}

// An ambulance driving straight through the junction: it comes in from `from_bearing`, so it
// travels towards (from_bearing + 180). Like the TX firmware, it names the junction as next_wp
// until it is 15 m past it, then names a junction 500 m further on. It stops at the stop line
// (12 m) when its arm is not green, like a real driver would.
struct SimAmb {
    uint8_t id; double from_bearing; double s; float kmh, v_now = 0; uint8_t sev; bool passed = false; bool wp_is_us = true;
    double stopped_s = 0;   // s < 0 before the junction, > 0 after it
    void pos(double &lat, double &lon) const {
        if (s <= 0) offset(J_LAT, J_LON, from_bearing, -s, lat, lon);
        else offset(J_LAT, J_LON, from_bearing + 180.0, s, lat, lon);
    }
    V2IPacket_t packet() const {
        double lat, lon, wl, wn;
        pos(lat, lon);
        if (wp_is_us) { wl = J_LAT; wn = J_LON; } else offset(J_LAT, J_LON, from_bearing + 180.0, 500, wl, wn);
        return make_packet(id, lat, lon, (float)fmod(from_bearing + 180.0, 360.0), v_now, wl, wn, TURN_STRAIGHT, sev);
    }
    void step(double dt, char approach_lamp) {
        double v = kmh / 3.6;
        // about to cross (or waiting at) the stop line while the arm is not green: stop there
        if (!passed && s <= -12.0 + 1e-9 && s + v * dt > -12.0 && approach_lamp != 'G') { s = -12.0; v_now = 0; stopped_s += dt; return; }
        s += v * dt; v_now = kmh;
        if (s > 15.0) { passed = true; wp_is_us = false; }
    }
};

struct Run {
    rsu::Brain b;
    uint32_t now = 1000;
    std::string prev;
    std::vector<std::string> history;   // distinct lamp states in order
    int multi_green = 0, bad_transition = 0;
    int last_green = -1;
    bool yellow_since_green = true, allred_since_yellow = true;
    void init(int n, const float *bearings) { b.configure("J01", J_LAT, J_LON, (uint8_t)n, bearings); }
    std::string lamps() const { std::string s; for (int a = 0; a < b.cfg.n_arms; a++) s += b.lamp((uint8_t)a); return s; }
    void tick(uint32_t dt_ms) {
        now += dt_ms;
        b.tick(now);
        std::string l = lamps();
        int greens = 0, g = -1, y = -1;
        for (int a = 0; a < (int)l.size(); a++) { if (l[a] == 'G') { greens++; g = a; } if (l[a] == 'Y') y = a; }
        if (greens > 1) multi_green++;
        if (y >= 0) yellow_since_green = true;
        if (y < 0 && g < 0 && yellow_since_green) allred_since_yellow = true;
        if (g >= 0 && g != last_green) {
            if (last_green >= 0 && !(yellow_since_green && allred_since_yellow)) bad_transition++;
            last_green = g; yellow_since_green = false; allred_since_yellow = false;
        }
        if (l != prev) { history.push_back(l); prev = l; }
    }
    void send(const V2IPacket_t &p) { b.on_packet((const uint8_t *)&p, now); }
};

static const float FOUR[4] = {0, 90, 180, 270};

static void test_codec() {
    std::printf("codec\n");
    CHECK(v2i_crc8((const uint8_t *)"123456789", 9) == 0xF4, "CRC-8 check value");
    V2IPacket_t p = make_packet(101, 12.9765634, 77.6017948, 168.4f, 56.2f, 12.9752185, 77.607942, TURN_LEFT, 3);
    p.dest_lat_e7 = v2i_e7(12.9673251);
    p.dest_lon_e7 = v2i_e7(77.611243);
    v2i_seal(&p);
    char hex[65];
    v2i_to_hex((const uint8_t *)&p, 32, hex);
    CHECK(std::strcmp(hex, GOLDEN_HEX) == 0, "hex %s != golden %s", hex, GOLDEN_HEX);
    uint8_t back[32];
    CHECK(v2i_from_hex(GOLDEN_HEX, back, 32) && std::memcmp(back, &p, 32) == 0, "from_hex round trip");
    CHECK(v2i_plausible(&p), "golden packet plausible");
    V2IPacket_t bad = p; ((uint8_t *)&bad)[5] ^= 0x10;
    CHECK(!v2i_plausible(&bad), "corrupted frame rejected");
    V2IPacket_t fast = p; fast.speed_decikmh = 2500; v2i_seal(&fast);
    CHECK(!v2i_plausible(&fast), "250 km/h rejected");
    CHECK(v2i_turn(&p) == TURN_LEFT && v2i_severity(&p) == 3, "turn/severity nibbles");
}

static void test_normal_cycle() {
    std::printf("normal cycle\n");
    Run r; r.init(4, FOUR);
    for (int i = 0; i < 4 * 170 + 5; i++) r.tick(100);
    CHECK(r.history.size() >= 6, "history");
    const char *exp[6] = {"GRRR", "YRRR", "RRRR", "RGRR", "RYRR", "RRRR"};
    for (int i = 0; i < 6 && i < (int)r.history.size(); i++) CHECK(r.history[i] == exp[i], "step %d: %s != %s", i, r.history[i].c_str(), exp[i]);
    CHECK(r.multi_green == 0 && r.bad_transition == 0, "invariants");
    CHECK(r.b.preemptions == 0, "no pre-emption without an ambulance");
}

static void test_single_ambulance() {
    std::printf("single ambulance from the south\n");
    Run r; r.init(4, FOUR);
    SimAmb a{101, 180.0, -400.0, 40.0f, 0, 2};
    bool green_before_200 = false; bool preempt_seen = false; char lamp_at_stopline = '?';
    for (int i = 0; i < 1200; i++) {
        char lamp = r.b.lamp(2);
        a.step(0.1, lamp);
        r.send(a.packet());
        r.tick(100);
        if (r.b.ctl.mode == rsu::M_PREEMPT) { preempt_seen = true; if (a.s < -rsu::DETECT_M - 12) green_before_200 = true; }
        if (lamp_at_stopline == '?' && a.s >= -12.5 && a.s < 0) lamp_at_stopline = r.b.lamp(2);
    }
    CHECK(preempt_seen, "pre-empted");
    CHECK(!green_before_200, "nothing happens before 200 m");
    CHECK(a.stopped_s == 0, "ambulance never stopped (waited %.1f s)", a.stopped_s);
    CHECK(lamp_at_stopline == 'G', "south arm green at the stop line (%c)", lamp_at_stopline);
    CHECK(a.passed, "passed");
    CHECK(r.b.ctl.mode == rsu::M_NORMAL, "back to normal after it passed");
    CHECK(r.multi_green == 0 && r.bad_transition == 0, "invariants");
    CHECK(r.b.preemptions == 1, "one pre-emption (%u)", r.b.preemptions);
}

static void test_off_route_and_siren_off() {
    std::printf("off-route ambulance and siren off\n");
    Run r; r.init(4, FOUR);
    // drives past 30 m east of the junction, but its next junction is elsewhere
    for (int i = 0; i < 600; i++) {
        double lat, lon, wl, wn, la2, lo2;
        offset(J_LAT, J_LON, 90, 30, lat, lon);
        offset(lat, lon, 180, 300 - i * 1.0, la2, lo2);
        offset(J_LAT, J_LON, 90, 600, wl, wn);
        r.send(make_packet(102, la2, lo2, 0, 36, wl, wn, TURN_STRAIGHT, 3));
        // and one heading for this junction with the siren off
        double l3, o3; offset(J_LAT, J_LON, 270, 150 - i * 0.2, l3, o3);
        r.send(make_packet(103, l3, o3, 90, 20, J_LAT, J_LON, TURN_STRAIGHT, 0));
        r.tick(100);
        CHECK(r.b.ctl.mode == rsu::M_NORMAL, "stays NORMAL at step %d", i);
        if (r.b.ctl.mode != rsu::M_NORMAL) break;
    }
    CHECK(r.b.preemptions == 0, "no pre-emption");
    CHECK(r.b.filtered >= 1, "off-route ambulance counted as filtered (%u)", r.b.filtered);
}

static void test_three_ambulances() {
    std::printf("three ambulances at 180 / 120 / 75 m\n");
    Run r; r.init(4, FOUR);
    SimAmb amb[3] = {{101, 0.0, -180.0, 36.0f, 0, 2}, {102, 270.0, -120.0, 36.0f, 0, 2}, {103, 90.0, -75.0, 36.0f, 0, 2}};
    const int arm_of[3] = {0, 3, 1};
    std::vector<int> order;
    for (int i = 0; i < 1500; i++) {
        for (int k = 0; k < 3; k++) { amb[k].step(0.1, r.b.lamp((uint8_t)arm_of[k])); r.send(amb[k].packet()); }
        r.tick(100);
        if (r.b.served && (order.empty() || order.back() != r.b.served)) order.push_back(r.b.served);
    }
    std::printf("  served order:");
    for (int id : order) std::printf(" AMB-%d", id);
    std::printf("   waits: %.1f / %.1f / %.1f s\n", amb[2].stopped_s, amb[1].stopped_s, amb[0].stopped_s);
    CHECK(order.size() == 3 && order[0] == 103 && order[1] == 102 && order[2] == 101, "closest first: 103, 102, 101");
    for (auto &a : amb) CHECK(a.passed, "AMB-%u passed", a.id);
    CHECK(r.multi_green == 0 && r.bad_transition == 0, "invariants (multi %d, transition %d)", r.multi_green, r.bad_transition);
    CHECK(r.b.ctl.mode == rsu::M_NORMAL, "back to normal");
}

static void test_max_hold() {
    std::printf("max hold and lockout\n");
    Run r; r.init(3, FOUR);   // T-junction: arms 0, 90, 180
    double lat, lon;
    offset(J_LAT, J_LON, 90, 50, lat, lon);
    bool released = false; int released_at = -1;
    for (int i = 0; i < 1600; i++) {
        r.send(make_packet(104, lat, lon, 270, 0, J_LAT, J_LON, TURN_LEFT, 1));   // parked 50 m away, siren on
        r.tick(100);
        if (i > 200 && !released && r.b.lamp(1) != 'G') { released = true; released_at = i; }
    }
    CHECK(released, "green released after max hold");
    CHECK(released_at >= 1150 && released_at <= 1300, "released after ~120 s (step %d)", released_at);
    CHECK(r.multi_green == 0 && r.bad_transition == 0, "invariants");
}

static void test_unconfigured() {
    std::printf("unconfigured unit\n");
    rsu::Brain b;
    CHECK(!b.cfg.valid && b.lamp(0) == 'Y', "flashes yellow until configured");
    V2IPacket_t p = make_packet(101, J_LAT, J_LON, 0, 30, J_LAT, J_LON, TURN_STRAIGHT, 2);
    CHECK(b.on_packet((const uint8_t *)&p, 10), "packet accepted");
    b.tick(20); b.tick(40);
    CHECK(b.preemptions == 0, "no pre-emption without a configuration");
}

int main() {
    test_codec();
    test_normal_cycle();
    test_single_ambulance();
    test_off_route_and_siren_off();
    test_three_ambulances();
    test_max_hold();
    test_unconfigured();
    if (failures) { std::printf("\n%d check(s) FAILED\n", failures); return 1; }
    std::printf("\nall firmware host checks passed\n");
    return 0;
}
