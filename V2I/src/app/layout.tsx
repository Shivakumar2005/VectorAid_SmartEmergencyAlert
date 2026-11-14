import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@fontsource/overpass/400.css";
import "@fontsource/overpass/600.css";
import "@fontsource/overpass/800.css";
import "@fontsource/overpass-mono/400.css";
import "@fontsource/overpass-mono/600.css";
import "leaflet/dist/leaflet.css";
import "./globals.css";

// Every page is rendered per request so that Next.js can put this request's CSP nonce
// (set in src/middleware.ts) on its scripts.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "V2I ambulance signal pre-emption",
  description: "Route-aware traffic-signal pre-emption for ambulances: ESP32-S3 + nRF24L01+ roadside units, live simulation and hardware twin.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#E9EDF1" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers(); // read the request headers: forces per-request rendering (nonce)
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
