import type { Config } from "tailwindcss";

// Palette: a desaturated "survey sheet" chrome so that only the signal lamps (r/y/g) and the
// ambulance (beacon blue) carry colour. Overpass is derived from Highway Gothic, the road-sign face.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#E9EDF1",
        sheet: "#F7F9FB",
        ink: "#1B2430",
        dim: "#5B6776",
        rule: "#C3CCD6",
        housing: "#262D36",
        beacon: { DEFAULT: "#1F4FD8", soft: "#DCE5FB" },
        sig: { r: "#E0372B", y: "#F0A500", g: "#14A05D", off: "#3A424D" },
      },
      fontFamily: {
        sans: ["Overpass", "system-ui", "sans-serif"],
        mono: ["Overpass Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
