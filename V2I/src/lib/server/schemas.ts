// Input validation for every API route (zod). Anything that does not match is rejected with 400.
import { z } from "zod";

export const AMB_ID = /^AMB-[0-9A-Z]{1,6}$/;

const lat = z.number().finite().min(-90).max(90);
const lng = z.number().finite().min(-180).max(180);
export const LatLng = z.tuple([lat, lng]);

/** POST /api/v2i/route */
export const RouteRequest = z
  .object({
    start: LatLng,
    end: LatLng,
    profile: z.enum(["driving-car"]).default("driving-car"),
  })
  .strict();

const TURN = z.enum(["NONE", "STRAIGHT", "LEFT", "RIGHT", "U_TURN"]);

/** POST /api/v2i/telemetry: the body built by build_cloud_body() in roadside_rx_esp32s3.ino */
export const Telemetry = z
  .object({
    deviceId: z.string().regex(/^RSU-[0-9A-Za-z_-]{1,7}$/),
    junctionId: z.string().regex(/^[0-9A-Za-z_-]{1,7}$/),
    uptimeS: z.number().int().min(0).max(10 * 365 * 86400),
    mode: z.enum(["NORMAL", "PREEMPT", "RECOVER", "UNCONFIGURED"]),
    phase: z.enum(["GREEN", "YELLOW", "ALL_RED"]),
    lamps: z.string().regex(/^[RYG]{0,5}$/),
    servedAmbId: z.string().regex(AMB_ID).nullable(),
    rxOk: z.number().int().min(0),
    rxBad: z.number().int().min(0),
    filtered: z.number().int().min(0),
    preemptions: z.number().int().min(0),
    ambulances: z
      .array(
        z
          .object({
            ambId: z.string().regex(AMB_ID),
            lat,
            lng,
            speedKmh: z.number().min(0).max(200),
            headingDeg: z.number().min(0).max(360),
            distM: z.number().min(0).max(100_000),
            forUs: z.boolean(),
            turn: TURN,
            severity: z.number().int().min(0).max(15),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();
export type TelemetryBody = z.infer<typeof Telemetry>;

/** GET /api/v2i/roads?s=&w=&n=&e= : at most ~0.04 x 0.04 degrees (about 4.4 km square) */
export const MAX_BBOX_DEG = 0.04;
export const RoadsQuery = z
  .object({ s: z.coerce.number().pipe(lat), w: z.coerce.number().pipe(lng), n: z.coerce.number().pipe(lat), e: z.coerce.number().pipe(lng) })
  .refine((q) => q.n > q.s && q.e > q.w, "north must exceed south and east must exceed west")
  .refine((q) => q.n - q.s <= MAX_BBOX_DEG && q.e - q.w <= MAX_BBOX_DEG, `area too large (max ${MAX_BBOX_DEG} degrees per side)`);

export const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).slice(0, 8);
