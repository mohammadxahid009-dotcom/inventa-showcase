// Plain client-side build of Lumen Hunt for static hosts (Vercel, Netlify, GitHub Pages...).
// Output: dist-static/index.html + assets. No server, so the root URL can never 404.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The shared Supabase client has a server-side process.env fallback; stub it in the browser.
  define: { "process.env": "{}" },
  build: { outDir: "dist-static", emptyOutDir: true },
});
