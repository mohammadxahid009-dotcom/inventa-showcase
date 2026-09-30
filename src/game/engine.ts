// Lumen Hunt engine — written from scratch. Pure canvas, no giant offscreen buffers
// (walls are drawn per-frame for visible tiles only, which keeps mobile GPUs happy).

export const T = 40;
export const N = 31;

export type Role = "h" | "s";
export type Hud = {
  score: number;
  goal: number;
  level: number;
  scanCd: number;
  dashCd: number;
  decoyCd: number;
  seen: boolean;
  timeLeft: number | null;
  alarm: string;
  role: Role;
  mp: boolean;
  seekers: string;
};
export type EndInfo = { win: boolean; text: string; nextLevel?: boolean };

export interface NetOut {
  send(ev: string, payload: Record<string, unknown>): void;
}

type Ent = { x: number; y: number; r: number; vx: number; vy: number };
type TrailPt = { x: number; y: number; life: number };
type Seeker = Ent & {
  path: { x: number; y: number }[];
  think: number;
  scanCd: number;
  frozen: number;
  target: { x: number; y: number } | null;
  hue: string;
  trail: TrailPt[];
};
type Cube = { x: number; y: number; real: boolean; vis: number };
type Scan = { x: number; y: number; t: number; owner: "me" | "foe" | "ai"; hit: boolean; maxR?: number };
type Power = { x: number; y: number; k: "spd" | "cloak" | "scan" | "freeze" };
type Portal = { a: { x: number; y: number }; b: { x: number; y: number }; c: string };

const POW: Record<Power["k"], { e: string; c: string }> = {
  spd: { e: "⚡", c: "#ffd84a" },
  cloak: { e: "👻", c: "#c9a6ff" },
  scan: { e: "🔄", c: "#4fe3ff" },
  freeze: { e: "❄️", c: "#8fe8ff" },
};
const SCAN_DUR = 1.2;
const SCAN_MAX = 260;
const scanR = (s: Scan) => (s.t / SCAN_DUR) * (s.maxR ?? SCAN_MAX);

export function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genMaze(R: () => number) {
  const g = Array.from({ length: N }, () => Array<number>(N).fill(1));
  const st: [number, number][] = [[1, 1]];
  if (g[1]) g[1][1] = 0;
  while (st.length) {
    const current = st[st.length - 1];
    if (!current) break;
    const [x, y] = current;
    const d = ([[2, 0], [-2, 0], [0, 2], [0, -2]] as const).filter(([a, b]) => {
      const nx = x + a, ny = y + b;
      return nx > 0 && ny > 0 && nx < N - 1 && ny < N - 1 && g[ny]?.[nx] === 1;
    });
    if (!d.length) { st.pop(); continue; }
    const choice = d[Math.floor(R() * d.length)];
    if (!choice) continue;
    const [a, b] = choice;
    const middleRow = g[y + b / 2], nextRow = g[y + b];
    if (middleRow) middleRow[x + a / 2] = 0;
    if (nextRow) nextRow[x + a] = 0;
    st.push([x + a, y + b]);
  }
  // open some loops so it's not a pure tree
  for (let i = 0; i < 80; i++) {
    const x = 1 + Math.floor(R() * (N - 2)), y = 1 + Math.floor(R() * (N - 2));
    if (!g[y]?.[x] || x % 2 === y % 2) continue;
    if ((!g[y]?.[x - 1] && !g[y]?.[x + 1]) || (!g[y - 1]?.[x] && !g[y + 1]?.[x])) {
      if (g[y]) g[y][x] = 0;
    }
  }
  return g;
}

const ctr = (tx: number, ty: number) => ({ x: tx * T + T / 2, y: ty * T + T / 2 });

export class Game {
  cv: HTMLCanvasElement;
  mm: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  g: number[][] = [];
  me!: Ent & { rev: number; cloak: number; spd: number; moving: boolean };
  foe: (Ent & { tx: number; ty: number; moving: boolean; dash: boolean; rev: number; seen: boolean }) | null = null;
  seekers: Seeker[] = [];
  cubes: Cube[] = [];
  scans: Scan[] = [];
  pows: Power[] = [];
  portals: Portal[] = [];
  parts: { x: number; y: number; vx: number; vy: number; l: number; c: string }[] = [];
  trail: TrailPt[] = [];
  foeTrail: TrailPt[] = [];
  decoy: { x: number; y: number; t: number } | null = null;
  foeDecoy: { x: number; y: number } | null = null;
  score = 0;
  goal = 5;
  level = 1;
  diff = 1.12;
  hearR = 220;
  scanCd = 0;
  dashCd = 0;
  dashT = 0;
  decoyCd = 0;
  portalCd = 0;
  powT = 6;
  alarmW = 0;
  alarmA = 0;
  alarmT = 35;
  relocT = 45;
  timeLeft = 180;
  shake = 0;
  running = false;
  paused = false;
  muted = false;
  mp = false;
  role: Role = "h";
  net: NetOut | null = null;
  sendT = 0;
  keys: Record<string, boolean> = {};
  jx = 0;
  jy = 0;
  last = 0;
  raf = 0;
  hudT = 0;
  W = 0;
  H = 0;
  dpr = 1;
  z = 1;
  ac: AudioContext | null = null;
  onHud: (h: Hud) => void = () => {};
  onEnd: (e: EndInfo) => void = () => {};
  onToast: (t: string) => void = () => {};

  constructor(cv: HTMLCanvasElement, mm: HTMLCanvasElement) {
    this.cv = cv;
    this.mm = mm;
    this.ctx = cv.getContext("2d")!;
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  destroy() { cancelAnimationFrame(this.raf); }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.z = Math.max(0.7, Math.min(1.3, Math.min(this.W, this.H) / 520));
  }

  // ---------- audio ----------
  audio() {
    try {
      this.ac = this.ac || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      void this.ac.resume();
    } catch { /* no audio */ }
  }
  snd(f: number, d: number, type: OscillatorType = "sine", v = 0.06, f2?: number) {
    if (this.muted || !this.ac) return;
    const o = this.ac.createOscillator(), gn = this.ac.createGain(), t = this.ac.currentTime;
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    gn.gain.setValueAtTime(v, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(gn).connect(this.ac.destination); o.start(t); o.stop(t + d);
  }
  vib(p: number | number[]) { try { navigator.vibrate?.(p); } catch { /* */ } }

  // ---------- helpers ----------
  solid(x: number, y: number) {
    const tx = Math.floor(x / T), ty = Math.floor(y / T);
    return tx < 0 || ty < 0 || tx >= N || ty >= N || this.g[ty]?.[tx] === 1;
  }
  hit(x: number, y: number, r: number) {
    return this.solid(x - r, y - r) || this.solid(x + r, y - r) || this.solid(x - r, y + r) || this.solid(x + r, y + r);
  }
  mv(e: Ent, dx: number, dy: number) {
    if (!this.hit(e.x + dx, e.y, e.r)) e.x += dx;
    if (!this.hit(e.x, e.y + dy, e.r)) e.y += dy;
  }
  los(a: { x: number; y: number }, b: { x: number; y: number }) {
    const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.ceil(d / 10);
    for (let i = 1; i < n; i++) if (this.solid(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n)) return false;
    return true;
  }
  freeTile(R: () => number = Math.random, farFrom?: { x: number; y: number }, minD = 0) {
    for (let i = 0; i < 500; i++) {
      const tx = 1 + Math.floor(R() * (N - 2)), ty = 1 + Math.floor(R() * (N - 2));
      if (this.g[ty]?.[tx]) continue;
      const c = ctr(tx, ty);
      if (farFrom && Math.hypot(c.x - farFrom.x, c.y - farFrom.y) < minD) continue;
      return c;
    }
    return ctr(1, 1);
  }
  bfs(from: { x: number; y: number }, to: { x: number; y: number }) {
    const sx = Math.floor(from.x / T), sy = Math.floor(from.y / T), ex = Math.floor(to.x / T), ey = Math.floor(to.y / T);
    const prev = new Int32Array(N * N).fill(-1), q = [sy * N + sx];
    prev[sy * N + sx] = sy * N + sx;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      if (c === undefined) continue;
      const cx = c % N, cy = (c / N) | 0;
      if (cx === ex && cy === ey) break;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy, ni = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || this.g[ny]?.[nx] || prev[ni] !== -1) continue;
        prev[ni] = c; q.push(ni);
      }
    }
    const end = ey * N + ex;
    if (prev[end] === -1) return [];
    const path: { x: number; y: number }[] = [];
    for (let c = end; c !== sy * N + sx; c = prev[c] ?? sy * N + sx) path.unshift(ctr(c % N, (c / N) | 0));
    return path;
  }
  pushTrail(arr: TrailPt[], x: number, y: number, life = 0.55, max = 50) {
    const last = arr.at(-1);
    if (last && Math.hypot(x - last.x, y - last.y) < 4) return;
    arr.push({ x, y, life });
    if (arr.length > max) arr.shift();
  }
  decayTrail(arr: TrailPt[], dt: number) {
    for (const p of arr) p.life -= dt;
    return arr.filter((p) => p.life > 0);
  }
  burst(x: number, y: number, c: string, n = 16) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 7, s = 40 + Math.random() * 140;
      this.parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, l: 0.8, c });
    }
  }

  // ---------- setup ----------
  startSolo(diff: number, hear: number, level = 1) {
    this.audio();
    this.mp = false; this.role = "h"; this.net = null;
    this.diff = diff; this.hearR = hear; this.level = level;
    this.g = genMaze(Math.random);
    this.resetCommon(ctr(1, 1));
    const n = level >= 3 ? 3 : 2, hues = ["#ff3b4e", "#ff8a3b", "#c04bff"];
    for (let i = 0; i < n; i++) {
      const p = this.freeTile(Math.random, this.me, 520);
      this.seekers.push({ ...p, r: 12, vx: 0, vy: 0, path: [], think: 0, scanCd: 4 + i * 2, frozen: 0, target: null, hue: hues[i] ?? "#ff3b4e", trail: [] });
    }
    for (let i = 0; i < 2; i++) {
      const c = ["#4fe3ff", "#ff6bd6"][i] ?? "#4fe3ff";
      this.portals.push({ a: this.freeTile(), b: this.freeTile(), c });
    }
    this.spawnCubes();
    this.onToast(level > 1 ? `Level ${level} — the hunters are faster` : "Scan to reveal cubes. Only one is real!");
    this.begin();
  }

  startMp(seed: number, role: Role, net: NetOut) {
    this.audio();
    this.mp = true; this.role = role; this.net = net; this.level = 1;
    const R = rng(seed);
    this.g = genMaze(R);
    const hStart = ctr(1, 1), sStart = ctr(N - 2, N - 2);
    this.resetCommon(role === "h" ? hStart : sStart);
    const o = role === "h" ? sStart : hStart;
    this.foe = { ...o, r: 12, vx: 0, vy: 0, tx: o.x, ty: o.y, moving: false, dash: false, rev: 0, seen: false };
    this.timeLeft = 180;
    if (role === "h") this.spawnCubes();
    this.onToast(role === "h" ? "🔵 You are the HIDER — collect 5 cubes or survive 3:00" : "🔴 You are the SEEKER — catch the hider!");
    this.begin();
  }

  resetCommon(start: { x: number; y: number }) {
    this.me = { ...start, r: 11, vx: 0, vy: 0, rev: 0, cloak: 0, spd: 0, moving: false };
    this.foe = null; this.seekers = []; this.cubes = []; this.scans = []; this.pows = []; this.portals = []; this.parts = []; this.trail = []; this.foeTrail = [];
    this.decoy = null; this.foeDecoy = null; this.score = 0;
    this.scanCd = this.dashCd = this.dashT = this.decoyCd = this.portalCd = 0;
    this.powT = 6; this.alarmW = this.alarmA = 0; this.alarmT = 35; this.relocT = 45; this.shake = 0;
  }

  begin() {
    this.resize();
    this.running = true; this.paused = false; this.keys = {}; this.jx = this.jy = 0;
    this.last = performance.now();
  }

  stop() { this.running = false; }

  spawnCubes() {
    this.cubes = [];
    const real = Math.floor(Math.random() * 4);
    for (let i = 0; i < 4; i++) this.cubes.push({ ...this.freeTile(Math.random, this.me, 200), real: i === real, vis: 0 });
    this.relocT = 45;
  }

  // ---------- actions ----------
  doScan() {
    if (!this.running || this.paused || this.scanCd > 0) return;
    this.scanCd = this.role === "s" ? 5 : 3.5;
    const maxR = this.role === "s" ? 360 : 260;
    this.scans.push({ x: this.me.x, y: this.me.y, t: 0, owner: "me", hit: false, maxR });
    this.snd(520, 0.5, "sine", 0.05, 1400);
    if (this.mp) this.net?.send("scan", { x: this.me.x, y: this.me.y });
  }
  doDash() {
    if (!this.running || this.paused || this.dashCd > 0) return;
    this.dashCd = 4; this.dashT = 0.25;
    this.snd(300, 0.25, "square", 0.04, 900);
    this.burst(this.me.x, this.me.y, "#ffe14a", 10);
  }
  doDecoy() {
    if (!this.running || this.paused || this.decoyCd > 0 || (this.mp && this.role === "s")) return;
    this.decoyCd = 10;
    this.decoy = { x: this.me.x, y: this.me.y, t: 6 };
    this.snd(700, 0.3, "triangle", 0.05, 350);
    this.onToast("🪞 Decoy dropped");
    if (this.mp) this.net?.send("decoy", { x: this.me.x, y: this.me.y });
  }
  togglePause() { if (this.running) { this.paused = !this.paused; this.last = performance.now(); } }

  // ---------- network in ----------
  netIn(ev: string, p: Record<string, number | boolean>) {
    if (!this.running || !this.foe) return;
    if (ev === "st") {
      this.foe.tx = p['x'] as number; this.foe.ty = p['y'] as number;
      this.foe.moving = !!p['m']; this.foe.dash = !!p['d']; this.foe.seen = true;
      if (this.role === "s") this.score = (p['sc'] as number) ?? this.score;
    } else if (ev === "scan") {
      this.scans.push({ x: p['x'] as number, y: p['y'] as number, t: 0, owner: "foe", hit: false });
      if (Math.hypot((p['x'] as number) - this.me.x, (p['y'] as number) - this.me.y) < 600) this.snd(200, 0.6, "sawtooth", 0.03, 110);
    } else if (ev === "spot") {
      this.foe.rev = 5;
    } else if (ev === "decoy") {
      this.foeDecoy = { x: p['x'] as number, y: p['y'] as number };
      setTimeout(() => (this.foeDecoy = null), 6000);
    }
  }

  // ---------- update ----------
  update(dt: number) {
    const me = this.me;
    // cooldowns
    this.scanCd = Math.max(0, this.scanCd - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.decoyCd = Math.max(0, this.decoyCd - dt);
    this.portalCd = Math.max(0, this.portalCd - dt);
    this.dashT = Math.max(0, this.dashT - dt);
    me.rev = Math.max(0, me.rev - dt);
    me.cloak = Math.max(0, me.cloak - dt);
    me.spd = Math.max(0, me.spd - dt);
    this.shake = Math.max(0, this.shake - dt);

    // input
    let ix = this.jx, iy = this.jy;
    const k = this.keys;
    if (k['ArrowLeft'] || k['a']) ix -= 1;
    if (k['ArrowRight'] || k['d']) ix += 1;
    if (k['ArrowUp'] || k['w']) iy -= 1;
    if (k['ArrowDown'] || k['s']) iy += 1;
    const il = Math.hypot(ix, iy);
    if (il > 1) { ix /= il; iy /= il; }
    let sp = 230 * (me.spd > 0 ? 1.5 : 1);
    if (this.dashT > 0) sp *= 3;
    me.vx = ix * sp; me.vy = iy * sp;
    me.moving = il > 0.15;
    const oldX = me.x, oldY = me.y;
    const steps = Math.ceil((sp * dt) / 6) || 1;
    for (let i = 0; i < steps; i++) this.mv(me, (me.vx * dt) / steps, (me.vy * dt) / steps);
    for (const point of this.trail) point.life -= dt;
    this.trail = this.trail.filter((point) => point.life > 0);
    const lastPoint = this.trail.at(-1);
    if (Math.hypot(me.x - oldX, me.y - oldY) > 0.2 &&
        (!lastPoint || Math.hypot(me.x - lastPoint.x, me.y - lastPoint.y) >= 4)) {
      this.trail.push({ x: me.x, y: me.y, life: 0.55 });
      if (this.trail.length > 50) this.trail.shift();
    }

    // portals
    if (this.portalCd <= 0) for (const p of this.portals) {
      for (const [a, b] of [[p.a, p.b], [p.b, p.a]] as const) {
        if (Math.hypot(a.x - me.x, a.y - me.y) < 16) {
          me.x = b.x; me.y = b.y; this.trail = []; this.portalCd = 1.5;
          this.snd(900, 0.35, "sine", 0.05, 200); this.burst(b.x, b.y, p.c);
        }
      }
    }

    // scans
    for (const s of this.scans) {
      s.t += dt;
      const r = scanR(s);
      if (s.owner === "me" && this.role === "h") {
        for (const c of this.cubes) if (Math.hypot(c.x - s.x, c.y - s.y) < r) c.vis = Math.max(c.vis, 4);
      }
      if ((s.owner === "ai" || s.owner === "foe") && !s.hit && this.role === "h" && me.cloak <= 0) {
        const d = Math.hypot(me.x - s.x, me.y - s.y);
        if (Math.abs(d - r) < 14) {
          s.hit = true; me.rev = 5; this.shake = 0.35;
          this.onToast("👁 You've been spotted!"); this.snd(220, 0.35, "sawtooth", 0.08, 90); this.vib(80);
          if (this.mp) this.net?.send("spot", {});
        }
      }
    }
    this.scans = this.scans.filter((s) => s.t < SCAN_DUR);

    // particles
    for (const p of this.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.l -= dt; }
    this.parts = this.parts.filter((p) => p.l > 0);

    if (this.decoy) { this.decoy.t -= dt; if (this.decoy.t <= 0) this.decoy = null; }

    // cubes (hider only)
    if (this.role === "h") {
      for (const c of this.cubes) c.vis = Math.max(0, c.vis - dt);
      for (const c of [...this.cubes]) {
        if (Math.hypot(c.x - me.x, c.y - me.y) < 20) {
          if (c.real) {
            this.score++; this.burst(c.x, c.y, "#ffc93c", 24);
            this.snd(660, 0.15, "triangle", 0.08, 1320); this.vib(30);
            this.onToast(`✨ Real cube! ${this.score}/${this.goal}`);
            if (this.score >= this.goal) return this.finish(true, this.mp ? "You collected all 5 cubes!" : `Level ${this.level} cleared!`);
            this.spawnCubes();
            for (const s of this.seekers) s.think = 0;
          } else {
            this.cubes = this.cubes.filter((x) => x !== c);
            this.burst(c.x, c.y, "#777", 10); this.snd(150, 0.2, "square", 0.04);
            this.onToast("💨 Fake cube — a dud");
          }
          break;
        }
      }
    }

    if (this.mp) this.updateMp(dt); else this.updateSolo(dt);
  }

  updateSolo(dt: number) {
    const me = this.me;
    // timers
    this.relocT -= dt;
    if (this.relocT <= 0) { this.spawnCubes(); this.onToast("🔀 The cubes moved!"); this.alarmW = 3; }
    this.alarmT -= dt;
    if (this.alarmT <= 0 && this.alarmW <= 0 && this.alarmA <= 0) { this.alarmW = 3; this.alarmT = 30 + Math.random() * 15; }
    if (this.alarmW > 0) { this.alarmW -= dt; if (this.alarmW <= 0) { this.alarmA = 4; this.snd(880, 0.6, "sawtooth", 0.06, 440); this.vib([60, 40, 60]); } }
    if (this.alarmA > 0) this.alarmA -= dt;

    // power-ups
    this.powT -= dt;
    if (this.powT <= 0 && this.pows.length < 3) {
      const ks: Power["k"][] = ["spd", "cloak", "scan", "freeze"];
      this.pows.push({ ...this.freeTile(), k: ks[Math.floor(Math.random() * 4)] ?? "spd" });
      this.powT = 8;
    }
    for (const p of [...this.pows]) {
      if (Math.hypot(p.x - me.x, p.y - me.y) < 20) {
        this.pows = this.pows.filter((x) => x !== p);
        this.snd(880, 0.2, "triangle", 0.06, 1760); this.burst(p.x, p.y, POW[p.k].c);
        if (p.k === "spd") { me.spd = 5; this.onToast("⚡ Speed boost!"); }
        if (p.k === "cloak") { me.cloak = 5; this.onToast("👻 Cloaked — they can't see or hear you"); }
        if (p.k === "scan") { this.scanCd = 0; this.onToast("🔄 Scan recharged"); }
        if (p.k === "freeze") { for (const s of this.seekers) s.frozen = 3; this.onToast("❄️ Seekers frozen!"); }
      }
    }

    // seekers
    const boost = 1 + this.score * 0.06 + (this.level - 1) * 0.08;
    for (const s of this.seekers) {
      s.frozen = Math.max(0, s.frozen - dt);
      s.scanCd -= dt;
      s.think -= dt;
      const d = Math.hypot(me.x - s.x, me.y - s.y);
      const hidden = me.cloak > 0;
      const hears = !hidden && me.moving && d < (this.dashT > 0 ? this.hearR * 1.6 : this.hearR);
      const tracked = !hidden && (me.rev > 0 || this.alarmA > 0);
      let chasing = false;
      if (s.think <= 0) {
        s.think = 0.35;
        let tgt: { x: number; y: number } | null = null;
        if (this.decoy && Math.hypot(this.decoy.x - s.x, this.decoy.y - s.y) < 400) tgt = this.decoy;
        else if (hears || tracked) tgt = me;
        if (tgt) { s.target = { x: tgt.x, y: tgt.y }; s.path = this.bfs(s, tgt); }
        else if (!s.path.length) { s.target = null; s.path = this.bfs(s, this.freeTile()); }
      }
      chasing = !!s.target;
      if (s.scanCd <= 0 && d < 450) {
        s.scanCd = 6 / this.diff;
        this.scans.push({ x: s.x, y: s.y, t: 0, owner: "ai", hit: false, maxR: 360 });
      }
      if (s.frozen > 0) { s.trail = this.decayTrail(s.trail, dt); continue; }
      const ox = s.x, oy = s.y;
      let speed = (chasing ? 128 : 90) * this.diff * boost;
      if (chasing && d < 90) speed *= 1.25; // lunge
      let move = speed * dt;
      while (move > 0 && s.path.length) {
        const n = s.path[0];
        if (!n) break;
        const dx = n.x - s.x, dy = n.y - s.y, l = Math.hypot(dx, dy);
        if (l <= move) { s.x = n.x; s.y = n.y; s.path.shift(); move -= l; }
        else { s.x += (dx / l) * move; s.y += (dy / l) * move; move = 0; }
      }
      s.trail = this.decayTrail(s.trail, dt);
      if (Math.hypot(s.x - ox, s.y - oy) > 0.2) this.pushTrail(s.trail, s.x, s.y, 0.5, 40);
      if (d < s.r + me.r - 2) return this.finish(false, "A seeker caught you!");
    }
  }

  updateMp(dt: number) {
    const me = this.me, foe = this.foe!;
    foe.x += (foe.tx - foe.x) * Math.min(1, dt * 12);
    foe.y += (foe.ty - foe.y) * Math.min(1, dt * 12);
    foe.rev = Math.max(0, foe.rev - dt);
    this.foeTrail = this.decayTrail(this.foeTrail, dt);
    if (foe.moving) this.pushTrail(this.foeTrail, foe.x, foe.y, 0.5, 40);
    this.timeLeft -= dt;
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 1 / 15;
      this.net?.send("st", { x: Math.round(me.x), y: Math.round(me.y), m: me.moving, d: this.dashT > 0, sc: this.score });
    }
    if (this.role === "h") {
      if (this.timeLeft <= 0) return this.finish(true, "You survived 3 minutes!");
    } else {
      // seeker scan can reveal the hider on seeker's side too
      for (const s of this.scans) if (s.owner === "me" && !s.hit && Math.abs(Math.hypot(foe.x - s.x, foe.y - s.y) - scanR(s)) < 14) { s.hit = true; foe.rev = 5; }
      if (Math.hypot(foe.x - me.x, foe.y - me.y) < me.r + foe.r - 2) return this.finish(true, "You caught the hider!");
    }
  }

  foeVisible() {
    const f = this.foe;
    if (!f || !f.seen) return false;
    const d = Math.hypot(f.x - this.me.x, f.y - this.me.y);
    if (this.role === "h") return d < 340;
    return f.rev > 0;
  }

  finish(win: boolean, text: string) {
    if (!this.running) return;
    this.running = false;
    this.snd(win ? 880 : 180, 0.7, win ? "triangle" : "sawtooth", 0.09, win ? 1320 : 50);
    this.vib(win ? [40, 40, 40] : 200);
    if (this.mp) this.net?.send("end", { w: win ? this.role : this.role === "h" ? "s" : "h", text });
    this.onEnd({ win, text, nextLevel: !this.mp && win });
  }

  remoteEnd(winner: Role, text: string) {
    if (!this.running) return;
    this.running = false;
    const win = winner === this.role;
    this.snd(win ? 880 : 180, 0.7, win ? "triangle" : "sawtooth", 0.09, win ? 1320 : 50);
    this.onEnd({ win, text });
  }

  // ---------- render ----------
  loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    if (window.innerWidth !== this.W || window.innerHeight !== this.H) this.resize();
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (this.running && !this.paused) this.update(dt);
    if (this.g.length && this.me) this.draw(now);
    this.hudT -= dt;
    if (this.hudT <= 0 && this.me) { this.hudT = 0.1; this.emitHud(); }
  }

  emitHud() {
    this.onHud({
      score: this.score, goal: this.goal, level: this.level,
      scanCd: this.scanCd, dashCd: this.dashCd, decoyCd: this.decoyCd,
      seen: this.me.rev > 0, timeLeft: this.mp ? Math.max(0, this.timeLeft) : null,
      alarm: this.alarmA > 0 ? "🚨 ALARM — you are tracked!" : this.alarmW > 0 ? `🚨 Alarm in ${Math.ceil(this.alarmW)}s` : "",
      role: this.role, mp: this.mp,
      seekers: this.seekers.map((s) => (s.frozen > 0 ? "❄️" : s.target ? "🔴" : "⚪")).join(" "),
    });
  }

  ball(x: number, y: number, r: number, col: string, lite: string) {
    const c = this.ctx;
    c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    c.fillStyle = "#fff"; c.globalAlpha *= 0.55; c.beginPath(); c.arc(x - r * 0.28, y - r * 0.28, r * 0.3, 0, 7); c.fill(); c.globalAlpha /= 0.55;
  }

  draw(now: number) {
    const c = this.ctx, { W, H, dpr, z, me } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#05060e"; c.fillRect(0, 0, W, H);
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 24 : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 24 : 0;
    const ox = W / 2 - me.x * z + sx, oy = H / 2 - me.y * z + sy;
    c.setTransform(z * dpr, 0, 0, z * dpr, ox * dpr, oy * dpr);

    // visible tile range
    const x0 = Math.max(0, Math.floor(-ox / z / T) - 1), x1 = Math.min(N - 1, Math.ceil((W - ox) / z / T) + 1);
    const y0 = Math.max(0, Math.floor(-oy / z / T) - 1), y1 = Math.min(N - 1, Math.ceil((H - oy) / z / T) + 1);

    // floor
    c.fillStyle = "#0c0a22";
    c.fillRect(x0 * T, y0 * T, (x1 - x0 + 1) * T, (y1 - y0 + 1) * T);
    c.fillStyle = "rgba(140,120,255,0.14)";
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (this.g[y]?.[x]) { continue; }
      c.fillRect(x * T + T / 2 - 1, y * T + T / 2 - 1, 2, 2);
    }
    c.fillStyle = "#04030b";
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.g[y]?.[x]) c.fillRect(x * T, y * T, T, T);

    // neon wall edges — one batched path, two strokes
    c.beginPath();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!this.g[y]?.[x]) continue;
      const X = x * T, Y = y * T;
      if (y > 0 && !this.g[y - 1]?.[x]) { c.moveTo(X, Y); c.lineTo(X + T, Y); }
      if (y < N - 1 && !this.g[y + 1]?.[x]) { c.moveTo(X, Y + T); c.lineTo(X + T, Y + T); }
      if (x > 0 && !this.g[y]?.[x - 1]) { c.moveTo(X, Y); c.lineTo(X, Y + T); }
      if (x < N - 1 && !this.g[y]?.[x + 1]) { c.moveTo(X + T, Y); c.lineTo(X + T, Y + T); }
    }
    const grad = c.createLinearGradient(0, 0, N * T, N * T);
    grad.addColorStop(0, "#7b5cff"); grad.addColorStop(0.5, "#b04bff"); grad.addColorStop(1, "#ff4bd8");
    c.lineCap = "round";
    c.strokeStyle = grad;
    c.globalAlpha = 0.18; c.lineWidth = 9; c.stroke();
    c.globalAlpha = 1; c.lineWidth = 2.5; c.stroke();

    // The local player's short-lived path, drawn underneath the moving circles.
    c.save();
    c.fillStyle = this.role === "s" ? "#ff3b4e" : "#4f83ff";
    for (const point of this.trail) {
      const fade = point.life / 0.55;
      c.globalAlpha = fade * 0.42;
      c.beginPath(); c.arc(point.x, point.y, 3 + fade * 4, 0, Math.PI * 2); c.fill();
    }
    c.restore();

    // seeker trails
    for (const s of this.seekers) {
      c.save();
      c.fillStyle = s.hue;
      for (const p of s.trail) {
        const fade = p.life / 0.5;
        c.globalAlpha = fade * 0.38;
        c.beginPath(); c.arc(p.x, p.y, 2.5 + fade * 3.5, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }

    // opponent trail (only where the opponent is visible)
    if (this.mp && this.foe && this.foeVisible()) {
      c.save();
      c.fillStyle = this.role === "s" ? "#4f83ff" : "#ff3b4e";
      for (const p of this.foeTrail) {
        const fade = p.life / 0.5;
        c.globalAlpha = fade * 0.38;
        c.beginPath(); c.arc(p.x, p.y, 2.5 + fade * 3.5, 0, Math.PI * 2); c.fill();
      }
      c.restore();
    }

    // portals
    for (const p of this.portals) for (const t of [p.a, p.b]) {
      c.strokeStyle = p.c; c.lineWidth = 3;
      c.fillStyle = p.c + "33"; c.beginPath(); c.arc(t.x, t.y, 15, 0, 7); c.fill();
      c.beginPath(); c.arc(t.x, t.y, 15, now / 350, now / 350 + 4.4); c.stroke();
      c.beginPath(); c.arc(t.x, t.y, 8, -now / 200, -now / 200 + 4.4); c.stroke();
    }

    // scans — radar pulse: glow ring, dashed inner ring, rotating sweep, spokes, center flash
    for (const s of this.scans) {
      const r = scanR(s), prog = s.t / SCAN_DUR, a = 1 - prog * 0.75;
      const col = s.owner === "me" ? (this.role === "h" ? "79,131,255" : "255,70,90") : s.owner === "foe" ? (this.role === "h" ? "255,70,90" : "79,131,255") : "255,70,90";
      const rr = Math.max(1, r);
      c.save();
      // soft filled wave
      const fill = c.createRadialGradient(s.x, s.y, rr * 0.55, s.x, s.y, rr);
      fill.addColorStop(0, `rgba(${col},0)`);
      fill.addColorStop(1, `rgba(${col},${a * 0.14})`);
      c.fillStyle = fill; c.beginPath(); c.arc(s.x, s.y, rr, 0, 7); c.fill();
      // main glow ring
      c.strokeStyle = `rgba(${col},${a * 0.25})`; c.lineWidth = 12; c.beginPath(); c.arc(s.x, s.y, rr, 0, 7); c.stroke();
      c.strokeStyle = `rgba(${col},${a})`; c.lineWidth = 2.5; c.stroke();
      // dashed inner ring chasing the wavefront
      c.strokeStyle = `rgba(${col},${a * 0.7})`; c.lineWidth = 1.5;
      c.setLineDash([6, 10]); c.lineDashOffset = -now / 12;
      c.beginPath(); c.arc(s.x, s.y, Math.max(1, rr * 0.72), 0, 7); c.stroke();
      c.setLineDash([]);
      // rotating sweep arcs on the wavefront
      c.lineWidth = 4; c.lineCap = "round";
      for (let i = 0; i < 3; i++) {
        const ang = now / 260 + (i * Math.PI * 2) / 3;
        c.strokeStyle = `rgba(${col},${a * (0.9 - i * 0.25)})`;
        c.beginPath(); c.arc(s.x, s.y, rr, ang, ang + 0.5); c.stroke();
      }
      // spokes
      c.lineWidth = 1; c.strokeStyle = `rgba(${col},${a * 0.35})`;
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 + now / 900;
        c.beginPath();
        c.moveTo(s.x + Math.cos(ang) * rr * 0.25, s.y + Math.sin(ang) * rr * 0.25);
        c.lineTo(s.x + Math.cos(ang) * rr * 0.9, s.y + Math.sin(ang) * rr * 0.9);
        c.stroke();
      }
      // center flash early in the pulse
      if (prog < 0.3) {
        c.fillStyle = `rgba(255,255,255,${(0.3 - prog) * 2})`;
        c.beginPath(); c.arc(s.x, s.y, 6 + prog * 30, 0, 7); c.fill();
      }
      c.restore();
    }

    // cubes
    for (const cb of this.cubes) {
      if (cb.vis <= 0) continue;
      c.save(); c.globalAlpha = Math.min(1, cb.vis / 0.6); c.translate(cb.x, cb.y); c.rotate(now / 700);
      c.fillStyle = "rgba(255,201,60,0.3)"; c.fillRect(-14, -14, 28, 28);
      c.fillStyle = "#ffc93c"; c.fillRect(-9, -9, 18, 18);
      c.fillStyle = "#fff3b0"; c.fillRect(-5, -5, 10, 10);
      c.restore();
    }

    // power-ups
    c.font = "16px system-ui"; c.textAlign = "center"; c.textBaseline = "middle";
    for (const p of this.pows) {
      const b = 1 + 0.12 * Math.sin(now / 180), P = POW[p.k];
      c.fillStyle = P.c + "44"; c.strokeStyle = P.c; c.lineWidth = 2;
      c.beginPath(); c.arc(p.x, p.y, 14 * b, 0, 7); c.fill(); c.stroke();
      c.fillStyle = "#fff"; c.fillText(P.e, p.x, p.y + 1);
    }

    // decoys
    if (this.decoy) { c.globalAlpha = 0.5 + 0.2 * Math.sin(now / 120); this.ball(this.decoy.x, this.decoy.y, 11, "#4f83ff", "#bcd4ff"); c.globalAlpha = 1; }
    if (this.role === "s" && this.foeDecoy && Math.hypot(this.foeDecoy.x - me.x, this.foeDecoy.y - me.y) < 340) this.ball(this.foeDecoy.x, this.foeDecoy.y, 11, "#4f83ff", "#bcd4ff");

    // particles
    for (const p of this.parts) { c.globalAlpha = Math.max(0, p.l); c.fillStyle = p.c; c.beginPath(); c.arc(p.x, p.y, 2.4, 0, 7); c.fill(); }
    c.globalAlpha = 1;

    // seekers
    for (const s of this.seekers) {
      c.globalAlpha = s.frozen > 0 ? 0.6 : 1;
      this.ball(s.x, s.y, s.r, s.hue, "#ffb0b8");
      c.globalAlpha = 1;
      if (s.frozen > 0) { c.strokeStyle = "#8fe8ff"; c.lineWidth = 2; c.beginPath(); c.arc(s.x, s.y, s.r + 7, 0, 7); c.stroke(); }
    }

    // opponent
    if (this.mp && this.foe && this.foeVisible()) {
      const f = this.foe;
      if (this.role === "s") this.ball(f.x, f.y, f.r, "#4f83ff", "#bcd4ff");
      else this.ball(f.x, f.y, f.r, "#ff3b4e", "#ff9aa5");
    }

    // me
    c.globalAlpha = me.cloak > 0 ? 0.4 : 1;
    if (this.role === "s") this.ball(me.x, me.y, me.r, "#ff3b4e", "#ff9aa5");
    else this.ball(me.x, me.y, me.r, "#4f83ff", "#bcd4ff");
    c.globalAlpha = 1;
    if (me.rev > 0) { c.strokeStyle = "rgba(255,80,100,.8)"; c.lineWidth = 2; c.beginPath(); c.arc(me.x, me.y, me.r + 9 + 3 * Math.sin(now / 120), 0, 7); c.stroke(); }

    // danger vignette
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    let danger = 0;
    for (const s of this.seekers) danger = Math.max(danger, 1 - Math.hypot(s.x - me.x, s.y - me.y) / 260);
    if (danger > 0 || this.alarmA > 0) {
      const v = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.7);
      const a = Math.min(0.6, danger * 0.5 + (this.alarmA > 0 ? 0.25 : 0));
      v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(${this.alarmA > 0 ? "255,40,60" : "160,0,30"},${a})`);
      c.fillStyle = v; c.fillRect(0, 0, W, H);
    }
    this.drawMini();
  }

  drawMini() {
    const m = this.mm, c = m.getContext("2d");
    if (!c) return;
    const S = m.width / (N * T), k = m.width / N;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#07061a"; c.fillRect(0, 0, m.width, m.height);
    c.fillStyle = "#3a2c7a";
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (this.g[y]?.[x]) c.fillRect(x * k, y * k, k + 0.3, k + 0.3);
    const dot = (x: number, y: number, col: string, r = 2.6) => { c.fillStyle = col; c.beginPath(); c.arc(x * S, y * S, r, 0, 7); c.fill(); };
    for (const p of this.portals) { dot(p.a.x, p.a.y, p.c, 2); dot(p.b.x, p.b.y, p.c, 2); }
    for (const p of this.pows) dot(p.x, p.y, POW[p.k].c, 2);
    for (const cb of this.cubes) if (cb.vis > 0) dot(cb.x, cb.y, "#ffc93c", 2.4);
    for (const s of this.seekers) dot(s.x, s.y, s.hue);
    if (this.mp && this.foe && this.foeVisible()) dot(this.foe.x, this.foe.y, this.role === "s" ? "#7fb0ff" : "#ff3b4e");
    dot(this.me.x, this.me.y, this.role === "s" ? "#ff6b7b" : "#7fb0ff", 3.2);
  }
}
