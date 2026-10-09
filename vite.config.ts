// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Pin the server adapter when building on external hosts. Without this, the build
// can fall back to the Cloudflare Worker output, which Vercel/Netlify don't serve,
// so the deploy shows "Ready" but "/" returns 404. Inside Lovable this is ignored.
const externalPreset = process.env.NITRO_PRESET
  ? process.env.NITRO_PRESET
  : process.env.VERCEL
    ? "vercel"
    : process.env.NETLIFY
      ? "netlify"
      : undefined;

export default defineConfig({
  ...(externalPreset ? { nitro: { preset: externalPreset } } : {}),
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
    // Prerender the single game page so the build also works as a static site (e.g. Render).
    pages: [{ path: "/" }],
    prerender: { enabled: true, autoStaticPathsDiscovery: false },
  },
});
