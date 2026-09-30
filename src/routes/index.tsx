import { ClientOnly } from "@tanstack/react-router";
import LumenHunt from "@/game/LumenHunt";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Lumen Hunt — Neon Hide & Seek Arcade Game" },
      {
        name: "description",
        content:
          "Play Lumen Hunt: scan for invisible cubes, dodge red seekers, dash, drop decoys and escape through portals in a neon labyrinth — solo or online with a friend.",
      },
      { property: "og:title", content: "Lumen Hunt — Neon Hide & Seek Arcade Game" },
      {
        property: "og:description",
        content:
          "Collect 5 real cubes while hunters track your every sound. Scan, dash, cloak and survive — or grab a room code and hunt a friend online.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ClientOnly fallback={<main className="fixed inset-0 bg-void" />}>
      <LumenHunt />
    </ClientOnly>
  );
}
