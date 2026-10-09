// Static (client-only) entry used for Vercel / Netlify / any static host.
// Lovable hosting keeps using the TanStack Start app in src/routes — this file is only
// used by `npm run build:static` (vite.static.config.ts).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LumenHunt from "@/game/LumenHunt";
import "./styles.css";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <LumenHunt />
    </StrictMode>,
  );
}
