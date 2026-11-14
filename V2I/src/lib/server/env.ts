// Server-only configuration. Importing this from a client component fails the build ("server-only"),
// so these values can never end up in the browser bundle. None of them has a NEXT_PUBLIC_ prefix.
import "server-only";

const val = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  // the placeholders from .env.example count as "not set"
  return v && !/^<.*>$/.test(v) ? v : undefined;
};

export const serverEnv = {
  orsKey: () => val("ORS_API_KEY"),
  hmacSecret: () => val("V2I_HMAC_SECRET"),
  upstashUrl: () => val("UPSTASH_REDIS_REST_URL"),
  upstashToken: () => val("UPSTASH_REDIS_REST_TOKEN"),
  /** Tried in order until one answers: yours (OVERPASS_URL) first if set, then three public instances. */
  overpassUrls: () => [
    ...new Set([
      val("OVERPASS_URL"),
      "https://overpass-api.de/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
    ].filter((u): u is string => Boolean(u))),
  ],
  /** Tile proxy is opt-in: OSM requires a contactable User-Agent for proxies (see README). */
  tileContact: () => val("TILE_PROXY_CONTACT"),
};

export const hasUpstash = () => Boolean(serverEnv.upstashUrl() && serverEnv.upstashToken());
