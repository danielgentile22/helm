// Rasterise public/icon.svg to the two PNG sizes the web app manifest names. The SVG is the
// source and ships as the favicon; the PNGs exist because a manifest cannot take a vector.
// Run by hand after editing the SVG: `npm run icons`. It is out of `npm run build` on purpose,
// since rsvg-convert is not something a fresh host has and the PNGs are committed.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const SIZES = [192, 512];

try {
  execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
} catch {
  console.error("make-icons: rsvg-convert is not on PATH (brew install librsvg)");
  process.exit(1);
}

for (const size of SIZES) {
  const out = join(PUBLIC, `icon-${size}.png`);
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), join(PUBLIC, "icon.svg"), "-o", out]);
  console.log(`icon-${size}.png`);
}
