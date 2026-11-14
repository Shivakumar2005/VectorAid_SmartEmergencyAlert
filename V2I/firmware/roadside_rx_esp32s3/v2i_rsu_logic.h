// Roadside unit (RSU) brain: the traffic-light rules of src/lib/v2iPreemptionEngine.ts in C++.
// No Arduino calls, so tests/firmware_host_test.cpp runs this exact file on a laptop.
//
//  - split phasing: each arm gets its own green in turn (green 12 s, yellow 3 s, all-red 2 s);
//    only one arm is ever green
//  - an ambulance is served only if its packet names THIS junction as its next junction on its
//    route (next_wp within 35 m of us) and it is within 200 m: route-aware, no false triggers
//  - its approach arm = the arm pointing towards it; that arm is served next: the green arm goes
//    yellow (after its 5 s minimum green) -> all-red -> ambulance arm green, held until the
//    ambulance's packets stop naming us (it is 15 m past) -> cycle resumes with the next arm
//  - several ambulances: earliest arrival first (ETA minus 4 s per severity level above 1); the one
//    being served keeps the junction until it has passed; max hold 120 s, then 30 s lockout
#pragma once
#include "v2i_protocol.h"

namespace rsu {

static const float GREEN_S = 12.0f, YELLOW_S = 3.0f, ALL_RED_S = 2.0f, MIN_GREEN_S = 5.0f;
static const float MAX_HOLD_S = 120.0f, LOCKOUT_S = 30.0f;
static const float DETECT_M = 200.0f;     // react within this distance
static const float WP_MATCH_M = 35.0f;    // packet's next_wp this close to us = we are its next junction
static const float LOCK_ARM_M = 30.0f;    // stop re-estimating the approach arm closer than this
static const uint32_t FRESH_MS = 1500;    // a track older than this is gone
static const float SEVERITY_BONUS_S = 4.0f;
static const int MAX_ARMS = 5;
static const int MAX_TRACKS = 6;
// GPIOs per arm: arm k uses R = POOL[3k], Y = POOL[3k+1], G = POOL[3k+2] (same as the web app)
static const uint8_t GPIO_POOL[16] = {4, 5, 6, 7, 15, 16, 17, 18, 8, 9, 10, 11, 12, 13, 14, 21};

enum Phase : uint8_t { PH_GREEN, PH_YELLOW, PH_ALL_RED };
enum Mode : uint8_t { M_NORMAL, M_PREEMPT, M_RECOVER };

static inline const char *phase_name(Phase p) { return p == PH_GREEN ? "GREEN" : p == PH_YELLOW ? "YELLOW" : "ALL_RED"; }
static inline const char *mode_name(Mode m) { return m == M_PREEMPT ? "PREEMPT" : m == M_RECOVER ? "RECOVER" : "NORMAL"; }

struct Controller {
    uint8_t n = 4, green = 0;
    Phase phase = PH_GREEN;
    float t = 0, hold = 0;
    Mode mode = M_NORMAL;
    int8_t preempt_arm = -1;

    void init(uint8_t arms, float offset_s) {
        n = arms < 2 ? 2 : arms;
        phase = PH_GREEN; green = 0; t = 0; hold = 0; mode = M_NORMAL; preempt_arm = -1;
        float cycle = n * (GREEN_S + YELLOW_S + ALL_RED_S);
        float x = fmodf(offset_s, cycle);
        for (uint8_t a = 0; a < n; a++) {
            const float d[3] = {GREEN_S, YELLOW_S, ALL_RED_S};
            for (int k = 0; k < 3; k++) {
                if (x < d[k]) { phase = (Phase)k; green = a; t = x; return; }
                x -= d[k];
            }
        }
    }
    char lamp(uint8_t arm) const {
        if (arm != green) return 'R';
        return phase == PH_GREEN ? 'G' : phase == PH_YELLOW ? 'Y' : 'R';
    }
    float remaining() const {
        if (phase == PH_GREEN) return (mode == M_PREEMPT && preempt_arm == green) ? -1.0f : (GREEN_S - t > 0 ? GREEN_S - t : 0);
        float d = phase == PH_YELLOW ? YELLOW_S : ALL_RED_S;
        return d - t > 0 ? d - t : 0;
    }
    void go(Phase p, uint8_t arm) { phase = p; green = arm; t = 0; }
    void step(float dt, int8_t req) {
        t += dt;
        if (req >= 0) {
            if (mode != M_PREEMPT) hold = 0;
            mode = M_PREEMPT; preempt_arm = req; hold += dt;
        } else if (mode == M_PREEMPT) {
            mode = M_RECOVER;
        }
        switch (phase) {
            case PH_GREEN:
                if (req >= 0) {
                    if (green != req && t >= MIN_GREEN_S) go(PH_YELLOW, green);
                } else if (mode == M_RECOVER) {
                    if (green == preempt_arm) go(PH_YELLOW, green);
                    else { mode = M_NORMAL; preempt_arm = -1; }
                } else if (t >= GREEN_S) go(PH_YELLOW, green);
                break;
            case PH_YELLOW:
                if (t >= YELLOW_S) go(PH_ALL_RED, green);
                break;
            case PH_ALL_RED:
                if (t >= ALL_RED_S) {
                    uint8_t next = req >= 0 ? (uint8_t)req : (uint8_t)((green + 1) % n);
                    go(PH_GREEN, next);
                    if (mode == M_RECOVER) { mode = M_NORMAL; preempt_arm = -1; }
                }
                break;
        }
    }
};

struct Config {
    char id[8] = "J01";
    double lat = 0, lon = 0;
    uint8_t n_arms = 0;
    float arm_bearing[MAX_ARMS] = {0};
    bool valid = false;
};

struct Track {
    bool used = false;
    uint8_t id = 0;
    uint32_t last_ms = 0;
    double lat = 0, lon = 0;
    float speed_kmh = 0, heading = 0, dist = 0;
    uint8_t turn = 0, sev = 0;
    bool for_us = false, counted_off_route = false;
    int8_t approach = -1;
    uint32_t lockout_until = 0;
    float score = 0;
};

class Brain {
public:
    Config cfg;
    Controller ctl;
    Track tr[MAX_TRACKS];
    uint8_t served = 0;            // ambulance id holding the junction (0 = none)
    uint32_t rx_ok = 0, rx_bad = 0, filtered = 0, preemptions = 0;
    uint32_t last_tick = 0;
    bool ticked = false;

    void configure(const char *id, double lat, double lon, uint8_t n, const float *bearings) {
        cfg = Config();
        strncpy(cfg.id, id, sizeof(cfg.id) - 1);
        cfg.lat = lat; cfg.lon = lon;
        cfg.n_arms = n > MAX_ARMS ? MAX_ARMS : n;
        for (int i = 0; i < cfg.n_arms; i++) cfg.arm_bearing[i] = bearings[i];
        cfg.valid = cfg.n_arms >= 2 && (lat != 0 || lon != 0);
        ctl.init(cfg.n_arms, 0);
        served = 0;
        for (auto &t : tr) t = Track();
    }

    char lamp(uint8_t arm) const { return cfg.valid ? ctl.lamp(arm) : 'Y'; }

    int8_t arm_towards(double lat, double lon) const {
        double b = v2i_bearing_deg(cfg.lat, cfg.lon, lat, lon);
        int8_t best = 0;
        for (int i = 1; i < cfg.n_arms; i++)
            if (fabs(v2i_wrap180(cfg.arm_bearing[i] - b)) < fabs(v2i_wrap180(cfg.arm_bearing[best] - b))) best = (int8_t)i;
        return best;
    }

    /** A 32-byte frame from the radio (or injected over USB). Returns false if invalid. */
    bool on_packet(const uint8_t *buf, uint32_t now) {
        V2IPacket_t p;
        memcpy(&p, buf, sizeof(p));
        if (!v2i_plausible(&p)) { rx_bad++; return false; }
        rx_ok++;
        Track *t = nullptr;
        for (auto &x : tr) if (x.used && x.id == p.ambulance_id) t = &x;
        if (!t) for (auto &x : tr) if (!x.used || now - x.last_ms > FRESH_MS * 4) { t = &x; *t = Track(); t->used = true; t->id = p.ambulance_id; break; }
        if (!t) return true;                        // table full: ignore extra vehicles
        t->last_ms = now;
        t->lat = p.current_lat_e7 * 1e-7;
        t->lon = p.current_lon_e7 * 1e-7;
        t->speed_kmh = p.speed_decikmh / 10.0f;
        t->heading = p.heading_decideg / 10.0f;
        t->turn = v2i_turn(&p);
        t->sev = v2i_severity(&p);
        if (!cfg.valid) return true;
        t->dist = (float)v2i_haversine_m(t->lat, t->lon, cfg.lat, cfg.lon);
        bool has_wp = p.next_wp_lat_e7 != 0 || p.next_wp_lon_e7 != 0;
        t->for_us = has_wp && v2i_haversine_m(p.next_wp_lat_e7 * 1e-7, p.next_wp_lon_e7 * 1e-7, cfg.lat, cfg.lon) <= WP_MATCH_M;
        if (t->for_us && (t->approach < 0 || t->dist > LOCK_ARM_M)) t->approach = arm_towards(t->lat, t->lon);
        if (!t->for_us) t->approach = -1;
        return true;
    }

    void tick(uint32_t now) {
        float dt = ticked ? (now - last_tick) / 1000.0f : 0.0f;
        ticked = true;
        last_tick = now;
        if (!cfg.valid) return;
        if (dt > 1.0f) dt = 1.0f;
        Track *chosen = nullptr, *best = nullptr;
        for (auto &t : tr) {
            if (!t.used) continue;
            bool fresh = now - t.last_ms <= FRESH_MS;
            if (!fresh) { if (t.id == served) served = 0; continue; }
            bool near = t.dist <= DETECT_M;
            if (t.sev > 0 && near && !t.for_us) {
                if (!t.counted_off_route) { t.counted_off_route = true; filtered++; }
                continue;
            }
            if (!near) t.counted_off_route = false;
            bool candidate = t.sev > 0 && t.for_us && near && t.approach >= 0 && (int32_t)(now - t.lockout_until) >= 0;
            if (!candidate) { if (t.id == served) served = 0; continue; }
            float v = t.speed_kmh / 3.6f;
            t.score = t.dist / (v > 3.0f ? v : 3.0f) - SEVERITY_BONUS_S * (t.sev - 1);
            if (t.id == served) chosen = &t;
            if (!best || t.score < best->score) best = &t;
        }
        if (!chosen && best) { chosen = best; served = best->id; preemptions++; }
        int8_t req = chosen ? chosen->approach : -1;
        if (chosen && ctl.mode == M_PREEMPT && ctl.hold > MAX_HOLD_S) {
            chosen->lockout_until = now + (uint32_t)(LOCKOUT_S * 1000);
            served = 0;
            req = -1;
        }
        ctl.step(dt, req);
    }

    const Track *served_track() const {
        for (auto &t : tr) if (t.used && t.id == served) return &t;
        return nullptr;
    }
};

}  // namespace rsu
