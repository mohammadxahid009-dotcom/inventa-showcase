<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Game lives in src/game (engine.ts canvas engine + LumenHunt.tsx UI); the old public/hide-seek-maze.html is unused legacy — don't edit it. Why: user asked for a from-scratch rebuild.
- Multiplayer uses Lovable Cloud realtime broadcast channels `lumen-<CODE>` (host sends seed); no tables. Why: stateless rooms.
- Walls are drawn per-frame for visible tiles only (no big offscreen canvas). Why: avoids blank maze on mobile.
