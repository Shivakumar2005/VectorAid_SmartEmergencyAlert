# V2I ambulance signal pre-emption: ESP32-S3 + nRF24L01+ PA+LNA, Next.js on Vercel, MCP tools

An ambulance unit (OBU) broadcasts a 32-byte packet 10 times a second on nRF24 channel 76 at
250 kbps. A roadside unit (RSU) at a junction pre-empts its lights **only if the packet names that
junction as the ambulance's next junction** and the ambulance is within 200 m. The web app runs
the same rules on a map (mode 1) and shows the boards' state next to the simulation (mode 2).

## What was checked, and what was not

Checked in the build environment:

- `npm run verify` passed: type check, ESLint with no warnings, 33 tests, production build, and a secret scan of the browser bundle.
- The S1–S7 scenarios passed, both in the browser and through the MCP server.
- The roadside unit's C++ logic passed a host test on a laptop:
  - one green at a time;
  - yellow and all-red between greens;
  - off-route ambulances are ignored;
  - three ambulances are served nearest-first;
  - the light is released after the 120 s maximum hold.
- The C++ and TypeScript packet encoders produce identical bytes.
- Both sketches compile for ESP32-S3 with arduino-esp32 core **2.0.9** and RF24, with no warnings.
- API routes, exercised against `next start`:
  - HMAC signing: tampered, replayed and drifting requests are rejected.
  - SSE stream.
  - Rate limiting (HTTP 429).
  - CSP nonce: every script tag carries it, and the browser logged no CSP violations.

Not checked here (no access from the build machine):

- Your hardware: radio range, LED wiring, GPS fix.
- arduino-esp32 **3.x**.
- Live OpenRouteService and Overpass calls; their fallbacks were tested.
- Deployment to Vercel.

## Folder layout

```
src/app/                    page, layout, API routes (route, roads, telemetry, stream, config, tiles)
src/middleware.ts           per-request CSP nonce + rate limits
src/components/             TopTelemetryRibbon, InteractiveV2IMap, PhysicalTrafficSignalHead,
                            LiveHardwareWebsiteView, WebSerialHardwareBridge, ControlPanel, SidePanel
src/lib/                    geo, roadGraph (OSM + demo grid), v2iPreemptionEngine, rf24PacketCodec,
                            scenarios (S1–S7), webSerial, server/ (env, hmac, schemas, store, rateLimit)
firmware/include/v2i_protocol.h            the packet, CRC-8, geodesy (canonical copy)
firmware/ambulance_tx_esp32s3/             OBU sketch (+ copy of v2i_protocol.h)
firmware/roadside_rx_esp32s3/              RSU sketch + v2i_rsu_logic.h (+ copy of v2i_protocol.h)
mcp-server/v2i-mcp-server.ts               MCP server "v2i-traffic-controller"
tests/                      vitest suites + firmware_host_test.cpp
```

## 1. Run it on your laptop (Windows PowerShell)

1. Install Node.js 20 or newer.
2. In the project folder:
   ```powershell
   npm install
   Copy-Item .env.example .env.local
   npm run dev
   ```
3. Open http://localhost:3000 in **Chrome or Edge**. Web Serial only works there.
4. Optional: open `.env.local` in an editor and put your OpenRouteService key after `ORS_API_KEY=`.
   - Never paste the key into code or chat.
   - Never give it a `NEXT_PUBLIC_` name.
   - Without a key, routing uses the OpenStreetMap road graph.

### Real roads (OpenStreetMap)

1. Click **OpenStreetMap** in the left panel.
2. Click **Set the start**, then click your start street. If no roads are loaded there yet, the app loads the streets around that point by itself (5–60 s), then places the pin. Messages appear at the top of the map.
3. Or load an area yourself: pan, zoom in until the view is about 4 km across or less, and click **Load the roads in view**.
   - The roads come from public Overpass servers. If the main server (overpass-api.de) is busy, the app tries maps.mail.ru and then overpass.private.coffee by itself.
   - If all three fail, it says so. Zoom in further, or wait a minute and try again.
4. Set the hospital on a street (within about 4 km of the start), then **Dispatch**. A roadside unit is placed at every junction on the route.
5. The **Route with OpenRouteService** box is greyed out until you do both of these:
   - Put your key in `.env.local`.
   - Restart `npm run dev`. The server reads `.env.local` only when it starts.

Without the key, routing uses the loaded OpenStreetMap roads, which are the same streets.

## 2. Deploy to Vercel

1. Log in and link the project:
   ```powershell
   npx vercel login
   npx vercel link
   ```
2. Add the server-only secrets. Each command prompts for the value, so the value never lands in a file or in your shell history:
   ```powershell
   npx vercel env add ORS_API_KEY production
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # make a telemetry secret
   npx vercel env add V2I_HMAC_SECRET production
   ```
3. Optional: add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. Without them, telemetry and rate limits are kept per server instance only. On Vercel that means a board's report may not reach the browser's stream.
4. Deploy:
   ```powershell
   npx vercel --prod
   ```
5. Check the security headers:
   ```powershell
   curl.exe -sI https://<your-app>.vercel.app/
   ```
   The response should include `content-security-policy`, `strict-transport-security`, `x-frame-options: DENY` and `permissions-policy`.

Notes:

- `vercel.json` pins functions to `bom1` (Mumbai).
- The live stream reconnects about every 55 s. This keeps it within the time limit of every Vercel plan.
- Cost per Upstash use:

  | Action | Redis commands |
  |---|---|
  | Each board report | about 5 |
  | Each open live view | 1 every 2 s |

  Check these against your Upstash plan.

## 3. Wiring (ESP32-S3-DevKitC-1)

### nRF24L01+ PA+LNA (both boards)

| nRF24 pin | ESP32-S3 | Notes |
|---|---|---|
| VCC | 3V3 | Put a 10–100 µF capacitor right at the module. The PA+LNA module draws current peaks; an nRF24 socket adapter with its own 3.3 V regulator is more reliable. |
| GND | GND | |
| CE | GPIO 38 | On v1.1 DevKitC boards the on-board RGB LED is also on GPIO 38. It may flicker; that is harmless. |
| CSN | GPIO 39 | |
| SCK | GPIO 40 | |
| MOSI | GPIO 41 | |
| MISO | GPIO 42 | |
| IRQ | not connected | |

### NEO-M8N (ambulance board only)

| NEO-M8N pin | ESP32-S3 |
|---|---|
| TX | GPIO 18 |
| RX | GPIO 17 |
| VCC | 5V |
| GND | GND |

Check that your GPS board has its own regulator before connecting it to 5V. The link runs at 9600 baud.

### Signal LEDs (roadside board)

Each GPIO drives one LED through a 220–330 Ω resistor to GND.

| Arm | Red | Yellow | Green |
|---|---|---|---|
| 0 | 4 | 5 | 6 |
| 1 | 7 | 15 | 16 |
| 2 | 17 | 18 | 8 |
| 3 | 9 | 10 | 11 |
| 4 | 12 | 13 | 14 |

Arm numbers follow the order the web app lists them (shown under each signal head in the hardware twin). Send `TEST` over serial to light every LED once, in order.

## 4. Flash the boards (Arduino IDE 2)

1. Boards Manager: install **esp32 by Espressif**. Library Manager: install **RF24 by TMRh20**.
2. Tools → Board: **ESP32S3 Dev Module**. Plug in the board's **UART** USB port and leave "USB CDC On Boot" **Disabled**.
3. Open `firmware/roadside_rx_esp32s3/roadside_rx_esp32s3.ino` and upload it to the roadside board.
4. Open `firmware/ambulance_tx_esp32s3/ambulance_tx_esp32s3.ino` and upload it to the ambulance board (only needed for two-board mode).
5. If you edit `firmware/include/v2i_protocol.h`, run `npm run sync:firmware` to copy it into both sketches. A test fails if the copies differ.

A roadside board that has not been configured flashes yellow. Its configuration comes from the web app and is saved in flash.

## 5. Use the boards with the web app

1. In the web app, open **Hardware twin**.
2. Choose which junction the roadside board acts as. **Connect** it and pick its serial port. The page sends `CFG,...`, and the board now runs that junction's lights itself.
3. Choose how the board gets the ambulance:
   - **One board:** the page sends every simulated ambulance's packet to the roadside board over USB (`PKT,<hex>`). No radio is used.
   - **Two boards:** also **Connect** the ambulance board and choose which ambulance it follows. The page feeds it position (`SIM,...`) and the route's junctions. It transmits by nRF24 and the roadside board receives it.
4. Dispatch an ambulance or run a scenario on the map. The twin shows:
   - the board's lamps next to the simulation's;
   - the 32 transmitted bytes, with any differing bytes underlined.

The board runs its own clock, so in the normal cycle its phase can differ from the simulation. During a pre-emption both serve the same arm.

### Optional: Wi-Fi uplink from the roadside board

1. Open the Arduino Serial Monitor at 115200 baud with "Newline" line endings. Type these commands one at a time, never into a web page:
   ```
   WIFI,<ssid>,<password>
   SECRET,<the same V2I_HMAC_SECRET as on Vercel>
   URL,https://<your-app>.vercel.app/api/v2i/telemetry
   UPLINK,1,5
   ```
   `UPLINK,1,5` posts every 5 s. `UPLINK,0` stops posting.
2. The board signs each report: HMAC-SHA256 of `timestamp.sequence.body`, using NTP time. The sequence keeps increasing across reboots.
3. In the hardware twin, turn on **Units reporting over Wi-Fi > Live** to see the reports.

## 6. MCP tools for Claude

`.mcp.json` defines three servers:

| Server | What it is |
|---|---|
| `v2i-traffic-controller` | This project's local server, run with `npx tsx mcp-server/v2i-mcp-server.ts` |
| `vercel` | https://mcp.vercel.com (OAuth, authorize with `/mcp`) |
| `github` | https://api.githubcopilot.com/mcp, using a token from the `GITHUB_PERSONAL_ACCESS_TOKEN` environment variable |

Tools in `v2i-traffic-controller`:

- `v2i_dispatch_ambulance`
- `v2i_drop_traffic_light_pin`
- `v2i_inspect_junction_signals`
- `v2i_encode_decode_rf24_packet`
- `v2i_run_scenario_verification` (0 runs S1–S7)
- `v2i_reset_simulation`

They run on the demo grid, offline, with no keys.

To set it up:

```powershell
$env:GITHUB_PERSONAL_ACCESS_TOKEN = "<your token>"   # set it in your shell, never in .mcp.json
claude                                               # in the project folder; approve the project servers
```

On native Windows, if `npx` fails to start the local server, change its entry to `"command": "cmd", "args": ["/c", "npx", "tsx", "mcp-server/v2i-mcp-server.ts"]`.

## 7. Tests

```powershell
npm run verify          # typecheck + lint + tests + production build + secret scan
npm run test:firmware   # RSU C++ logic on the laptop (needs g++; MinGW on Windows)
```

## Security model, and its limits

Enforced:

- **Secrets:**
  - Secrets are read only in `src/lib/server/env.ts`, which is marked `server-only`.
  - `scripts/scan-secrets.mjs` fails the build check if a secret value, a secret variable's name, or an OpenRouteService-shaped key appears in `.next/static` or in the source.
- **Telemetry:**
  - Signed with HMAC-SHA256 and checked in constant time.
  - Clock drift of more than 10 s is rejected.
  - Each device's sequence number must increase, which blocks replays.
  - The body is validated with zod and limited to 8 KB.
  - Telemetry is refused when the secret is shorter than 32 characters.
- **Routing proxy:**
  - Requests from other sites are refused.
  - The OpenRouteService key stays on the server.
  - OpenRouteService error bodies are never forwarded.
- **Headers:**
  - Per-request CSP nonce with `strict-dynamic`.
  - HSTS (2 years, preload), nosniff, `X-Frame-Options: DENY`.
  - `Permissions-Policy: serial=(self), geolocation=(self)`.
- **Rate limits:** per IP on every `/api` route.

Limits you should know:

- **One shared telemetry secret:** all roadside boards use it, so one compromised board can impersonate the others. Per-device keys would be the next step.
- **Board certificate check:** the board does not verify the server's certificate unless you paste a root CA into `ROOT_CA_PEM`. Without it, nobody can forge or replay reports, but someone on the network path could read them.
- **Rate limiter fails open:** if Upstash is unreachable, requests are let through rather than taking the site down.
- **`style-src 'unsafe-inline'`:** kept because Leaflet and React set inline styles. Scripts stay strict.
- **Map tiles:** they load straight from tile.openstreetmap.org, which is what the OSM tile policy expects. The `/api/tiles` proxy is off unless you set `TILE_PROXY_CONTACT`, because that policy discourages proxies and requires a contactable User-Agent.
- **Not a certified controller:** this is a demonstrator, not a certified traffic controller. Real cabinets enforce conflict monitoring in independent hardware.

## Things that are deliberately different from the original prompt

- **Byte 31 is a CRC-8 only.** One byte cannot also carry a sequence number.
- **Bengaluru road graph:** the hand-typed "verified" graph from the earlier HTML is not used. Real roads come from OpenStreetMap at runtime ("Load the roads in view"). Offline, the app uses a labelled synthetic demo grid.
- **Green timing:** pre-emption honours a 5 s minimum green, then 3 s yellow and 2 s all-red. Green therefore comes about 10 s after detection, which is about 110 m at 40 km/h. An ambulance first detected closer than that waits briefly. The host test shows it: at 75 m and 36 km/h the ambulance waits 4 s.
