import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { Game, type EndInfo, type Hud, type Role } from "./engine";
import { Voice, type VoiceState } from "./voice";

const DIFFS = [
  { name: "Normal", m: 1, h: 150 },
  { name: "Hard", m: 1.12, h: 220 },
  { name: "Insane", m: 1.25, h: 300 },
];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Screen = "menu" | "play" | "end";

export default function LumenHunt() {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const mmRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const chRef = useRef<RealtimeChannel | null>(null);
  const myId = useRef(Math.random().toString(36).slice(2));
  const startedRef = useRef(false);
  const voiceRef = useRef<Voice | null>(null);
  const isHostRef = useRef(false);
  const roomRef = useRef("");
  const [vc, setVc] = useState<VoiceState | null>(null);
  const stopVoice = () => { voiceRef.current?.stop(); voiceRef.current = null; setVc(null); };

  const [screen, setScreen] = useState<Screen>("menu");
  const [tab, setTab] = useState<"solo" | "mp">("solo");
  const [diff, setDiff] = useState(1);
  const [hud, setHud] = useState<Hud | null>(null);
  const [end, setEnd] = useState<EndInfo | null>(null);
  const [toast, setToast] = useState("");
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(1);
  const [soloRole, setSoloRole] = useState<Role>("h");

  // multiplayer ui state
  const [role, setRole] = useState<Role>("h");
  const [companion, setCompanion] = useState(false);
  const [codeIn, setCodeIn] = useState("");
  const [room, setRoom] = useState("");
  const [isHost, setIsHost] = useState(false);
  const [mpMsg, setMpMsg] = useState("");

  useEffect(() => {
    const g = new Game(cvRef.current!, mmRef.current!);
    gameRef.current = g;
    let tt: ReturnType<typeof setTimeout>;
    g.onHud = setHud;
    g.onToast = (t) => { setToast(t); clearTimeout(tt); tt = setTimeout(() => setToast(""), 2200); };
    g.onEnd = (e) => { setEnd(e); setScreen("end"); };
    const kd = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      g.keys[k] = true;
      if (k === " ") { e.preventDefault(); g.doScan(); }
      if (k === "Shift") g.doDash();
      if (k === "e") g.doDecoy();
      if (k === "p" || k === "Escape") { g.togglePause(); setPaused(g.paused); }
      if (k.startsWith("Arrow")) e.preventDefault();
    };
    const ku = (e: KeyboardEvent) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; g.keys[k] = false; };
    const vis = () => { g.keys = {}; g.jx = g.jy = 0; g.last = performance.now(); };
    addEventListener("keydown", kd);
    addEventListener("keyup", ku);
    document.addEventListener("visibilitychange", vis);
    return () => {
      removeEventListener("keydown", kd); removeEventListener("keyup", ku);
      document.removeEventListener("visibilitychange", vis);
      g.destroy();
      voiceRef.current?.stop();
      if (chRef.current) void supabase.removeChannel(chRef.current);
    };
  }, []);

  // ---------- fullscreen ----------
  const goFullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement) return;
    try {
      if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      else el.webkitRequestFullscreen?.();
    } catch { /* not supported (e.g. iPhone Safari) */ }
  };

  // ---------- solo ----------
  const playSolo = (lvl = 1) => {
    goFullscreen();
    const d = DIFFS[diff] ?? DIFFS[0];
    if (!d) return;
    setLevel(lvl); setEnd(null); setPaused(false);
    if (soloRole === "s") gameRef.current!.startHunt(d.m, lvl);
    else gameRef.current!.startSolo(d.m, d.h, lvl);
    setScreen("play");
  };

  // ---------- multiplayer ----------
  const leaveRoom = (msg = "") => {
    stopVoice();
    if (chRef.current) void supabase.removeChannel(chRef.current);
    chRef.current = null; startedRef.current = false;
    gameRef.current?.stop();
    setRoom(""); setIsHost(false); setMpMsg(msg); setScreen("menu"); setTab("mp");
  };

  const beginMatch = (seed: number, myRole: Role, co = false) => {
    startedRef.current = true;
    setEnd(null); setPaused(false);
    const ch = chRef.current!;
    if (voiceRef.current?.key !== roomRef.current) {
      voiceRef.current?.stop();
      if (typeof RTCPeerConnection !== "undefined" && roomRef.current) voiceRef.current = new Voice(roomRef.current, isHostRef.current, setVc);
    }
    gameRef.current!.startMp(seed, myRole, {
      send: (ev, payload) => { void ch.send({ type: "broadcast", event: ev, payload }); },
    }, co);
    setScreen("play");
  };

  const hostStart = () => {
    const seed = (Math.random() * 1e9) | 0;
    void chRef.current?.send({ type: "broadcast", event: "start", payload: { seed, hr: role, co: role === "s" && companion } });
    beginMatch(seed, role, role === "s" && companion);
  };

  const joinRoom = (code: string, host: boolean) => {
    stopVoice();
    isHostRef.current = host;
    roomRef.current = code;
    if (chRef.current) void supabase.removeChannel(chRef.current);
    startedRef.current = false;
    setRoom(code); setIsHost(host);
    setMpMsg(host ? "Connecting…" : `Joining room ${code}…`);
    const ch = supabase.channel(`lumen-${code}`, { config: { broadcast: { self: false }, presence: { key: myId.current } } });
    chRef.current = ch;
    let found = host;

    ch.on("presence", { event: "sync" }, () => {
      const st = ch.presenceState() as Record<string, { host?: boolean }[]>;
      const ids = Object.keys(st);
      const hostHere = ids.some((i) => st[i]?.[0]?.host);
      if (!host) {
        if (hostHere) found = true;
        if (!hostHere && found) { if (startedRef.current || found) leaveRoom("The host left the room."); return; }
        if (ids.length > 2) { const sorted = ids.sort(); if (sorted.indexOf(myId.current) > 1) leaveRoom("Room is full."); }
        if (hostHere && !startedRef.current) setMpMsg("Connected! Waiting for the host to start…");
      } else {
        if (ids.length >= 2 && !startedRef.current) { setMpMsg("Friend joined! Starting…"); setTimeout(() => { if (!startedRef.current && chRef.current === ch) hostStart(); }, 600); }
        else if (ids.length < 2 && startedRef.current) { gameRef.current?.stop(); leaveRoom("Your friend left the room."); }
      }
    });
    ch.on("broadcast", { event: "start" }, ({ payload }) => {
      if (host) return;
      beginMatch(payload.seed, payload.hr === "h" ? "s" : "h", !!payload.co);
    });
    for (const ev of ["st", "coin", "scan", "spot", "decoy", "pow", "dmg", "mis", "bul", "shk"]) {
      ch.on("broadcast", { event: ev }, ({ payload }) => gameRef.current?.netIn(ev, payload));
    }
    ch.on("broadcast", { event: "end" }, ({ payload }) => gameRef.current?.remoteEnd(payload.w, payload.text));
    ch.on("broadcast", { event: "rematch" }, ({ payload }) => { if (!host) beginMatch(payload.seed, payload.hr === "h" ? "s" : "h", !!payload.co); });

    ch.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await ch.track({ host });
        if (host) setMpMsg("Share this code with a friend — waiting…");
        else setTimeout(() => { if (chRef.current === ch && !found) leaveRoom(`Room ${code} not found.`); }, 7000);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        leaveRoom("Connection problem — please try again.");
      }
    });
  };

  const createRoom = () => {
    goFullscreen();
    let c = "";
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    joinRoom(c, true);
  };

  const rematch = () => {
    const seed = (Math.random() * 1e9) | 0;
    void chRef.current?.send({ type: "broadcast", event: "rematch", payload: { seed, hr: role, co: role === "s" && companion } });
    beginMatch(seed, role, role === "s" && companion);
  };

  // ---------- touch controls ----------
  const jsRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const jPointer = useRef<number | null>(null);
  const jMove = (e: React.PointerEvent) => {
    if (jPointer.current !== e.pointerId) return;
    const r = jsRef.current!.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const max = r.width / 2 - 20, l = Math.hypot(dx, dy);
    if (l > max) { dx = (dx / l) * max; dy = (dy / l) * max; }
    if (knobRef.current) knobRef.current.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const g = gameRef.current!;
    const deadzone = 4;
    const fullThreshold = 14;
    if (l < deadzone) {
      g.jx = 0;
      g.jy = 0;
    } else {
      const strength = Math.min(1, (l - deadzone) / (fullThreshold - deadzone));
      const cl = Math.hypot(dx, dy) || 1;
      g.jx = (dx / cl) * strength;
      g.jy = (dy / cl) * strength;
    }
  };
  const jEnd = () => { jPointer.current = null; if (knobRef.current) knobRef.current.style.transform = "translate(-50%, -50%)"; const g = gameRef.current!; g.jx = g.jy = 0; };

  const g = gameRef.current;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const playing = screen === "play";

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-void text-ink" style={{ touchAction: "none" }}>
      <canvas ref={cvRef} className="absolute inset-0 h-full w-full" />
      <div className="pointer-events-none absolute" style={{ top: "env(safe-area-inset-top)", right: "env(safe-area-inset-right)", bottom: "env(safe-area-inset-bottom)", left: "env(safe-area-inset-left)" }}>
      <div className="pointer-events-auto contents">

      {/* HUD */}
      <div className={`pointer-events-none absolute inset-x-0 top-2 flex items-center justify-between gap-2 px-3 text-xs font-bold ${playing ? "" : "invisible"}`}>
        <div className="min-w-0 truncate whitespace-nowrap rounded-full border border-neon-violet/40 bg-void-glass px-3 py-1.5">
          {hud?.mp
            ? `${hud.role === "h" ? "🔵" : "🔴"} hider ${hud.score}/${hud.goal} · 🟡 ${hud.coins ?? 0} · ${room}`
            : hud?.hunt
              ? `🎯 ${hud.score}/2 caught · ⏱ ${fmt(hud.timeLeft ?? 0)} · Lv ${hud.level}`
              : `🔵 ${hud?.score ?? 0}/${hud?.goal ?? 5} · 🟡 ${hud?.coins ?? 0} · Lv ${hud?.level ?? 1}`}
        </div>
                <div className="shrink-0 whitespace-nowrap rounded-full border border-neon-violet/40 bg-void-glass px-3 py-1.5">
          {hud?.mp || hud?.hunt ? `You: ${hud.role === "h" ? "HIDER" : "HUNTER"}` : hud?.seekers}
        </div>
      </div>
      {playing && hud?.mp && vc && (
        <div className="absolute right-3 top-[5.25rem] flex flex-col items-end gap-1 text-[11px] font-bold">
          <button
            onClick={() => void voiceRef.current?.setMic(!vc.micOn)}
            className={`rounded-full border bg-void-glass px-2.5 py-1 transition-shadow ${vc.peerTalking ? "border-neon-yellow text-neon-yellow shadow-[0_0_14px_currentColor]" : vc.micOn ? "border-neon-blue text-neon-blue" : "border-ink/30 text-ink/70"}`}
          >
            {vc.micOn ? "🎙️ Mic on" : "🔇 Mic off"}
          </button>
          <div className={`rounded-full bg-void-glass px-2 py-1 ${vc.peerTalking ? "text-neon-yellow" : "text-ink/60"}`}>
            {vc.connected ? (vc.peerTalking ? "🔊 Friend talking" : "🔈 Voice ready") : "… connecting voice"}
          </div>
          {vc.error && <div className="max-w-48 rounded-xl bg-void-glass px-2 py-1 text-neon-red">{vc.error}</div>}
        </div>
      )}
      {playing && hud?.mp && hud.role === "s" && (
        <div className="pointer-events-none absolute left-1/2 top-12 flex -translate-x-1/2 items-center gap-1 text-xs font-bold">
          ❤️
          <div className="h-2.5 w-24 overflow-hidden rounded-full border border-ink/30 bg-void-glass">
            <div className={`h-full transition-all ${hud.hp > 0.67 ? "bg-neon-blue" : hud.hp > 0.34 ? "bg-neon-yellow" : "bg-neon-red"}`} style={{ width: `${Math.max(0, hud.hp) * 100}%` }} />
          </div>
        </div>
      )}
      {playing && hud?.role === "h" && (hud.mp || hud.hiderHp < 1) && (
        <div className="pointer-events-none absolute left-1/2 top-12 flex -translate-x-1/2 items-center gap-1 text-xs font-bold">
          ⚡
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-2.5 w-4 rounded-sm border border-ink/30" style={{ background: hud.hiderHp > i * 0.2 + 0.01 ? "#4fd8ff" : "rgba(10,10,30,.7)" }} />
          ))}
        </div>
      )}
      {playing && hud?.shock?.on && !hud.shock!.ready && hud.shock!.near && hud.shock!.genCd <= 0 && (
        <div className="pointer-events-none absolute left-1/2 top-[6.5rem] -translate-x-1/2 whitespace-nowrap rounded-full border border-neon-blue bg-void-glass px-3 py-1 text-xs font-bold">⚡ Charging SHOCK… {Math.round(hud.shock!.charge * 100)}%</div>
      )}
      {playing && hud?.alarm && (
        <div className="pointer-events-none absolute left-1/2 top-[8.5rem] -translate-x-1/2 rounded-full border border-neon-red bg-void-glass px-3 py-1 text-xs font-bold">{hud.alarm}</div>
      )}
      {playing && hud?.seen && (
        <div className="pointer-events-none absolute left-1/2 top-[4.25rem] -translate-x-1/2 rounded-full border border-neon-red bg-void-glass px-3 py-0.5 text-xs font-bold text-neon-red">👁 SEEN</div>
      )}
      <canvas
        ref={mmRef}
        width={124}
        height={124}
        className={`pointer-events-none absolute left-3 top-11 h-[100px] w-[100px] rounded-xl border border-neon-violet/40 ${playing ? "" : "invisible"}`}
      />
      <div className={`pointer-events-none absolute inset-x-0 top-[24%] text-center text-lg font-bold drop-shadow transition-opacity ${toast && playing ? "opacity-100" : "opacity-0"}`}>{toast}</div>

      {playing && (
        <>
          <div className="absolute right-3 top-11 flex gap-2">
            <button className="h-9 w-9 rounded-full border border-neon-violet/40 bg-void-glass text-sm" onClick={() => { g?.togglePause(); setPaused(!!g?.paused); }} aria-label="Pause">⏸</button>
            <button className="h-9 w-9 rounded-full border border-neon-violet/40 bg-void-glass text-sm" onClick={() => { if (g) { g.muted = !g.muted; setMuted(g.muted); } }} aria-label="Sound">{muted ? "🔇" : "🔊"}</button>
          </div>

          {/* joystick */}
          <div
            ref={jsRef}
            className="absolute bottom-7 left-5 h-32 w-32 rounded-full border-2 border-neon-blue/60 bg-neon-blue/10"
            onPointerDown={(e) => { jPointer.current = e.pointerId; (e.target as HTMLElement).setPointerCapture(e.pointerId); jMove(e); }}
            onPointerMove={jMove}
            onPointerUp={jEnd}
            onPointerCancel={jEnd}
          >
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 h-14 w-14 rounded-full bg-neon-blue shadow-[0_0_18px_var(--neon-blue)]"
              ref={knobRef}
              style={{ transform: "translate(-50%, -50%)" }}
            />
          </div>

          {/* weapon aiming */}
          {hud?.aiming && (
            <>
              <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-full border border-neon-yellow/60 bg-void-glass px-4 py-1.5 text-sm font-bold">
                {hud.weapon === "missile" ? (hud.lock >= 1 ? "🟢 LOCKED — FIRE!" : "🎯 Hold the circle on a hunter") : hud.weapon === "mini" ? "🚀🚀 Aim at a hunter — tap FIRE" : `🌧️ ${hud.ammo} bullets — hold FIRE`}
              </div>
              <button
                onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); g?.setFire(true); }}
                onPointerUp={() => g?.setFire(false)}
                onPointerCancel={() => g?.setFire(false)}
                className="absolute bottom-9 right-6 flex h-24 w-24 items-center justify-center rounded-full bg-neon-red text-base font-extrabold text-ink shadow-[0_0_24px_var(--neon-red)]"
                style={{ opacity: hud.weapon === "missile" && hud.lock < 1 ? 0.5 : 1 }}
              >
                FIRE
              </button>
              <button
                onPointerDown={(e) => { e.preventDefault(); g?.toggleAim(); }}
                className="absolute bottom-40 right-8 flex h-12 w-12 items-center justify-center rounded-full border border-ink/30 bg-void-glass text-sm font-extrabold"
                aria-label="Cancel aiming"
              >✕</button>
            </>
          )}

          {!hud?.aiming && hud?.weapon && (
            <button
              onPointerDown={(e) => { e.preventDefault(); g?.toggleAim(); }}
              className="absolute bottom-60 right-8 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-neon-red text-[10px] font-extrabold text-ink shadow-[0_0_20px_var(--neon-red)]"
            >
              <span className="text-lg">{hud.weapon === "missile" ? "🚀" : hud.weapon === "mini" ? "🚀🚀" : "🌧️"}</span>
              {hud.weapon === "missile" ? "MISSILE" : hud.weapon === "mini" ? "MINI" : "RAIN"}
            </button>
          )}

          {/* scout drones */}
          {hud && hud.drones > 0 && hud.droneLock > 0 && (
            <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded-full border border-neon-red/60 bg-void-glass px-4 py-1.5 text-sm font-bold">
              {hud.role === "h" ? `🛸 Drone lock ${Math.round(hud.droneLock * 100)}% — DASH to break it!` : `🛸 Drones locking on ${Math.round(hud.droneLock * 100)}%`}
            </div>
          )}
          {hud?.role === "h" && hud.ropeAvail && !hud.aiming && (
            <button
              onPointerDown={(e) => { e.preventDefault(); g?.doRope(); }}
              className="absolute bottom-60 right-28 flex h-16 w-16 flex-col items-center justify-center rounded-full bg-neon-yellow text-[10px] font-extrabold text-void shadow-[0_0_20px_var(--neon-yellow)] animate-pulse"
            >
              <span className="text-lg">🪢</span>ROPE
            </button>
          )}
          {hud?.role === "h" && hud.roped && <SwipeBar pull={hud.pull} onSwipe={() => g?.swipeRope()} />}

          {/* action buttons */}
          {!hud?.aiming && (<>
          <button
            onPointerDown={(e) => { e.preventDefault(); g?.doScan(); }}
            className="absolute bottom-9 right-6 flex h-24 w-24 items-center justify-center rounded-full bg-neon-blue text-sm font-extrabold text-ink shadow-[0_0_24px_var(--neon-blue)]"
            style={{ opacity: hud && hud.scanCd > 0 ? 0.45 : 1 }}
          >
            {hud && hud.scanCd > 0 ? Math.ceil(hud.scanCd) : "SCAN"}
          </button>
          <button
            onPointerDown={(e) => { e.preventDefault(); g?.doDash(); }}
            className="absolute bottom-8 right-36 flex h-16 w-16 items-center justify-center rounded-full bg-neon-yellow text-xs font-extrabold text-void"
            style={{ opacity: hud && hud.dashCd > 0 ? 0.45 : 1 }}
          >
            {hud && hud.dashCd > 0 ? Math.ceil(hud.dashCd) : "DASH"}
          </button>
          {hud?.shock?.on && (
            <button
              onPointerDown={(e) => { e.preventDefault(); g?.doShock(); }}
              className={`absolute bottom-40 right-8 flex h-20 w-20 flex-col items-center justify-center rounded-full text-xs font-extrabold ${hud.shock!.ready ? "animate-pulse text-ink shadow-[0_0_28px_#3fb8ff]" : "text-ink/70"}`}
              style={{
                background: hud.shock!.ready
                  ? "radial-gradient(circle, #6fd8ff 0%, #1f6bff 70%)"
                  : `conic-gradient(#3fb8ff ${hud.shock!.charge * 360}deg, rgba(30,40,70,.85) 0deg)`,
                border: "2px solid #7fe6ff",
              }}
            >
              <span className="text-2xl leading-none">⚡</span>
              <span className="text-[10px]">
                {hud.shock!.ready ? "SHOCK" : hud.shock!.charge > 0 ? `${Math.round(hud.shock!.charge * 100)}%` : hud.shock!.genCd > 0 ? `${Math.ceil(hud.shock!.genCd)}s` : "GEN"}
              </span>
            </button>
          )}
          {hud?.role === "h" && (
            <button
              onPointerDown={(e) => { e.preventDefault(); g?.doDecoy(); }}
              className="absolute bottom-40 right-8 flex h-16 w-16 items-center justify-center rounded-full bg-neon-violet text-xs font-extrabold text-void"
              style={{ opacity: hud.decoyCd > 0 ? 0.45 : 1 }}
            >
              {hud.decoyCd > 0 ? Math.ceil(hud.decoyCd) : "DECOY"}
            </button>
          )}
          </>)}

          {paused && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-void/85">
              <div className="text-2xl font-extrabold">⏸ Paused</div>
              <button className="w-48 rounded-2xl bg-primary px-4 py-3 font-bold text-primary-foreground" onClick={() => { g?.togglePause(); setPaused(false); }}>
                ▶ Resume
              </button>
              <button className="w-48 rounded-2xl border border-destructive/60 px-4 py-3 font-bold text-destructive" onClick={() => { if (confirm("Give up this match?")) { setPaused(false); g?.giveUp(); } }}>
                🏳 Give up
              </button>
            </div>
          )}
        </>
      )}

      </div>
      </div>

      {/* menus */}
      {screen !== "play" && (
        <div
          className="absolute inset-0 z-20 flex flex-col items-center gap-4 overflow-y-auto px-6 pb-10 pt-[8vh] text-center"
          style={{ background: "radial-gradient(circle at 15% 20%, color-mix(in oklch, var(--neon-blue) 40%, transparent), transparent 45%), radial-gradient(circle at 85% 80%, color-mix(in oklch, var(--neon-red) 35%, transparent), transparent 45%), var(--void)" }}
        >
          <h1 className="text-4xl font-black tracking-tight">🔵 Lumen Hunt 🔴</h1>

          {screen === "end" && end ? (
            <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl border border-ink/15 bg-ink/5 p-6-xl">
              <h2 className="text-3xl font-extrabold">{end.win ? "🏆 YOU WIN!" : "💀 YOU LOSE"}</h2>
              <p className="text-ink-dim">{end.text}</p>
              {room ? (
                <>
                  {isHost ? (
                    <>
                      <RoleToggle role={role} setRole={setRole} companion={companion} setCompanion={setCompanion} />
                      <button className="rounded-full bg-neon-blue px-8 py-3 text-lg font-extrabold" onClick={rematch}>Rematch ▶</button>
                    </>
                  ) : (
                    <p className="font-bold text-neon-yellow">Waiting for the host to start a rematch…</p>
                  )}
                  <button className="rounded-2xl border border-ink/20 px-4 py-2 font-bold" onClick={() => leaveRoom()}>Leave room</button>
                </>
              ) : (
                <>
                  <button className="rounded-full bg-neon-blue px-8 py-3 text-lg font-extrabold" onClick={() => playSolo(end.nextLevel ? level + 1 : 1)}>
                    {end.nextLevel ? `Next level ${level + 1} ▶` : "Play again"}
                  </button>
                  <button className="rounded-2xl border border-ink/20 px-4 py-2 font-bold" onClick={() => setScreen("menu")}>Menu</button>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex rounded-full border border-ink/15 bg-ink/5 p-1-xl">
                {(["solo", "mp"] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)} className={`rounded-full px-5 py-2 font-extrabold ${tab === t ? "bg-neon-blue" : "text-ink-dim"}`}>
                    {t === "solo" ? "🎮 Solo" : "👥 Multiplayer"}
                  </button>
                ))}
              </div>
              <p className="text-ink-dim">Find the real keys, reach the exit, avoid the seekers.</p>

              {tab === "solo" ? (
                <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-3xl border border-ink/15 bg-ink/5 p-5-xl">
                  <div className="flex items-center gap-2">
                    <span className="text-ink-dim">Play as:</span>
                    {(["h", "s"] as const).map((r) => (
                      <button key={r} onClick={() => setSoloRole(r)} className={`rounded-2xl border px-4 py-2 text-sm font-bold ${soloRole === r ? "border-neon-blue bg-neon-blue" : "border-ink/20 text-ink-dim"}`}>
                        {r === "h" ? "🔵 Hider" : "🔴 Hunter"}
                      </button>
                    ))}
                  </div>
                  {soloRole === "s" && <p className="text-xs text-ink-dim">Catch 2 AI hiders before time runs out. Scan, radar 📡 and tracker 👣 help you find them.</p>}
                  <div className="flex gap-2">
                    {DIFFS.map((d, i) => (
                      <button key={d.name} onClick={() => setDiff(i)} className={`rounded-2xl border px-4 py-2 text-sm font-bold ${diff === i ? "border-neon-red bg-neon-red" : "border-ink/20 text-ink-dim"}`}>{d.name}</button>
                    ))}
                  </div>
                  <button className="rounded-full bg-neon-blue px-10 py-3 text-xl font-extrabold shadow-[0_0_20px_var(--neon-blue)]" onClick={() => playSolo(1)}>Play solo</button>
                  <details className="max-w-xs text-left text-sm text-ink-dim">
                    <summary className="cursor-pointer text-center font-bold text-ink">How to play</summary>
                    <p className="mt-2 leading-relaxed">
                      You are the blue hider. Keys are invisible — SCAN to reveal them for 4s. Only one in each set is real; fakes are duds. Collect 5 real keys, then reach the green EXIT box to escape.
                      Red seekers hunt you: they see you in line of sight and hear you move nearby (stand still to stay quiet). Their scan rings expose you for 5s.
                      Power-ups: ⚡ speed, 👻 cloak, 🔄 scan recharge, ❄️ freeze. DASH (Shift) is fast but noisy, DECOY (E) lures seekers, and 🌀 portals teleport you.
                      Alarms track you for 4s. Every win makes the next level harder. Controls: WASD/arrows, Space to scan.
                    </p>
                  </details>
                </div>
              ) : (
                <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl border border-ink/15 bg-ink/5 p-5-xl">
                  {!room ? (
                    <>
                      <RoleToggle role={role} setRole={setRole} companion={companion} setCompanion={setCompanion} />
                      <button className="rounded-2xl border border-neon-blue px-5 py-2 font-extrabold" onClick={createRoom}>Create room</button>
                      <div className="flex gap-2">
                        <input
                          value={codeIn}
                          onChange={(e) => setCodeIn(e.target.value.toUpperCase())}
                          maxLength={5}
                          placeholder="CODE"
                          className="w-28 rounded-2xl border border-ink/20 bg-ink/5 px-3 py-2 text-center font-extrabold uppercase tracking-[0.3em] text-ink outline-none"
                        />
                        <button
                          className="rounded-2xl border border-neon-blue px-4 py-2 font-extrabold"
                          onClick={() => { const c = codeIn.trim(); if (c.length < 4) { setMpMsg("Enter the room code"); return; } (document.activeElement as HTMLElement)?.blur(); goFullscreen(); joinRoom(c, false); }}
                        >Join</button>
                      </div>
                    </>
                  ) : (
                    <>
                      {isHost && <div className="text-3xl font-black tracking-[0.35em]">{room}</div>}
                      <button className="rounded-2xl border border-ink/20 px-4 py-2 font-bold" onClick={() => leaveRoom()}>Leave room</button>
                    </>
                  )}
                  <p className="min-h-5 font-bold text-neon-yellow">{mpMsg}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RoleToggle({ role, setRole, companion, setCompanion }: { role: Role; setRole: (r: Role) => void; companion: boolean; setCompanion: (v: boolean) => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
    <div className="flex items-center gap-2">
      <span className="text-ink-dim">I am:</span>
      {(["h", "s"] as const).map((r) => (
        <button key={r} onClick={() => setRole(r)} className={`rounded-2xl border px-4 py-2 text-sm font-bold ${role === r ? "border-neon-red bg-neon-red" : "border-ink/20 text-ink-dim"}`}>
          {r === "h" ? "🔵 Hider" : "🔴 Seeker"}
        </button>
      ))}
    </div>
    {role === "s" && (
      <button
        role="switch"
        aria-checked={companion}
        onClick={() => setCompanion(!companion)}
        className="flex items-center gap-3 rounded-2xl border border-ink/20 px-4 py-2 text-sm font-bold"
      >
        <span>🤖 AI partner hunter</span>
        <span className={`relative h-6 w-11 rounded-full transition-colors ${companion ? "bg-neon-red" : "bg-ink/20"}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-ink transition-all ${companion ? "left-[22px]" : "left-0.5"}`} />
        </span>
      </button>
    )}
    </div>
  );
}

function SwipeBar({ pull, onSwipe }: { pull: number; onSwipe: () => void }) {
  const st = useRef<{ x: number; dir: number } | null>(null);
  const [off, setOff] = useState(0);
  return (
    <div className="absolute bottom-40 left-1/2 w-[min(70vw,360px)] -translate-x-1/2">
      <div className="mb-1 text-center text-xs font-bold">🪢 Swipe ⟷ to pull the drone down · {pull}/3</div>
      <div
        className="relative h-14 touch-none overflow-hidden rounded-full border-2 border-neon-yellow bg-void-glass"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); st.current = { x: e.clientX, dir: 0 }; }}
        onPointerMove={(e) => {
          const s = st.current; if (!s) return;
          const dx = e.clientX - s.x;
          setOff(Math.max(-60, Math.min(60, dx)));
          const dir = Math.sign(dx);
          if (Math.abs(dx) > 55 && dir !== s.dir) { onSwipe(); st.current = { x: e.clientX, dir }; }
        }}
        onPointerUp={() => { st.current = null; setOff(0); }}
        onPointerCancel={() => { st.current = null; setOff(0); }}
      >
        <div className="absolute inset-y-0 left-0 bg-neon-yellow/30 transition-all" style={{ width: `${(pull / 3) * 100}%` }} />
        <div className="pointer-events-none absolute left-1/2 top-1/2 flex h-10 w-16 items-center justify-center rounded-full bg-neon-yellow text-sm font-extrabold text-void" style={{ transform: `translate(calc(-50% + ${off}px), -50%)` }}>⟷</div>
      </div>
    </div>
  );
}
