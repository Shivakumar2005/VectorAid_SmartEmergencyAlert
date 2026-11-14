// Fails (exit 1) if a secret could reach a browser or a repository:
//  - the browser bundle (.next/static) contains a secret's value, a secret variable's name, or an
//    OpenRouteService key pattern
//  - a source file contains a secret's value or an ORS key pattern, or a secret has a NEXT_PUBLIC_ name
// Secret values are read from the environment and from .env / .env.local; they are never printed.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NAMES = ["ORS_API_KEY", "V2I_HMAC_SECRET", "UPSTASH_REDIS_REST_TOKEN"];
const ORS_PATTERNS = [/5b3ce3597851110001cf6248[0-9a-f]{8,}/i, /eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgi/];

const values = new Map();
for (const f of [".env", ".env.local", ".env.production.local"]) {
  const p = join(root, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
    if (m && NAMES.includes(m[1])) values.set(m[1], m[2]);
  }
}
for (const n of NAMES) if (process.env[n]) values.set(n, process.env[n]);
for (const [k, v] of values) if (!v || v.length < 8 || /^<.*>$/.test(v)) values.delete(k);

const walk = (dir, skip) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (skip(relative(root, p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, skip));
    else if (st.size < 20 * 1024 * 1024) out.push(p);
  }
  return out;
};

const hits = [];
const check = (file, text, { names }) => {
  for (const [k, v] of values) if (text.includes(v)) hits.push(`${relative(root, file)}: contains the value of ${k}`);
  for (const re of ORS_PATTERNS) if (re.test(text)) hits.push(`${relative(root, file)}: contains something shaped like an OpenRouteService key`);
  if (names) for (const n of NAMES) if (text.includes(n)) hits.push(`${relative(root, file)}: mentions ${n} (browser code must not)`);
  for (const n of NAMES) if (text.includes(`NEXT_PUBLIC_${n}`)) hits.push(`${relative(root, file)}: NEXT_PUBLIC_${n} would publish the secret`);
};

const staticDir = join(root, ".next", "static");
const bundle = walk(staticDir, () => false);
if (!bundle.length) console.warn("note: .next/static not found - run `npm run build` first to scan the browser bundle");
for (const f of bundle) check(f, readFileSync(f, "utf8"), { names: true });

const src = walk(root, (r) => /^(node_modules|\.next|\.git|\.vercel)(\/|$)/.test(r) || /^\.env(\..*)?$/.test(r) && r !== ".env.example" || /\.(png|jpg|ico|woff2?|zip)$/.test(r) || r === "scripts/scan-secrets.mjs");
for (const f of src) check(f, readFileSync(f, "utf8"), { names: false });

if (hits.length) {
  console.error(`SECRET SCAN FAILED (${hits.length}):\n  ` + [...new Set(hits)].join("\n  "));
  process.exit(1);
}
console.log(`secret scan passed: ${bundle.length} browser files, ${src.length} source files, ${values.size} secret value(s) checked`);
