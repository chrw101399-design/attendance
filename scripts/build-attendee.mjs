import { build } from "esbuild";

await build({
  entryPoints: ["attendee/checkin.ts", "attendee/kiosk.ts"],
  bundle: true,
  format: "iife",
  minify: true,
  outdir: "public",
  target: "es2019",
});
