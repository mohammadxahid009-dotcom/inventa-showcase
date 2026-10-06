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
  hunt: boolean;
  seekers: string;
  weapon: "missile" | "rain" | "mini" | null;
  aiming: boolean;
  lock: number;
  ammo: number;
  hp: number;
  droneLock: number;
  drones: number;
  ropeAvail: boolean;
  roped: boolean;
  pull: number;
  shock: { on: boolean; ready: boolean; charge: number; genCd: number; near: boolean };
  hiderHp: number;
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
  hp?: number;
};
type Cube = { x: number; y: number; real: boolean; vis: number };
type Scan = { x: number; y: number; t: number; owner: "me" | "foe" | "ai"; hit: boolean; maxR?: number; shock?: boolean; hits?: object[] };
type Power = { x: number; y: number; k: "spd" | "cloak" | "scan" | "freeze" | "radar" | "track" | "missile" | "rain" | "mini" | "drone"; id?: number };
type Portal = { a: { x: number; y: number }; b: { x: number; y: number }; c: string };

const POW: Record<Power["k"], { e: string; c: string }> = {
  spd: { e: "⚡", c: "#ffd84a" },
  cloak: { e: "👻", c: "#c9a6ff" },
  scan: { e: "🔄", c: "#4fe3ff" },
  freeze: { e: "❄️", c: "#8fe8ff" },
  radar: { e: "📡", c: "#ff5a6e" },
  track: { e: "👣", c: "#ffa24a" },
  missile: { e: "🚀", c: "#ff7a2f" },
  rain: { e: "🌧️", c: "#ffe14a" },
  drone: { e: "🛸", c: "#ff4fd8" },
  mini: { e: "🚀🚀", c: "#ff4f6e" },
};
type Drone = { x: number; y: number; vx: number; vy: number; side: number; ph: number; orb: number; alt: number; pull: number; dead: boolean; sx: number; sy: number; st: number };
const isWeapon = (k: Power["k"]) => k === "missile" || k === "rain" || k === "mini";
const RAIN_DMG = 1 / 75; // 25 bullets = 1/3 health
const MISSILE_DMG = 1 / 3;
const MINI_DMG = 1 / 12; // 4 mini missiles = 1/3 health
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
  decoy: { x: number; y: number; t: number; path: { x: number; y: number }[]; trail: TrailPt[]; spd?: number } | null = null;
  foeDecoy: { x: number; y: number; t: number; path: { x: number; y: number }[]; trail: TrailPt[]; spd?: number } | null = null;
  companion = false;
  foeCloak = false;
  hunt = false;
  hiders: (Seeker & { rev: number; decoyCd: number })[] = [];
  powR: () => number = Math.random;
  powId = 0;
  frozenMe = 0;
  trackT = 0;
  prints: { x: number; y: number; a: number; life: number }[] = [];
  printD = 0;
  heart = 0;
  score = 0;
  goal = 5;
  level = 1;
  diff = 1.12;
  hearR = 220;
  scanCd = 0;
  mySpd = 220;
  // hider weapons
  weapon: "missile" | "rain" | "mini" | null = null;
  exit: { x: number; y: number } | null = null;
  coins: Uint8Array = new Uint8Array(N * N);
  coinsSet = false;
  gen: { x: number; y: number } | null = null;
  genCd = 0; genHp = 1; shockCharge = 0; shockReady = false; zapCache: { k: number; bolts: { pts: [number, number][]; w: number; a: number }[] } | null = null;
  hiderHp = 1; foeHiderHp = 1;
  hitStop = 0;
  zap: { fx: number; fy: number; tx: number; ty: number; t: number } | null = null;
  dark: { x: number; y: number; r: number; t: number } | null = null;
  aiming = false;
  aim = { x: 0, y: 0 };
  lock = 0;
  lockId: string | null = null;
  ammo = 0;
  fireHeld = false;
  fireCd = 0;
  missiles: { x: number; y: number; d0: number; tgt: string; dmg: boolean; lx: number; ly: number; sm?: boolean; dl?: number }[] = [];
  bullets: { x: number; y: number; t: number; dmg: boolean }[] = [];
  myHp = 1;
  foeHp = 1;
  // hunter scout drones (simulated on the hider's device)
  drones: Drone[] = [];
  droneLock = 0;
  droneLost = 0;
  droneLife = 0;
  rope: { d: Drone; t: number; att: boolean } | null = null;
  droneView: { x: number; y: number; a: number }[] = [];
  droneLockView = 0;
  dashCd = 0;
  dashT = 0;
  decoyCd = 0;
  portalCd = 0;
  powT = 0;
  powBurst = 2;
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
    this.mp = false; this.hunt = false; this.role = "h"; this.net = null;
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
    this.onToast(level > 1 ? `Level ${level} — the hunters are faster` : "Scan to reveal keys. Collect 5 real keys, then reach the exit!");
    this.begin();
  }

  startHunt(diff: number, level = 1) {
    this.audio();
    this.mp = false; this.hunt = true; this.role = "s"; this.net = null;
    this.diff = diff; this.level = level;
    this.g = genMaze(Math.random);
    this.resetCommon(ctr(N - 2, N - 2));
    for (let i = 0; i < 2; i++) {
      const p = this.freeTile(Math.random, this.me, 560);
      this.hiders.push({ ...p, r: 11, vx: 0, vy: 0, path: [], think: 0, scanCd: 0, frozen: 0, target: null, hue: ["#4f83ff", "#3bd1ff"][i] ?? "#4f83ff", trail: [], rev: 0, decoyCd: 6 + i * 3 });
    }
    for (let i = 0; i < 2; i++) this.portals.push({ a: this.freeTile(), b: this.freeTile(), c: ["#4fe3ff", "#ff6bd6"][i] ?? "#4fe3ff" });
    this.gen = this.freeTile(Math.random, this.me, 300);
    this.timeLeft = Math.max(90, 150 - (level - 1) * 10);
    this.powT = 0; this.powBurst = 2;
    this.onToast("🔴 You are the HUNTER — catch both hiders before time runs out!");
    this.begin();
  }

  updateHunt(dt: number) {
    const me = this.me;
    this.updatePowers(dt);
    this.timeLeft -= dt;
    for (const sc of this.scans) if (sc.owner === "me") for (const h of [...this.hiders])
      if (Math.abs(Math.hypot(h.x - sc.x, h.y - sc.y) - scanR(sc)) < 16) {
        h.rev = 5;
        if (sc.shock && sc.hits && !sc.hits.includes(h)) {
          sc.hits.push(h);
          this.triggerZap({ x: sc.x, y: sc.y }, h, scanR(sc));
          h.hp = (h.hp ?? 1) - 0.2; h.frozen = Math.max(h.frozen, 1.2);
          if (h.hp <= 0.001) {
            this.hiders = this.hiders.filter((x) => x !== h); this.foeDecoy = null; this.score++;
            if (!this.hiders.length) return this.finish(true, `Level ${this.level} cleared — you caught them all!`);
            this.onToast("⚡ Hider electrocuted! One left…");
          } else this.onToast("⚡ Direct hit! Hider -1/5 health");
        }
      }
    const sp = (1 + (this.level - 1) * 0.07) * this.diff;
    let nearest = Infinity;
    for (const h of [...this.hiders]) {
      h.frozen = Math.max(0, h.frozen - dt); h.rev = Math.max(0, h.rev - dt);
      h.think -= dt; h.decoyCd -= dt;
      const d = Math.hypot(h.x - me.x, h.y - me.y);
      if (h.rev <= 0) nearest = Math.min(nearest, d);
      const alert = d < (me.moving ? (this.dashT > 0 ? 380 : 280) : 150);
      if (h.think <= 0) {
        h.think = alert ? 0.4 : 1.2;
        if (alert) {
          let best = h.path.at(-1) ?? { x: h.x, y: h.y }, bd = -1;
          for (let i = 0; i < 6; i++) {
            const t = this.freeTile(Math.random, h, 160);
            const sc = Math.hypot(t.x - me.x, t.y - me.y) - Math.hypot(t.x - h.x, t.y - h.y) * 0.4;
            if (sc > bd) { bd = sc; best = t; }
          }
          h.path = this.bfs(h, best); h.target = me;
          if (h.decoyCd <= 0 && d < 220) {
            h.decoyCd = 12;
            const tg = this.freeTile(Math.random, h, 300);
            this.foeDecoy = { x: h.x, y: h.y, t: 4, path: this.bfs(h, tg), trail: [], spd: 255 * sp };
          }
        } else if (!h.path.length) { h.target = null; h.path = this.bfs(h, this.freeTile(Math.random, h, 120)); }
      }
      if (h.frozen > 0) continue;
      const ox = h.x, oy = h.y;
      let move = (h.target ? 255 : 110) * sp * dt;
      while (move > 0 && h.path.length) {
        const n = h.path[0]!;
        const dx = n.x - h.x, dy = n.y - h.y, l = Math.hypot(dx, dy);
        if (l <= move) { h.x = n.x; h.y = n.y; h.path.shift(); move -= l; }
        else { h.x += (dx / l) * move; h.y += (dy / l) * move; move = 0; }
      }
      const moved = Math.hypot(h.x - ox, h.y - oy) > 0.2;
      h.trail = this.decayTrail(h.trail, dt);
      if (moved) this.pushTrail(h.trail, h.x, h.y, 0.5, 40);
      const lp = this.prints.at(-1);
      if (moved && this.trackT > 0 && (!lp || Math.hypot(lp.x - h.x, lp.y - h.y) > 18))
        this.prints.push({ x: h.x, y: h.y, a: Math.atan2(h.y - oy, h.x - ox), life: 5 });
      if (d < h.r + me.r - 2) {
        this.hiders = this.hiders.filter((x) => x !== h);
        this.foeDecoy = null; h.path = [];
        this.burst(h.x, h.y, h.hue, 24); this.snd(1200, 0.3, "triangle", 0.07, 600); this.vib([80]);
        this.score++;
        if (!this.hiders.length) return this.finish(true, `Level ${this.level} cleared — you caught them all!`);
        this.onToast("🎯 Caught one! One left…");
      }
    }
    this.foeDecoy = this.stepDecoy(this.foeDecoy, dt);
    for (const pr of this.prints) pr.life -= dt;
    this.prints = this.prints.filter((pr) => pr.life > 0);
    if (nearest < 420) {
      this.heart -= dt;
      if (this.heart <= 0) { this.heart = 0.35 + (nearest / 420) * 1.1; this.snd(70, 0.12, "sine", 0.08, 50); }
    }
    if (this.timeLeft <= 0) this.finish(false, "Time's up — the hiders escaped!");
  }

  hiderVisible(h: { x: number; y: number; rev: number }) {
    return h.rev > 0 || Math.hypot(h.x - this.me.x, h.y - this.me.y) < 240;
  }

  startMp(seed: number, role: Role, net: NetOut, companion = false) {
    this.audio();
    this.mp = true; this.hunt = false; this.role = role; this.net = net; this.level = 1;
    const R = rng(seed);
    this.g = genMaze(R);
    const hStart = ctr(1, 1), sStart = ctr(N - 2, N - 2);
    this.resetCommon(role === "h" ? hStart : sStart);
    const o = role === "h" ? sStart : hStart;
    this.foe = { ...o, r: 12, vx: 0, vy: 0, tx: o.x, ty: o.y, moving: false, dash: false, rev: 0, seen: false };
    this.timeLeft = 180;
    for (let i = 0; i < 2; i++) this.portals.push({ a: this.freeTile(R), b: this.freeTile(R), c: ["#4fe3ff", "#ff6bd6"][i] ?? "#4fe3ff" });
    this.powR = rng(seed ^ 0x5a5a5a); this.powId = 0; this.powT = 0; this.powBurst = 2;
    this.exit = this.freeTile(R, hStart, 400);
    this.gen = this.freeTile(R, sStart, 360);
    if (role === "h") this.spawnCubes();
    this.companion = companion;
    if (companion) {
      const cs = ctr(N - 2, 1);
      this.seekers.push({ ...cs, r: 12, vx: 0, vy: 0, path: [], think: 0, scanCd: 5, frozen: 0, target: null, hue: "#ff8a3b", trail: [] });
    }
    this.onToast(role === "h" ? (companion ? "🔵 You are the HIDER — watch out, the seeker brought an AI partner!" : "🔵 You are the HIDER — collect 5 keys and escape, or survive 3:00") : (companion ? "🔴 You are the SEEKER — your AI partner hunts with you!" : "🔴 You are the SEEKER — catch the hider!"));
    this.begin();
  }

  resetCommon(start: { x: number; y: number }) {
    this.me = { ...start, r: 11, vx: 0, vy: 0, rev: 0, cloak: 0, spd: 0, moving: false };
    this.foe = null; this.exit = null; this.coinsSet = false; this.gen = null; this.genHp = 1; this.zapCache = null; this.genCd = 0; this.shockCharge = 0; this.shockReady = false; this.hiderHp = 1; this.foeHiderHp = 1; this.hitStop = 0; this.zap = null; this.dark = null; this.seekers = []; this.cubes = []; this.scans = []; this.pows = []; this.portals = []; this.prints = []; this.hiders = []; this.frozenMe = 0; this.trackT = 0; this.heart = 0; this.parts = []; this.trail = []; this.foeTrail = [];
    this.decoy = null; this.foeDecoy = null; this.score = 0;
    this.weapon = null; this.aiming = false; this.lock = 0; this.lockId = null; this.ammo = 0; this.fireHeld = false; this.fireCd = 0;
    this.missiles = []; this.bullets = []; this.myHp = 1; this.foeHp = 1;
    this.drones = []; this.droneLock = 0; this.droneLost = 0; this.rope = null; this.droneView = []; this.droneLockView = 0;
    this.scanCd = this.dashCd = this.dashT = this.decoyCd = this.portalCd = 0;
    this.powT = 0; this.powBurst = 2; this.alarmW = this.alarmA = 0; this.alarmT = 35; this.relocT = 45; this.shake = 0;
  }

  begin() {
    this.resize();
    this.running = true; this.paused = false; this.keys = {}; this.jx = this.jy = 0;
    this.last = performance.now();
  }

  stop() { this.running = false; }

  spawnCubes() {
    this.cubes = [];
    if (!this.exit || !this.coinsSet) {
      this.coinsSet = true;
      if (!this.exit) this.exit = this.freeTile(Math.random, this.me, 400);
      this.coins = new Uint8Array(N * N);
      for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) if (!this.g[y]?.[x]) this.coins[y * N + x] = 1;
    }
    if (this.score >= this.goal) return;
    const real = Math.floor(Math.random() * 4);
    for (let i = 0; i < 4; i++) this.cubes.push({ ...this.freeTile(Math.random, this.me, 200), real: i === real, vis: 0 });
    this.relocT = 45;
  }

  // ---------- actions ----------
  doScan() {
    if (!this.running || this.paused || this.aiming || this.scanCd > 0) return;
    this.scanCd = this.role === "s" ? 3 : 3.5;
    const maxR = this.role === "s" ? 360 : 260;
    this.scans.push({ x: this.me.x, y: this.me.y, t: 0, owner: "me", hit: false, maxR });
    this.snd(520, 0.5, "sine", 0.05, 1400);
    if (this.mp) this.net?.send("scan", { x: this.me.x, y: this.me.y });
  }
  doShock() {
    if (!this.running || this.paused || this.aiming || this.role !== "s" || !this.shockReady) return;
    this.shockReady = false;
    this.scans.push({ x: this.me.x, y: this.me.y, t: 0, owner: "me", hit: false, maxR: 380, shock: true, hits: [] });
    this.snd(90, 0.6, "sawtooth", 0.07, 1800); this.snd(1400, 0.4, "square", 0.025, 300);
    this.shake = 0.25; this.vib([30, 20, 30]);
    this.burst(this.me.x, this.me.y, "#7fe6ff", 22);
    this.onToast("⚡ SHOCK wave released!");
    if (this.mp) this.net?.send("scan", { x: this.me.x, y: this.me.y, sh: 1 });
  }
  triggerZap(from: { x: number; y: number }, to: { x: number; y: number }, r: number) {
    this.hitStop = 0.12; this.zapCache = null;
    this.zap = { fx: from.x, fy: from.y, tx: to.x, ty: to.y, t: 1.3 };
    this.dark = { x: from.x, y: from.y, r: Math.max(r, Math.hypot(to.x - from.x, to.y - from.y) + 40), t: 1.6 };
    this.shake = 0.6; this.vib([60, 30, 120]);
    this.snd(60, 0.7, "sawtooth", 0.1, 30);
    for (let i = 0; i < 5; i++) this.snd(800 + Math.random() * 2400, 0.06 + Math.random() * 0.1, "square", 0.03, 200 + Math.random() * 600);
    this.burst(to.x, to.y, "#7fe6ff", 34); this.burst(to.x, to.y, "#ffffff", 14);
  }
  updateGen(dt: number) {
    this.genCd = Math.max(0, this.genCd - dt);
    if (this.role !== "s" || !this.gen || this.shockReady) return;
    const near = Math.hypot(this.gen.x - this.me.x, this.gen.y - this.me.y) < 90;
    if (near && this.genCd <= 0) {
      this.shockCharge += dt / 6;
      if (Math.random() < dt * 8) this.snd(1200 + Math.random() * 800, 0.04, "square", 0.012, 900);
      if (this.shockCharge >= 1) {
        this.shockCharge = 0; this.shockReady = true; this.genCd = 20;
        this.snd(440, 0.4, "triangle", 0.07, 1320); this.vib([40, 30, 40]);
        this.onToast("⚡ SHOCK ready! Hit the hider with it");
      }
    }
  }
  doDash() {
    if (!this.running || this.paused || this.aiming || this.dashCd > 0) return;
    this.dashCd = 4; this.dashT = 0.25;
    if (this.role === "h" && this.drones.length && this.droneLock > 0 && this.droneLock < 1) {
      this.droneLock = 0; this.droneLost = 1.8;
      for (const d of this.drones) { d.sx = this.me.x + (Math.random() - 0.5) * 420; d.sy = this.me.y + (Math.random() - 0.5) * 420; d.st = 1.8; }
      this.onToast("💨 Dash! Drone lock broken");
    }
    this.snd(300, 0.25, "square", 0.04, 900);
    this.burst(this.me.x, this.me.y, "#ffe14a", 10);
  }
  doDecoy() {
    if (!this.running || this.paused || this.aiming || this.decoyCd > 0 || (this.mp && this.role === "s")) return;
    this.decoyCd = 10;
    const tgt = this.freeTile(Math.random, this.me, 360);
    // match how fast the hider has actually been travelling (walls, joystick tilt, etc.)
    const ds = Math.round(Math.min(310 * (this.me.spd > 0 ? 1.5 : 1), Math.max(150, this.mySpd)));
    this.decoy = { x: this.me.x, y: this.me.y, t: 4, path: this.bfs(this.me, tgt), trail: [], spd: ds };
    this.snd(700, 0.3, "triangle", 0.05, 350);
    this.onToast("🪞 Decoy dropped");
    if (this.mp) this.net?.send("decoy", { x: this.me.x, y: this.me.y, tx: tgt.x, ty: tgt.y, s: ds });
  }
  // ---------- scout drones ----------
  spawnDrones(from: { x: number; y: number }) {
    if (this.role !== "h") return;
    this.drones = [-1, 1].map((side) => ({
      x: from.x + side * 30, y: from.y, vx: 0, vy: 0, side, ph: Math.random() * 6, orb: Math.random() * 6, alt: 1,
      pull: 0, dead: false, sx: this.me.x, sy: this.me.y, st: 0,
    }));
    this.droneLife = 24; this.droneLock = 0; this.droneLost = 0; this.rope = null;
    this.onToast("🛸 Scout drones launched — they're hunting you!");
    this.snd(500, 0.6, "sawtooth", 0.04, 1200); this.vib([40, 30, 40]);
  }
  nearDrone(maxD: number) {
    let best: Drone | null = null, bd = maxD;
    for (const d of this.drones) {
      if (d.dead) continue;
      const dd = Math.hypot(d.x - this.me.x, d.y - this.me.y);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  doRope() {
    if (!this.running || this.paused || this.rope) return;
    const d = this.nearDrone(120);
    if (!d) return;
    this.rope = { d, t: 0, att: false };
    this.snd(600, 0.2, "triangle", 0.05, 300);
  }
  swipeRope() {
    const r = this.rope;
    if (!r || !r.att || !this.running) return;
    const d = r.d;
    d.pull++; d.vx = d.vy = 0;
    this.shake = 0.18; this.vib(35); this.snd(180 + d.pull * 60, 0.15, "square", 0.05, 90);
    this.burst(d.x, d.y - 55 * d.alt, "#ff4fd8", 6);
    if (d.pull >= 3) { d.alt = 0.15; d.dead = true; this.rope = null; this.onToast("💥 Drone slammed into the ground!"); }
    else this.onToast(d.pull === 1 ? "🪢 It's dropping — keep swiping!" : "🪢 Almost down — one more!");
  }
  updateDrones(dt: number) {
    if (!this.drones.length) { this.droneLock = 0; return; }
    const me = this.me;
    this.droneLife -= dt;
    this.droneLost = Math.max(0, this.droneLost - dt);
    if (this.droneLife <= 0) {
      for (const d of this.drones) this.burst(d.x, d.y, "#ff4fd8", 10);
      this.drones = []; this.rope = null; this.droneLock = 0;
      this.onToast("🛸 Drones ran out of power");
      return;
    }
    const hidden = me.cloak > 0;
    let detect = false;
    for (const d of [...this.drones]) {
      if (d.dead) {
        d.alt -= dt * 1.6;
        if (d.alt <= 0) {
          this.burst(d.x, d.y, "#ff4fd8", 30); this.burst(d.x, d.y, "#ffb347", 16);
          this.snd(90, 0.5, "sawtooth", 0.08, 40); this.shake = 0.3;
          this.drones = this.drones.filter((x) => x !== d);
        }
        continue;
      }
      d.ph += dt;
      const roped = this.rope?.d === d && this.rope.att;
      const dist = Math.hypot(d.x - me.x, d.y - me.y);
      if (roped) {
        const tgtAlt = 1 - d.pull * 0.36;
        d.alt += (tgtAlt - d.alt) * Math.min(1, dt * 7);
        // tethered: struggles against the rope, slowly dragged toward the hider
        d.vx += (me.x - d.x) * 0.8 * dt + Math.sin(d.ph * 9) * 40 * dt;
        d.vy += (me.y - d.y) * 0.8 * dt + Math.cos(d.ph * 7) * 40 * dt;
        d.vx *= 0.9; d.vy *= 0.9;
        d.x += d.vx * dt; d.y += d.vy * dt;
        continue;
      }
      let tx: number, ty: number, vmax = 250;
      if (this.droneLost > 0 || hidden) {
        // searching: sweep random points around where the hider might be
        d.st -= dt;
        if (d.st <= 0 || Math.hypot(d.sx - d.x, d.sy - d.y) < 30) {
          d.st = 1.4 + Math.random();
          const a = Math.random() * 7, rr = 120 + Math.random() * 260;
          d.sx = me.x + Math.cos(a) * rr; d.sy = me.y + Math.sin(a) * rr;
        }
        tx = d.sx; ty = d.sy; vmax = 190;
      } else if (dist > 260) {
        // flank approach: each drone swings in from its own side
        const a = Math.atan2(me.y - d.y, me.x - d.x) + d.side * Math.PI / 2;
        const off = Math.min(220, dist * 0.45);
        tx = me.x + Math.cos(a) * off + Math.sin(d.ph * 1.7) * 40;
        ty = me.y + Math.sin(a) * off + Math.cos(d.ph * 1.3) * 40;
        d.orb = Math.atan2(d.y - me.y, d.x - me.x);
      } else {
        // close: circle the hider from opposite sides, weaving in and out
        d.orb += d.side * (0.9 + 0.4 * Math.sin(d.ph * 0.7)) * dt;
        const rr = 95 + 45 * Math.sin(d.ph * 1.9 + d.side);
        tx = me.x + Math.cos(d.orb) * rr; ty = me.y + Math.sin(d.orb) * rr;
        vmax = 280;
      }
      const dx = tx - d.x, dy = ty - d.y, l = Math.hypot(dx, dy) || 1;
      const wantX = (dx / l) * Math.min(vmax, l * 3), wantY = (dy / l) * Math.min(vmax, l * 3);
      d.vx += (wantX - d.vx) * Math.min(1, dt * 3.2);
      d.vy += (wantY - d.vy) * Math.min(1, dt * 3.2);
      d.x = Math.min((N - 1) * T, Math.max(T, d.x + d.vx * dt));
      d.y = Math.min((N - 1) * T, Math.max(T, d.y + d.vy * dt));
      d.alt += (1 - d.alt) * dt * 0.5;
      if (!hidden && this.droneLost <= 0 && dist < 280) detect = true;
    }
    if (detect) this.droneLock += dt / 3.2; else this.droneLock = Math.max(0, this.droneLock - dt * 0.6);
    if (this.droneLock >= 1) {
      this.droneLock = 0; this.droneLost = 3;
      me.rev = 5; this.frozenMe = Math.max(this.frozenMe, 1.2); this.shake = 0.6;
      this.burst(me.x, me.y, "#ff4fd8", 34); this.snd(120, 0.6, "sawtooth", 0.09, 60); this.vib([100, 50, 100]);
      this.onToast("💥 Drone strike! You're revealed & stunned");
      if (this.mp) this.net?.send("spot", {});
    }
    const r = this.rope;
    if (r) {
      const rd = Math.hypot(r.d.x - me.x, r.d.y - me.y);
      if (r.d.dead || !this.drones.includes(r.d) || rd > 280) { this.rope = null; this.onToast("🪢 Rope snapped"); }
      else if (!r.att) { r.t += dt * 4; if (r.t >= 1) { r.att = true; this.onToast("🪢 Hooked! Swipe the bar 3 times"); this.vib(40); } }
    }
  }
  boltPts(x1: number, y1: number, x2: number, y2: number, disp: number) {
    let pts: [number, number][] = [[x1, y1], [x2, y2]];
    for (let it = 0; it < 6; it++) {
      const nx: [number, number][] = [pts[0]!];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
        const l = Math.hypot(bx - ax, by - ay) || 1, o = (Math.random() - 0.5) * disp;
        nx.push([(ax + bx) / 2 + (-(by - ay) / l) * o, (ay + by) / 2 + ((bx - ax) / l) * o], [bx, by]);
      }
      pts = nx; disp *= 0.55;
    }
    return pts;
  }
  strokeBolt(pts: [number, number][], w: number, a: number) {
    const c = this.ctx;
    c.beginPath(); c.moveTo(pts[0]![0], pts[0]![1]);
    for (const [x, y] of pts) c.lineTo(x, y);
    c.strokeStyle = `rgba(40,120,255,${0.18 * a})`; c.lineWidth = w * 7; c.stroke();
    c.strokeStyle = `rgba(60,160,255,${0.35 * a})`; c.lineWidth = w * 3.5; c.stroke();
    c.strokeStyle = `rgba(120,230,255,${0.9 * a})`; c.lineWidth = w * 1.6; c.stroke();
    c.strokeStyle = `rgba(255,255,255,${a})`; c.lineWidth = w * 0.6; c.stroke();
  }
  drawZap(z: { fx: number; fy: number; tx: number; ty: number; t: number }, now: number) {
    const c = this.ctx, k = z.t / 1.3;
    const flick = 0.55 + 0.45 * (Math.sin(now / 23) > -0.3 ? 1 : 0.2);
    const a = Math.min(1, k * 2.2) * flick;
    const len = Math.hypot(z.tx - z.fx, z.ty - z.fy);
    // travel: bolt races from hunter to hider in the first 0.15s
    const grow = Math.min(1, (1.3 - z.t) / 0.15);
    const ex = z.fx + (z.tx - z.fx) * grow, ey = z.fy + (z.ty - z.fy) * grow;
    c.save(); c.lineCap = "round"; c.lineJoin = "round"; c.globalCompositeOperation = "lighter";
    const key = Math.floor(now / 60) * 10 + (grow >= 1 ? 1 : 0);
    if (!this.zapCache || this.zapCache.k !== key || grow < 1) {
      const bolts: { pts: [number, number][]; w: number; a: number }[] = [];
      const main = this.boltPts(z.fx, z.fy, ex, ey, Math.min(90, len * 0.35));
      bolts.push({ pts: main, w: 2.6, a: 1 });
      bolts.push({ pts: this.boltPts(z.fx, z.fy, ex, ey, Math.min(120, len * 0.45)), w: 1.1, a: 0.6 });
      for (let i = 0; i < 2; i++) {
        const p = main[Math.floor(main.length * (0.2 + Math.random() * 0.6))];
        if (!p) continue;
        const ang = Math.atan2(ey - z.fy, ex - z.fx) + (Math.random() - 0.5) * 2.2, fl = 20 + Math.random() * 50;
        bolts.push({ pts: this.boltPts(p[0], p[1], p[0] + Math.cos(ang) * fl, p[1] + Math.sin(ang) * fl, fl * 0.5), w: 0.8, a: 0.8 });
      }
      if (grow >= 1) {
        const ang = Math.random() * 7, fl = 16 + Math.random() * 24;
        bolts.push({ pts: this.boltPts(z.tx, z.ty, z.tx + Math.cos(ang) * fl, z.ty + Math.sin(ang) * fl, 12), w: 0.7, a: 1 });
      }
      this.zapCache = { k: key, bolts };
    }
    for (const b of this.zapCache.bolts) this.strokeBolt(b.pts, b.w, a * b.a);
    if (grow >= 1) {
      const rp = 1 - k;
      c.strokeStyle = `rgba(140,230,255,${(1 - rp) * 0.9})`; c.lineWidth = 3;
      c.beginPath(); c.arc(z.tx, z.ty, 10 + rp * 60, 0, 7); c.stroke();
      c.beginPath(); c.arc(z.tx, z.ty, 6 + rp * 30, 0, 7); c.stroke();
      const g = c.createRadialGradient(z.tx, z.ty, 0, z.tx, z.ty, 46);
      g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(0.3, `rgba(120,220,255,${a * 0.6})`); g.addColorStop(1, "rgba(40,120,255,0)");
      c.fillStyle = g; c.beginPath(); c.arc(z.tx, z.ty, 46, 0, 7); c.fill();
    }
    const g2 = c.createRadialGradient(z.fx, z.fy, 0, z.fx, z.fy, 30);
    g2.addColorStop(0, `rgba(255,255,255,${a * 0.9})`); g2.addColorStop(1, "rgba(60,160,255,0)");
    c.fillStyle = g2; c.beginPath(); c.arc(z.fx, z.fy, 30, 0, 7); c.fill();
    c.restore();
  }
  drawGen(x: number, y: number, now: number) {
    const c = this.ctx, live = this.genCd <= 0, pu = 0.5 + 0.5 * Math.sin(now / 260);
    c.save();
    // field ring
    if (this.role === "s") { c.strokeStyle = live ? `rgba(255,60,90,${0.18 + 0.12 * pu})` : "rgba(120,120,160,.15)"; c.lineWidth = 2; c.setLineDash([5, 8]); c.lineDashOffset = -now / 40; c.beginPath(); c.arc(x, y, 90, 0, 7); c.stroke(); c.setLineDash([]); }
    // base
    c.fillStyle = "rgba(0,0,0,.5)"; c.beginPath(); c.ellipse(x, y + 10, 20, 7, 0, 0, 7); c.fill();
    c.fillStyle = "#2a2d3e"; c.beginPath(); c.ellipse(x, y + 5, 18, 8, 0, 0, 7); c.fill();
    c.fillStyle = "#4a4f66"; c.fillRect(x - 13, y - 4, 26, 9);
    c.fillStyle = "#1a1c28"; c.beginPath(); c.ellipse(x, y - 4, 13, 5, 0, 0, 7); c.fill();
    c.fillStyle = live ? "#ff3b4e" : "#55586e";
    for (let i = -1; i <= 1; i++) c.fillRect(x + i * 8 - 1.5, y + 1, 3, 2);
    // core dome
    c.shadowColor = live ? "#ff3b4e" : "#666"; c.shadowBlur = live ? 18 + 12 * pu : 4;
    const g = c.createRadialGradient(x - 3, y - 12, 1, x, y - 9, 10);
    g.addColorStop(0, live ? "#fff" : "#bbb"); g.addColorStop(0.35, live ? "#ff6b7e" : "#777"); g.addColorStop(1, live ? "#a0001c" : "#333");
    c.fillStyle = g; c.beginPath(); c.arc(x, y - 9, 9, 0, 7); c.fill();
    c.shadowBlur = 0;
    if (!live) { c.strokeStyle = "#ff3b4e"; c.lineWidth = 2.5; c.beginPath(); c.arc(x, y - 9, 14, -Math.PI / 2, -Math.PI / 2 + (1 - this.genCd / 20) * Math.PI * 2); c.stroke(); }
    // charging beam to the hunter
    if (live && this.role === "s" && !this.shockReady && Math.hypot(x - this.me.x, y - this.me.y) < 90) {
      c.lineCap = "round"; c.globalCompositeOperation = "lighter";
      this.strokeBolt(this.boltPts(x, y - 9, this.me.x, this.me.y, 18), 0.9, 0.7 + 0.3 * Math.random());
    }
    c.restore();
  }
  drawDrone(x: number, y: number, alt: number, now: number, hooked: boolean) {
    const c = this.ctx, h = 55 * alt;
    c.fillStyle = `rgba(0,0,0,${0.65 - 0.35 * alt})`; c.beginPath(); c.ellipse(x, y, 9 + 6 * alt, 3.5 + 2 * alt, 0, 0, 7); c.fill();
    c.save(); c.translate(x, y - h);
    c.shadowColor = "#ff4fd8"; c.shadowBlur = 14;
    c.strokeStyle = "#c9c9d8"; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(-11, -11); c.lineTo(11, 11); c.moveTo(11, -11); c.lineTo(-11, 11); c.stroke();
    for (const [rx, ry] of [[-11, -11], [11, -11], [-11, 11], [11, 11]] as const) {
      c.save(); c.translate(rx, ry); c.rotate(now / 30 * (rx * ry > 0 ? 1 : -1));
      c.fillStyle = "rgba(255,79,216,.35)"; c.beginPath(); c.ellipse(0, 0, 8, 2.5, 0, 0, 7); c.fill(); c.restore();
    }
    c.fillStyle = hooked ? "#ffb347" : "#2a1036"; c.beginPath(); c.arc(0, 0, 7, 0, 7); c.fill();
    c.fillStyle = Math.sin(now / 120) > 0 ? "#ff4fd8" : "#ff3b4e"; c.beginPath(); c.arc(0, 0, 3, 0, 7); c.fill();
    c.restore();
    // scan beam
    c.strokeStyle = `rgba(255,79,216,${0.18 + 0.12 * Math.sin(now / 200)})`; c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y, 30 + ((now / 8) % 50), 0, 7); c.stroke();
  }
  drawLockRing(x: number, y: number, lock: number, now: number) {
    const c = this.ctx;
    c.save(); c.shadowColor = "#ff4fd8"; c.shadowBlur = 12;
    c.strokeStyle = "rgba(255,79,216,.35)"; c.lineWidth = 2;
    c.beginPath(); c.arc(x, y, 26, 0, 7); c.stroke();
    c.strokeStyle = lock > 0.75 ? `rgba(255,59,78,${0.7 + 0.3 * Math.sin(now / 50)})` : "#ff4fd8"; c.lineWidth = 4;
    c.beginPath(); c.arc(x, y, 26, -Math.PI / 2, -Math.PI / 2 + lock * Math.PI * 2); c.stroke();
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + now / 400; c.beginPath(); c.moveTo(x + Math.cos(a) * 32, y + Math.sin(a) * 32); c.lineTo(x + Math.cos(a) * 40, y + Math.sin(a) * 40); c.stroke(); }
    c.restore();
  }
  // ---------- hider weapons ----------
  toggleAim() {
    if (!this.running || this.paused || !this.weapon || this.role !== "h") return;
    this.aiming = !this.aiming;
    this.fireHeld = false; this.lock = 0; this.lockId = null;
    if (this.aiming) { this.aim = { x: this.me.x, y: this.me.y }; this.snd(500, 0.15, "square", 0.04, 800); }
  }
  setFire(on: boolean) {
    if (!this.running || this.paused || !this.aiming) return;
    if (this.weapon === "missile") {
      if (!on) return;
      if (this.lock < 1 || !this.lockId) { this.onToast("🎯 Hold the circle on a hunter to lock on"); return; }
      const tg = this.ent(this.lockId);
      if (!tg) return;
      this.missiles.push({ x: this.me.x, y: this.me.y, d0: Math.max(60, Math.hypot(tg.x - this.me.x, tg.y - this.me.y)), tgt: this.lockId, dmg: true, lx: this.me.x, ly: this.me.y });
      if (this.mp) this.net?.send("mis", { x: Math.round(this.me.x), y: Math.round(this.me.y), t: this.lockId });
      this.snd(160, 0.8, "sawtooth", 0.07, 900); this.vib([40]);
      this.onToast("🚀 Missile away!");
      this.weapon = null; this.aiming = false; this.lock = 0; this.lockId = null;
    } else if (this.weapon === "mini") {
      if (!on) return;
      let best: { id: string; x: number; y: number } | null = null, bd = 60;
      for (const t of this.targets()) { const d = Math.hypot(t.x - this.aim.x, t.y - this.aim.y) - t.r; if (d < bd) { bd = d; best = t; } }
      if (!best) { this.onToast("🎯 Put the aim on a hunter first"); return; }
      for (let i = 0; i < 4; i++) {
        const ox = this.me.x + (Math.random() - 0.5) * 16, oy = this.me.y + (Math.random() - 0.5) * 16;
        this.missiles.push({ x: ox, y: oy, d0: Math.max(60, Math.hypot(best.x - ox, best.y - oy)), tgt: best.id, dmg: true, lx: ox, ly: oy, sm: true, dl: i * 0.15 });
        if (this.mp) this.net?.send("mis", { x: Math.round(ox), y: Math.round(oy), t: best.id, s: 1, d: i * 0.15 });
      }
      this.snd(240, 0.5, "sawtooth", 0.06, 1200); this.vib([20, 20, 20, 20]);
      this.onToast("🚀🚀 Mini missiles away!");
      this.weapon = null; this.aiming = false;
    } else this.fireHeld = on;
  }
  // hunter entity by id ("f" = human hunter, "cN" = AI seeker N), on either client
  ent(id: string): { x: number; y: number; r: number } | null {
    if (id === "f") return this.role === "h" ? this.foe : this.me;
    if (id === "g") return this.gen ? { x: this.gen.x, y: this.gen.y, r: 18 } : null;
    return this.seekers[Number(id.slice(1))] ?? null;
  }
  targets() {
    const out: { id: string; x: number; y: number; r: number }[] = [];
    if (this.role !== "h") return out;
    this.seekers.forEach((s, i) => out.push({ id: "c" + i, x: s.x, y: s.y, r: s.r }));
    if (this.mp && this.foe) out.push({ id: "f", x: this.foe.x, y: this.foe.y, r: this.foe.r });
    if (this.gen) out.push({ id: "g", x: this.gen.x, y: this.gen.y, r: 18 });
    return out;
  }
  hurt(id: string, amt: number, local: boolean) {
    if (local && this.mp) this.net?.send("dmg", { id, a: amt });
    const ko = (hp: number) => hp <= 0.001;
    if (id === "g") {
      if (!this.gen) return;
      this.genHp -= amt * 3; // one missile, 4 mini missiles or a full bullet rain destroys it
      if (ko(this.genHp)) {
        const g = this.gen; this.gen = null; this.shockCharge = 0;
        this.burst(g.x, g.y, "#ff3b4e", 50); this.burst(g.x, g.y, "#ffe14a", 30); this.burst(g.x, g.y, "#7fe6ff", 20);
        this.shake = Math.max(this.shake, 0.5); this.snd(55, 0.9, "sawtooth", 0.12, 25);
        this.onToast(this.role === "h" ? "💥 Generator destroyed — no more SHOCK!" : "💥 The hider destroyed your generator!");
      }
      return;
    }
    if (id === "f") {
      if (this.role === "h") {
        this.foeHp -= amt;
        if (ko(this.foeHp)) { this.foeHp = 1; if (this.foe) { this.burst(this.foe.x, this.foe.y, "#ff7a2f", 40); this.foe.rev = 3; } this.onToast("💥 Hunter knocked out — stunned 4s!"); }
      } else {
        this.myHp -= amt; this.shake = Math.max(this.shake, amt > 0.1 ? 0.5 : 0.12);
        if (ko(this.myHp)) { this.myHp = 1; this.frozenMe = 4; this.burst(this.me.x, this.me.y, "#ff7a2f", 40); this.onToast("💥 You were knocked out! Stunned 4s"); this.vib([200]); }
      }
      return;
    }
    const s = this.seekers[Number(id.slice(1))];
    if (!s) return;
    s.hp = (s.hp ?? 1) - amt;
    if (ko(s.hp)) { s.hp = 1; s.frozen = 4; s.path = []; this.burst(s.x, s.y, "#ff7a2f", 40); this.onToast(this.role === "h" ? "💥 Hunter knocked out — stunned 4s!" : "💥 Your AI partner was knocked out!"); }
  }
  updateWeapons(dt: number) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    if (this.aiming && this.weapon === "missile") {
      let best: string | null = null, bd = 34;
      for (const t of this.targets()) { const d = Math.hypot(t.x - this.aim.x, t.y - this.aim.y); if (d < bd + t.r) { bd = d; best = t.id; } }
      if (best && best === this.lockId) {
        const was = this.lock; this.lock = Math.min(1, this.lock + dt / 0.65);
        if (was < 1 && this.lock >= 1) { this.snd(1400, 0.15, "square", 0.05, 1800); this.vib([20]); }
      } else if (best) { this.lockId = best; this.lock = 0; }
      else { this.lock = Math.max(0, this.lock - dt * 2.5); if (this.lock <= 0) this.lockId = null; }
    }
    if (this.aiming && this.weapon === "rain" && this.fireHeld && this.fireCd <= 0 && this.ammo > 0) {
      this.fireCd = 1 / 12; this.ammo--;
      const a = Math.random() * 7, r = Math.random() * 20;
      const b = { x: this.aim.x + Math.cos(a) * r, y: this.aim.y + Math.sin(a) * r, t: 0.42, dmg: true };
      this.bullets.push(b);
      if (this.mp) this.net?.send("bul", { x: Math.round(b.x), y: Math.round(b.y) });
      this.snd(900 + Math.random() * 300, 0.06, "square", 0.025, 400);
      if (this.ammo <= 0) { this.weapon = null; this.aiming = false; this.fireHeld = false; this.onToast("🌧️ Out of bullets"); }
    }
    for (const m of [...this.missiles]) {
      const tg = this.ent(m.tgt);
      if (!tg) { this.missiles = this.missiles.filter((x) => x !== m); continue; }
      if (m.dl && m.dl > 0) { m.dl -= dt; if (m.dl <= 0) this.snd(700, 0.15, "square", 0.03, 1400); continue; }
      m.lx = m.x; m.ly = m.y;
      const dx = tg.x - m.x, dy = tg.y - m.y, l = Math.hypot(dx, dy), mv = (m.sm ? 860 : 720) * dt;
      if (Math.random() < 0.8) this.parts.push({ x: m.x, y: m.y - Math.sin(Math.min(1, 1 - l / m.d0) * Math.PI) * 70, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, l: 0.45, c: Math.random() < 0.5 ? "#ffb347" : "#ff5a2f" });
      if (l <= mv + tg.r) {
        this.missiles = this.missiles.filter((x) => x !== m);
        this.burst(tg.x, tg.y, "#ff7a2f", m.sm ? 14 : 36); this.burst(tg.x, tg.y, "#ffe14a", m.sm ? 8 : 18);
        this.snd(m.sm ? 140 : 90, m.sm ? 0.3 : 0.6, "sawtooth", m.sm ? 0.06 : 0.1, 30); this.shake = Math.max(this.shake, m.sm ? 0.15 : 0.3);
        if (m.dmg) this.hurt(m.tgt, m.sm ? MINI_DMG : MISSILE_DMG, true);
        continue;
      }
      m.x += (dx / l) * mv; m.y += (dy / l) * mv;
    }
    for (const b of [...this.bullets]) {
      b.t -= dt;
      if (b.t > 0) continue;
      this.bullets = this.bullets.filter((x) => x !== b);
      this.burst(b.x, b.y, "#ffe14a", 5);
      if (b.dmg) for (const t of this.targets()) if (Math.hypot(t.x - b.x, t.y - b.y) < t.r + 14) this.hurt(t.id, RAIN_DMG, true);
    }
  }

  togglePause() { if (this.running) { this.paused = !this.paused; this.last = performance.now(); } }

  // ---------- network in ----------
  netIn(ev: string, p: Record<string, number | boolean | string>) {
    if (!this.running || !this.foe) return;
    if (ev === "st") {
      this.foe.tx = p['x'] as number; this.foe.ty = p['y'] as number;
      this.foe.moving = !!p['m']; this.foe.dash = !!p['d']; this.foe.seen = true; this.foeCloak = !!p['ck'];
      if (this.role === "s") this.score = (p['sc'] as number) ?? this.score;
      if (this.role === "s") {
        const dr = Array.isArray(p['dr']) ? (p['dr'] as unknown as number[]) : [];
        this.droneView = [];
        for (let i = 0; i + 2 < dr.length; i += 3) this.droneView.push({ x: dr[i]!, y: dr[i + 1]!, a: dr[i + 2]! / 100 });
        this.droneLockView = typeof p['lk'] === "number" ? (p['lk'] as number) / 100 : 0;
      }
      const cp = this.seekers[0];
      if (this.role === "h" && cp && typeof p['cx'] === "number") cp.target = { x: p['cx'] as number, y: p['cy'] as number };
    } else if (ev === "scan") {
      this.scans.push({ x: p['x'] as number, y: p['y'] as number, t: 0, owner: "foe", hit: false, ...(p['sh'] ? { shock: true, maxR: 380 } : {}) });
      if (p['sh']) { this.onToast("⚡ The hunter released a SHOCK wave!"); this.vib([40]); }
      if (Math.hypot((p['x'] as number) - this.me.x, (p['y'] as number) - this.me.y) < 600) this.snd(200, 0.6, "sawtooth", 0.03, 110);
    } else if (ev === "shk") {
      const hx = p['x'] as number, hy = p['y'] as number;
      this.foe.x = hx; this.foe.y = hy; this.foe.rev = 5;
      this.foeHiderHp = Number(p['hp'] ?? this.foeHiderHp - 0.2);
      this.triggerZap(this.me, { x: hx, y: hy }, 380);
      this.onToast("⚡ Direct hit! Hider -1/5 health");
    } else if (ev === "spot") {
      this.foe.rev = 5;
    } else if (ev === "pow") {
      this.pows = this.pows.filter((x) => x.id !== p['id']);
      const k = p['k'];
      if (k === "freeze" && this.role === "s") { this.frozenMe = 3; for (const s of this.seekers) s.frozen = 3; this.onToast("❄️ The hider froze you!"); this.vib([80]); }
      if (k === "radar" && this.role === "h") { this.me.rev = 3; this.onToast("📡 The hunter pinged your location!"); this.vib([60, 40, 60]); }
      if (k === "track" && this.role === "h") this.onToast("👣 The hunter can see your footprints!");
      if (k === "drone" && this.role === "h") this.spawnDrones(this.foe);
    } else if (ev === "dmg") {
      this.hurt(String(p['id']), Number(p['a']) || 0, false);
    } else if (ev === "mis") {
      const tg = this.ent(String(p['t']));
      const x = p['x'] as number, y = p['y'] as number;
      if (tg) { this.missiles.push({ x, y, d0: Math.max(60, Math.hypot(tg.x - x, tg.y - y)), tgt: String(p['t']), dmg: false, lx: x, ly: y, sm: !!p['s'], dl: Number(p['d'] ?? 0) }); if (!p['d']) this.onToast(p['s'] ? "🚀🚀 Incoming mini missiles!" : "🚀 Incoming missile!"); this.snd(160, 0.8, "sawtooth", 0.06, 900); }
    } else if (ev === "bul") {
      this.bullets.push({ x: p['x'] as number, y: p['y'] as number, t: 0.42, dmg: false });
    } else if (ev === "decoy") {
      const st = { x: p['x'] as number, y: p['y'] as number };
      const tg = { x: (p['tx'] as number) ?? st.x, y: (p['ty'] as number) ?? st.y };
      this.foeDecoy = { ...st, t: 4, path: this.bfs(st, tg), trail: [], spd: typeof p['s'] === "number" ? p['s'] : 220 };
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
    this.frozenMe = Math.max(0, this.frozenMe - dt);
    this.trackT = Math.max(0, this.trackT - dt);
    if (this.aiming) {
      this.aim.x = Math.min((N - 1) * T, Math.max(T, this.aim.x + ix * 620 * dt));
      this.aim.y = Math.min((N - 1) * T, Math.max(T, this.aim.y + iy * 620 * dt));
      ix = 0; iy = 0;
    }
    if (this.frozenMe > 0) { ix = 0; iy = 0; }
    let sp = 310 * (me.spd > 0 ? 1.5 : 1);
    if (this.dashT > 0) sp *= 3;
    me.vx = ix * sp; me.vy = iy * sp;
    me.moving = il > 0.15 && !this.aiming && this.frozenMe <= 0;
    const oldX = me.x, oldY = me.y;
    const steps = Math.ceil((sp * dt) / 6) || 1;
    for (let i = 0; i < steps; i++) this.mv(me, (me.vx * dt) / steps, (me.vy * dt) / steps);
    const realD = Math.hypot(me.x - oldX, me.y - oldY);
    if (dt > 0 && this.dashT <= 0 && realD > 0.2 && realD < 40) this.mySpd += (realD / dt - this.mySpd) * Math.min(1, dt * 3);
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
        if (Math.abs(d - r) < 14 && s.shock) {
          s.hit = true; me.rev = 5;
          this.triggerZap({ x: s.x, y: s.y }, me, r);
          this.hiderHp = Math.max(0, this.hiderHp - 0.2);
          this.onToast(`⚡ SHOCKED! -1/5 health`); this.frozenMe = Math.max(this.frozenMe, 0.8);
          if (this.mp) this.net?.send("shk", { x: me.x, y: me.y, hp: this.hiderHp });
          if (this.hiderHp <= 0.001) return this.finish(false, "You were electrocuted!");
        } else if (Math.abs(d - r) < 14) {
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

    this.decoy = this.stepDecoy(this.decoy, dt);
    this.foeDecoy = this.stepDecoy(this.foeDecoy, dt);
    this.updateWeapons(dt);
    this.updateGen(dt);
    if (this.role === "h") this.updateDrones(dt);

    // keys + exit (hider only)
    if (this.role === "h" && this.exit && Math.hypot(this.exit.x - me.x, this.exit.y - me.y) < 22) {
      if (this.score >= this.goal) return this.finish(true, this.mp ? "You escaped with all 5 keys!" : `Escaped! Level ${this.level} cleared!`);
      if (this.portalCd <= 0) { this.onToast(`🔒 Exit locked — ${this.goal - this.score} more key${this.goal - this.score === 1 ? "" : "s"} needed`); this.portalCd = 1.5; }
    }
    if (this.role === "h") {
      const ci = Math.floor(me.y / T) * N + Math.floor(me.x / T);
      if (this.coins[ci]) {
        const cx = (ci % N) * T + T / 2, cy = Math.floor(ci / N) * T + T / 2;
        if (Math.hypot(cx - me.x, cy - me.y) < 14) { this.coins[ci] = 0; this.snd(1200 + Math.random() * 200, 0.05, "square", 0.02, 1700); this.burst(cx, cy, "#ffd6a0", 3); }
      }
      for (const c of this.cubes) c.vis = Math.max(0, c.vis - dt);
      for (const c of [...this.cubes]) {
        if (Math.hypot(c.x - me.x, c.y - me.y) < 20) {
          if (c.real) {
            this.score++; this.burst(c.x, c.y, "#ffc93c", 24);
            this.snd(660, 0.15, "triangle", 0.08, 1320); this.vib(30);
            if (this.score >= this.goal) { this.cubes = []; this.onToast("🔓 All 5 keys! Run to the green EXIT!"); this.vib([60, 40, 60]); }
            else { this.onToast(`🗝️ Real key! ${this.score}/${this.goal}`); this.spawnCubes(); }
            for (const s of this.seekers) s.think = 0;
          } else {
            this.cubes = this.cubes.filter((x) => x !== c);
            this.burst(c.x, c.y, "#777", 10); this.snd(150, 0.2, "square", 0.04);
            this.onToast("💨 Fake key — a dud");
          }
          break;
        }
      }
    }

    if (this.mp) this.updateMp(dt); else if (this.hunt) this.updateHunt(dt); else this.updateSolo(dt);
  }

  updateSolo(dt: number) {
    const me = this.me;
    // timers
    this.relocT -= dt;
    if (this.relocT <= 0) { this.spawnCubes(); this.onToast("🔀 The keys moved!"); this.alarmW = 3; }
    this.alarmT -= dt;
    if (this.alarmT <= 0 && this.alarmW <= 0 && this.alarmA <= 0) { this.alarmW = 3; this.alarmT = 30 + Math.random() * 15; }
    if (this.alarmW > 0) { this.alarmW -= dt; if (this.alarmW <= 0) { this.alarmA = 4; this.snd(880, 0.6, "sawtooth", 0.06, 440); this.vib([60, 40, 60]); } }
    if (this.alarmA > 0) this.alarmA -= dt;

    this.updatePowers(dt);

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
      let speed = (chasing ? 145 : 102) * this.diff * boost;
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

  updatePowers(dt: number) {
    const me = this.me;
    this.powT -= dt;
    if (this.powT <= 0) {
      if (this.powBurst > 0) { this.powBurst--; this.powT = 0; } else this.powT = 3;
      const ks: Power["k"][] = this.mp || this.hunt ? ["spd", "cloak", "scan", "freeze", "radar", "track"] : ["spd", "cloak", "scan", "freeze"];
      if (!this.hunt) ks.push("missile", "rain", "mini", "drone", "drone", "drone");
      if (this.mp || this.hunt) ks.push("radar", "track", "freeze", "scan");
      const R = this.mp ? this.powR : Math.random;
      let k = ks[Math.floor(R() * ks.length)] ?? "spd";
      // only one weapon power-up on the maze at a time
      if (isWeapon(k) && this.pows.some((p) => isWeapon(p.k))) k = (["missile", "rain", "mini"] as const).find((w) => !this.pows.some((p) => p.k === w)) ?? "spd";
      if (k === "drone" && (this.drones.length || this.droneView.length || this.pows.some((p) => p.k === "drone"))) k = "radar";
      const t = this.freeTile(R);
      const id = ++this.powId;
      if (this.pows.length < (this.mp ? 6 : 5)) this.pows.push({ ...t, k, id });
    }
    // solo: AI hunters can grab scout drones
    if (!this.mp && !this.hunt) for (const p of [...this.pows]) {
      if (p.k !== "drone") continue;
      const s = this.seekers.find((s) => Math.hypot(s.x - p.x, s.y - p.y) < 24);
      if (s) { this.pows = this.pows.filter((x) => x !== p); this.burst(p.x, p.y, POW.drone.c); this.spawnDrones(s); }
    }
    for (const p of [...this.pows]) {
      if (Math.hypot(p.x - me.x, p.y - me.y) < 20) {
        this.pows = this.pows.filter((x) => x !== p);
        if (this.mp) this.net?.send("pow", { id: p.id ?? 0, k: p.k });
        this.snd(880, 0.2, "triangle", 0.06, 1760); this.burst(p.x, p.y, POW[p.k].c);
        const hider = this.role === "h";
        if (p.k === "spd") { me.spd = 5; this.onToast("⚡ Speed boost!"); }
        if (p.k === "scan") { this.scanCd = 0; this.onToast("🔄 Scan recharged"); }
        if (p.k === "cloak") {
          if (hider) { me.cloak = 5; this.onToast("👻 Cloaked — they can't see or hear you"); }
          else { me.spd = 3; this.onToast("👻 No use to a hunter — small speed boost"); }
        }
        if (p.k === "freeze") {
          for (const s of this.seekers) s.frozen = 3;
          for (const h of this.hiders) h.frozen = 3;
          if (this.mp && hider) this.onToast("❄️ Hunters frozen for 3s!");
          else if (this.mp || this.hunt) { if (this.foe) this.foe.rev = 2; this.onToast("❄️ Frost pulse — hider flashed!"); }
          else this.onToast("❄️ Seekers frozen!");
        }
        if (p.k === "radar") {
          if (hider) { this.scanCd = 0; me.spd = 3; this.onToast("📡 Radar jammed — scan + speed!"); }
          else { if (this.foe) this.foe.rev = 3; for (const h of this.hiders) h.rev = 3; this.onToast("📡 Radar ping — hider revealed!"); }
        }
        if (isWeapon(p.k)) {
          if (hider) {
            this.weapon = p.k as "missile" | "rain" | "mini"; this.ammo = 25; this.aiming = false;
            this.onToast(p.k === "missile" ? "🚀 Missile lock! Tap MISSILE to aim" : p.k === "mini" ? "🚀🚀 Mini missiles! Tap MINI to aim" : "🌧️ Bullet rain! Tap RAIN to aim");
          } else { this.scanCd = 0; this.onToast("🔄 Weapon disarmed — scan recharged"); }
        }
        if (p.k === "drone") {
          if (hider) { this.scanCd = 0; this.decoyCd = 0; this.onToast("🛸 Drone parts scrapped — decoy recharged"); }
          else { this.droneLockView = 0; this.droneView = [{ x: me.x, y: me.y, a: 1 }]; this.onToast("🛸 Scout drones launched at the hider!"); }
        }
        if (p.k === "track") {
          if (hider) { this.decoyCd = 0; this.onToast("👣 Decoy recharged"); }
          else { this.trackT = 8; this.onToast("👣 Tracker — see the hider's footprints!"); }
        }
      }
    }
  }

  stepDecoy(d: Game["decoy"], dt: number): Game["decoy"] {
    if (!d) return null;
    d.t -= dt;
    if (d.t <= 0) { this.burst(d.x, d.y, "#4f83ff", 10); return null; }
    let move = (d.spd ?? 310) * dt;
    if (d.path.length < 2) d.path.push(...this.bfs(d.path.at(-1) ?? d, this.freeTile(Math.random, d, 200)).slice(1));
    while (move > 0 && d.path.length) {
      const n = d.path[0]!;
      const dx = n.x - d.x, dy = n.y - d.y, l = Math.hypot(dx, dy);
      if (l <= move) { d.x = n.x; d.y = n.y; d.path.shift(); move -= l; }
      else { d.x += (dx / l) * move; d.y += (dy / l) * move; move = 0; }
    }
    d.trail = this.decayTrail(d.trail, dt);
    this.pushTrail(d.trail, d.x, d.y, 0.5, 40);
    return d;
  }

  updateCompanion(dt: number) {
    const foe = this.foe!;
    for (const s of this.seekers) {
      s.scanCd -= dt; s.think -= dt;
      const d = Math.hypot(foe.x - s.x, foe.y - s.y);
      if (s.think <= 0) {
        s.think = 0.35;
        let tgt: { x: number; y: number } | null = null;
        const fd = this.foeDecoy;
        if (fd && Math.hypot(fd.x - s.x, fd.y - s.y) < 400) tgt = fd;
        else if (foe.rev > 0 || (foe.moving && d < (foe.dash ? this.hearR * 1.6 : this.hearR))) tgt = foe;
        if (tgt) { s.target = { x: tgt.x, y: tgt.y }; s.path = this.bfs(s, tgt); }
        else if (!s.path.length) { s.target = null; s.path = this.bfs(s, this.freeTile()); }
      }
      if (s.scanCd <= 0 && d < 450) {
        s.scanCd = 6;
        this.scans.push({ x: s.x, y: s.y, t: 0, owner: "ai", hit: false, maxR: 360 });
        this.net?.send("scan", { x: s.x, y: s.y });
      }
      const ox = s.x, oy = s.y;
      let move = (s.target ? 150 : 105) * dt;
      while (move > 0 && s.path.length) {
        const n = s.path[0]!;
        const dx = n.x - s.x, dy = n.y - s.y, l = Math.hypot(dx, dy);
        if (l <= move) { s.x = n.x; s.y = n.y; s.path.shift(); move -= l; }
        else { s.x += (dx / l) * move; s.y += (dy / l) * move; move = 0; }
      }
      s.trail = this.decayTrail(s.trail, dt);
      if (Math.hypot(s.x - ox, s.y - oy) > 0.2) this.pushTrail(s.trail, s.x, s.y, 0.5, 40);
      if (d < s.r + foe.r - 2) return this.finish(true, "Your AI partner caught the hider!");
    }
  }

  updateMp(dt: number) {
    const me = this.me, foe = this.foe!;
    foe.x += (foe.tx - foe.x) * Math.min(1, dt * 12);
    foe.y += (foe.ty - foe.y) * Math.min(1, dt * 12);
    foe.rev = Math.max(0, foe.rev - dt);
    this.foeTrail = this.decayTrail(this.foeTrail, dt);
    if (foe.moving) this.pushTrail(this.foeTrail, foe.x, foe.y, 0.5, 40);
    this.updatePowers(dt);
    this.timeLeft -= dt;
    if (this.role === "s") {
      // footprints: always faint when hider dashes, full while tracker is active
      const ox = this.prints.at(-1);
      this.printD -= dt;
      if (foe.moving && !this.foeCloak && (this.trackT > 0 || foe.dash) && this.printD <= 0 && (!ox || Math.hypot(ox.x - foe.x, ox.y - foe.y) > 18)) {
        this.printD = 0.12;
        this.prints.push({ x: foe.x, y: foe.y, a: Math.atan2(foe.ty - foe.y, foe.tx - foe.x), life: 5 });
        if (this.prints.length > 80) this.prints.shift();
      }
      for (const pr of this.prints) pr.life -= dt;
      this.prints = this.prints.filter((pr) => pr.life > 0);
      // heartbeat sensor: closer hider = faster pulse
      const hd = Math.hypot(foe.x - me.x, foe.y - me.y);
      if (!this.foeCloak && hd < 420) {
        this.heart -= dt;
        if (this.heart <= 0) { this.heart = 0.35 + (hd / 420) * 1.1; this.snd(70, 0.12, "sine", 0.08, 50); if (hd < 200) this.vib([25]); }
      }
    }
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 1 / 15;
      const cp = this.role === "s" ? this.seekers[0] : undefined;
      this.net?.send("st", { x: Math.round(me.x), y: Math.round(me.y), m: me.moving, d: this.dashT > 0, ck: me.cloak > 0, sc: this.score, ...(this.role === "h" ? { dr: this.drones.flatMap((d) => [Math.round(d.x), Math.round(d.y), Math.round(d.alt * 100)]), lk: Math.round(this.droneLock * 100) } : {}), ...(cp ? { cx: Math.round(cp.x), cy: Math.round(cp.y) } : {}) });
    }
    if (this.role === "h") {
      for (const s of this.seekers) {
        const ox = s.x, oy = s.y;
        const tx = s.target?.x ?? s.x, ty = s.target?.y ?? s.y;
        s.x += (tx - s.x) * Math.min(1, dt * 12); s.y += (ty - s.y) * Math.min(1, dt * 12);
        s.trail = this.decayTrail(s.trail, dt);
        if (Math.hypot(s.x - ox, s.y - oy) > 0.2) this.pushTrail(s.trail, s.x, s.y, 0.5, 40);
      }
      if (this.timeLeft <= 0) return this.finish(true, "You survived 3 minutes!");
    } else {
      // seeker scan can reveal the hider on seeker's side too
      for (const s of this.scans) if (s.owner === "me" && !s.hit && !this.foeCloak && Math.abs(Math.hypot(foe.x - s.x, foe.y - s.y) - scanR(s)) < 14) { s.hit = true; foe.rev = 5; }
      if (Math.hypot(foe.x - me.x, foe.y - me.y) < me.r + foe.r - 2) return this.finish(true, "You caught the hider!");
      if (this.seekers.length) this.updateCompanion(dt);
    }
  }

  foeVisible() {
    const f = this.foe;
    if (!f || !f.seen) return false;
    const v = this.aiming ? this.aim : this.me;
    const d = Math.hypot(f.x - v.x, f.y - v.y);
    if (this.role === "h") return d < 340;
    return f.rev > 0 && !this.foeCloak;
  }

  finish(win: boolean, text: string) {
    if (!this.running) return;
    this.running = false;
    this.snd(win ? 880 : 180, 0.7, win ? "triangle" : "sawtooth", 0.09, win ? 1320 : 50);
    this.vib(win ? [40, 40, 40] : 200);
    if (this.mp) this.net?.send("end", { w: win ? this.role : this.role === "h" ? "s" : "h", text });
    this.onEnd({ win, text, nextLevel: !this.mp && win });
  }

  giveUp() {
    if (!this.running) return;
    this.paused = false;
    if (this.mp) {
      this.running = false;
      this.net?.send("end", { w: this.role === "h" ? "s" : "h", text: "Your opponent gave up — you win!" });
      this.onEnd({ win: false, text: "You gave up the match." });
    } else this.finish(false, "You gave up.");
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
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (this.zap) { this.zap.t -= dt; if (this.zap.t <= 0) this.zap = null; }
    if (this.dark) { this.dark.t -= dt; if (this.dark.t <= 0) this.dark = null; }
    if (this.hitStop > 0) { this.hitStop -= dt; this.shake = Math.max(0, this.shake - dt * 0.5); }
    else if (this.running && !this.paused) this.update(dt);
    if (this.g.length && this.me) this.draw(now);
    this.hudT -= dt;
    if (this.hudT <= 0 && this.me) { this.hudT = 0.1; this.emitHud(); }
  }

  emitHud() {
    this.onHud({
      score: this.score, goal: this.goal, level: this.level,
      scanCd: this.scanCd, dashCd: this.dashCd, decoyCd: this.decoyCd,
      seen: this.me.rev > 0, timeLeft: this.mp || this.hunt ? Math.max(0, this.timeLeft) : null,
      alarm: this.alarmA > 0 ? "🚨 ALARM — you are tracked!" : this.alarmW > 0 ? `🚨 Alarm in ${Math.ceil(this.alarmW)}s` : "",
      role: this.role, mp: this.mp, hunt: this.hunt,
      weapon: this.weapon, aiming: this.aiming, lock: this.lock, ammo: this.ammo, hp: this.myHp,
      droneLock: this.role === "h" ? this.droneLock : this.droneLockView,
      drones: this.role === "h" ? this.drones.filter((d) => !d.dead).length : this.droneView.length,
      ropeAvail: this.role === "h" && !this.rope && !!this.nearDrone(120),
      roped: !!this.rope?.att, pull: this.rope?.d.pull ?? 0,
      shock: { on: this.role === "s" && !!this.gen, ready: this.shockReady, charge: this.shockCharge, genCd: this.genCd, near: !!this.gen && Math.hypot(this.gen.x - this.me.x, this.gen.y - this.me.y) < 90 },
      hiderHp: this.role === "h" ? this.hiderHp : this.foeHiderHp,
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
    const cam = this.aiming ? this.aim : me;
    const ox = W / 2 - cam.x * z + sx, oy = H / 2 - cam.y * z + sy;
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

    // hider footprints (seeker only)
    if ((this.mp || this.hunt) && this.role === "s") for (const pr of this.prints) {
      c.save(); c.translate(pr.x, pr.y); c.rotate(pr.a + Math.PI / 2);
      c.globalAlpha = Math.min(1, pr.life / 2) * (this.trackT > 0 ? 0.8 : 0.45);
      c.fillStyle = "#ffa24a";
      c.beginPath(); c.ellipse(-4, 0, 2.6, 4.5, 0, 0, 7); c.fill();
      c.beginPath(); c.ellipse(4, -6, 2.6, 4.5, 0, 0, 7); c.fill();
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
      c.rotate(-now / 700 + Math.sin(now / 300) * 0.3);
      c.shadowColor = "#ffc93c"; c.shadowBlur = 16;
      c.fillStyle = "rgba(255,201,60,0.25)"; c.beginPath(); c.arc(0, 0, 16, 0, 7); c.fill();
      c.font = "22px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("🗝️", 0, 1);
      c.restore();
    }
    if (this.exit) {
      const ex = this.exit, open = this.score >= this.goal, col = open ? "#3dff8a" : "#2fd6a0";
      const pu = 1 + 0.08 * Math.sin(now / (open ? 120 : 400));
      c.save(); c.translate(ex.x, ex.y); c.shadowColor = col; c.shadowBlur = open ? 30 : 14;
      c.fillStyle = col + "33"; c.fillRect(-20 * pu, -20 * pu, 40 * pu, 40 * pu);
      c.strokeStyle = col; c.lineWidth = 3; c.strokeRect(-16, -16, 32, 32);
      c.font = "bold 9px system-ui"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#e8fff3"; c.shadowBlur = 0;
      c.fillText("EXIT", 0, -4); c.font = "11px system-ui"; c.fillText(open ? "🔓" : "🔒", 0, 8);
      c.restore();
    }

    // coins (hider only), visible tiles
    if (this.role === "h") {
      c.fillStyle = "#ffc9a0"; c.shadowColor = "#ffb070"; c.shadowBlur = 6;
      const vx0 = Math.max(0, Math.floor((cam.x - this.W / 2 / this.z) / T) - 1), vx1 = Math.min(N - 1, Math.ceil((cam.x + this.W / 2 / this.z) / T) + 1);
      const vy0 = Math.max(0, Math.floor((cam.y - this.H / 2 / this.z) / T) - 1), vy1 = Math.min(N - 1, Math.ceil((cam.y + this.H / 2 / this.z) / T) + 1);
      for (let y = vy0; y <= vy1; y++) for (let x = vx0; x <= vx1; x++) if (this.coins[y * N + x]) { c.beginPath(); c.arc(x * T + T / 2, y * T + T / 2, 3, 0, 7); c.fill(); }
      c.shadowBlur = 0;
    }
    if (this.gen) this.drawGen(this.gen.x, this.gen.y, now);
    // power-ups
    c.font = "16px system-ui"; c.textAlign = "center"; c.textBaseline = "middle";
    for (const p of this.pows) {
      const b = 1 + 0.12 * Math.sin(now / 180), P = POW[p.k];
      c.fillStyle = P.c + "44"; c.strokeStyle = P.c; c.lineWidth = 2;
      c.beginPath(); c.arc(p.x, p.y, 14 * b, 0, 7); c.fill(); c.stroke();
      c.fillStyle = "#fff"; c.fillText(P.e, p.x, p.y + 1);
    }

    // decoys
    if (this.decoy) { c.globalAlpha = 0.55 + 0.2 * Math.sin(now / 120); this.ball(this.decoy.x, this.decoy.y, 11, "#4f83ff", "#bcd4ff"); c.globalAlpha = 1; }
    if (this.role === "s" && this.foeDecoy && Math.hypot(this.foeDecoy.x - me.x, this.foeDecoy.y - me.y) < 340) this.ball(this.foeDecoy.x, this.foeDecoy.y, this.foe?.r ?? 12, "#4f83ff", "#bcd4ff");

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

    for (const h of this.hiders) if (this.hiderVisible(h)) {
      c.globalAlpha = h.frozen > 0 ? 0.6 : 1; this.ball(h.x, h.y, h.r, h.hue, "#bcd4ff"); c.globalAlpha = 1;
    }
    if (this.hunt && this.foeDecoy && Math.hypot(this.foeDecoy.x - me.x, this.foeDecoy.y - me.y) < 240) this.ball(this.foeDecoy.x, this.foeDecoy.y, 11, "#4f83ff", "#bcd4ff");

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

    // hunter health bars
    const bar = (x: number, y: number, r: number, hp: number) => {
      const w = 28, h = 5, bx = x - w / 2, by = y - r - 12;
      c.fillStyle = "rgba(0,0,0,.65)"; c.fillRect(bx - 1, by - 1, w + 2, h + 2);
      c.fillStyle = hp > 0.67 ? "#3dff8a" : hp > 0.34 ? "#ffd84a" : "#ff3b4e";
      c.fillRect(bx, by, w * Math.max(0, hp), h);
      c.fillStyle = "rgba(0,0,0,.7)"; c.fillRect(bx + w / 3, by, 1, h); c.fillRect(bx + (2 * w) / 3, by, 1, h);
    };
    for (const s of this.seekers) bar(s.x, s.y, s.r, s.hp ?? 1);
    if (this.mp && this.foe && this.role === "h" && this.foeVisible()) bar(this.foe.x, this.foe.y, this.foe.r, this.foeHp);
    if (this.mp && this.role === "s") bar(me.x, me.y, me.r, this.myHp);
    const hbar = (x: number, y: number, r: number, hp: number) => {
      const w = 30, h = 4, bx = x - w / 2, by = y + r + 8;
      c.fillStyle = "rgba(0,0,0,.65)"; c.fillRect(bx - 1, by - 1, w + 2, h + 2);
      c.fillStyle = "#4fd8ff"; c.fillRect(bx, by, w * Math.max(0, hp), h);
      c.fillStyle = "rgba(0,0,0,.8)"; for (let i = 1; i < 5; i++) c.fillRect(bx + (w * i) / 5, by, 1, h);
    };
    for (const h of this.hiders) if (this.hiderVisible(h) && (h.hp ?? 1) < 1) hbar(h.x, h.y, h.r, h.hp ?? 1);
    if (this.mp && this.foe && this.role === "s" && this.foeVisible() && this.foeHiderHp < 1) hbar(this.foe.x, this.foe.y, this.foe.r, this.foeHiderHp);
    if (this.role === "h" && this.hiderHp < 1) hbar(me.x, me.y, me.r, this.hiderHp);

    // falling bullets
    for (const b of this.bullets) {
      const k = Math.max(0, b.t / 0.42), lift = k * k * 320;
      c.fillStyle = `rgba(255,225,74,${0.25 * (1 - k)})`; c.beginPath(); c.arc(b.x, b.y, 3 + (1 - k) * 4, 0, 7); c.fill();
      c.save(); c.strokeStyle = "#fff6b0"; c.shadowColor = "#ffe14a"; c.shadowBlur = 10; c.lineWidth = 2.5;
      c.beginPath(); c.moveTo(b.x + lift * 0.18, b.y - lift - 22); c.lineTo(b.x + lift * 0.18 - 3, b.y - lift); c.stroke(); c.restore();
    }
    // scout drones + rope + lock ring
    if (this.role === "h") {
      const r = this.rope;
      if (r) {
        const k = r.att ? 1 : r.t, dx = r.d.x, dy = r.d.y - 55 * r.d.alt;
        const ex = me.x + (dx - me.x) * k, ey = me.y + (dy - me.y) * k;
        const sag = r.att ? 18 + Math.sin(now / 90) * 4 : 6;
        c.save(); c.strokeStyle = "#e8c98a"; c.lineWidth = 2.5; c.shadowColor = "#ffb347"; c.shadowBlur = 6;
        c.beginPath(); c.moveTo(me.x, me.y); c.quadraticCurveTo((me.x + ex) / 2, (me.y + ey) / 2 + sag, ex, ey); c.stroke(); c.restore();
      }
      for (const d of this.drones) this.drawDrone(d.x, d.y, d.alt, now, r?.d === d);
      if (this.droneLock > 0) this.drawLockRing(me.x, me.y, this.droneLock, now);
    } else {
      for (const d of this.droneView) this.drawDrone(d.x, d.y, d.a, now, false);
      if (this.droneLockView > 0 && this.foe) this.drawLockRing(this.foe.x, this.foe.y, this.droneLockView, now);
    }
    // missiles
    for (const m of this.missiles) {
      if (m.dl && m.dl > 0) continue;
      const tg = this.ent(m.tgt);
      const l = tg ? Math.hypot(tg.x - m.x, tg.y - m.y) : 0, pr = Math.min(1, Math.max(0, 1 - l / m.d0));
      const lift = Math.sin(pr * Math.PI) * 70;
      const ang = Math.atan2(m.y - m.ly - (pr < 0.5 ? 1 : -1) * 2, m.x - m.lx);
      c.fillStyle = "rgba(0,0,0,.35)"; c.beginPath(); c.ellipse(m.x, m.y, 8, 4, 0, 0, 7); c.fill();
      c.save(); c.translate(m.x, m.y - lift); c.rotate(ang); if (m.sm) c.scale(0.55, 0.55);
      c.shadowColor = "#ff7a2f"; c.shadowBlur = 16;
      c.fillStyle = "#ffb347"; c.beginPath(); c.moveTo(-10, 0); c.lineTo(-20 - Math.random() * 8, -4); c.lineTo(-20 - Math.random() * 8, 4); c.closePath(); c.fill();
      c.fillStyle = "#e8ecff"; c.beginPath(); c.moveTo(12, 0); c.lineTo(-10, -5); c.lineTo(-10, 5); c.closePath(); c.fill();
      c.fillStyle = "#ff3b4e"; c.fillRect(-10, -7, 5, 14);
      c.restore();
      if (this.role === "s" && m.tgt === "f") { c.strokeStyle = `rgba(255,59,78,${0.5 + 0.5 * Math.sin(now / 60)})`; c.lineWidth = 2; c.beginPath(); c.arc(me.x, me.y, me.r + 14, 0, 7); c.stroke(); }
    }
    // aim reticle
    if (this.aiming) {
      const a = this.aim;
      c.save(); c.setLineDash([4, 6]); c.strokeStyle = "rgba(255,255,255,.25)"; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(me.x, me.y); c.lineTo(a.x, a.y); c.stroke(); c.restore();
      c.save(); c.shadowBlur = 10;
      if (this.weapon === "missile") {
        const locked = this.lock >= 1, col = locked ? "#3dff8a" : "#ffffff";
        c.shadowColor = col; c.strokeStyle = col; c.lineWidth = 2.5;
        c.beginPath(); c.arc(a.x, a.y, 14, 0, 7); c.stroke();
        if (this.lock > 0) {
          c.strokeStyle = locked ? "#3dff8a" : "#ffd84a"; c.lineWidth = 3.5;
          c.beginPath(); c.arc(a.x, a.y, 21, -Math.PI / 2, -Math.PI / 2 + this.lock * Math.PI * 2); c.stroke();
        }
        c.fillStyle = col; c.beginPath(); c.arc(a.x, a.y, 2, 0, 7); c.fill();
      } else {
        c.shadowColor = "#ffe14a"; c.strokeStyle = "#ffe14a"; c.lineWidth = 2.5;
        c.beginPath();
        c.moveTo(a.x - 20, a.y); c.lineTo(a.x - 6, a.y); c.moveTo(a.x + 6, a.y); c.lineTo(a.x + 20, a.y);
        c.moveTo(a.x, a.y - 20); c.lineTo(a.x, a.y - 6); c.moveTo(a.x, a.y + 6); c.lineTo(a.x, a.y + 20);
        c.stroke(); c.lineWidth = 1.5; c.beginPath(); c.arc(a.x, a.y, 13, 0, 7); c.stroke();
      }
      c.restore();
    }

    // shock: darkness outside the circle, then the lightning on top
    if (this.dark) {
      const d = this.dark, a = Math.min(1, (1.6 - d.t) / 0.12) * Math.min(1, d.t / 0.5);
      c.save();
      const ext = Math.max(this.W, this.H) * 1.5 + d.r;
      c.beginPath(); c.rect(this.me.x - ext, this.me.y - ext, ext * 2, ext * 2); c.arc(d.x, d.y, d.r, 0, Math.PI * 2, true);
      c.fillStyle = `rgba(0,0,4,${0.9 * a})`; c.fill("evenodd");
      c.strokeStyle = `rgba(255,50,80,${0.35 * a})`; c.lineWidth = 9; c.beginPath(); c.arc(d.x, d.y, d.r, 0, 7); c.stroke();
      c.strokeStyle = `rgba(255,50,80,${a})`; c.lineWidth = 3; c.beginPath(); c.arc(d.x, d.y, d.r, 0, 7); c.stroke();
      c.restore();
    }
    if (this.zap) this.drawZap(this.zap, now);

    // danger vignette
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.zap && this.zap.t > 1.15) { c.fillStyle = `rgba(200,240,255,${(this.zap.t - 1.15) * 3})`; c.fillRect(0, 0, W, H); }
    let danger = 0;
    for (const s of this.seekers) danger = Math.max(danger, 1 - Math.hypot(s.x - me.x, s.y - me.y) / 300);
    if (this.mp && this.role === "h" && this.foe) danger = Math.max(danger, 1 - Math.hypot(this.foe.x - me.x, this.foe.y - me.y) / 300);
    if (danger > 0 || this.alarmA > 0) {
      const flick = 0.75 + 0.25 * Math.sin(now / (danger > 0.6 ? 70 : 130)) * (0.6 + 0.4 * Math.sin(now / 37));
      const a = Math.min(0.42, (danger * danger * 0.45 + (this.alarmA > 0 ? 0.15 : 0)) * flick);
      const v = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.hypot(W, H) * 0.55);
      v.addColorStop(0, "rgba(255,20,50,0)"); v.addColorStop(0.6, `rgba(220,10,40,${a * 0.35})`); v.addColorStop(1, `rgba(200,0,30,${a})`);
      c.fillStyle = v; c.fillRect(0, 0, W, H);
    }
    if (this.mp && this.role === "s" && this.foe && !this.foeCloak && !this.foeVisible()) {
      const f = this.foe, hd = Math.hypot(f.x - me.x, f.y - me.y);
      if (hd < 420) {
        const ang = Math.atan2(f.y - me.y, f.x - me.x), near = 1 - hd / 420;
        const pulse = 0.5 + 0.5 * Math.sin(now / (110 + (1 - near) * 200));
        const rad = Math.min(W, H) * 0.32;
        c.save(); c.translate(W / 2 + Math.cos(ang) * rad, H / 2 + Math.sin(ang) * rad); c.rotate(ang);
        c.globalAlpha = 0.35 + 0.5 * near * pulse;
        c.fillStyle = "#ff3b4e"; c.shadowColor = "#ff3b4e"; c.shadowBlur = 14;
        c.beginPath(); c.moveTo(16, 0); c.lineTo(-8, -11); c.lineTo(-3, 0); c.lineTo(-8, 11); c.closePath(); c.fill();
        c.restore();
      }
    }
    if (this.hunt) for (const h of this.hiders) {
      const hd = Math.hypot(h.x - me.x, h.y - me.y);
      if (this.hiderVisible(h) || hd > 420) continue;
      const ang = Math.atan2(h.y - me.y, h.x - me.x), near = 1 - hd / 420;
      const pulse = 0.5 + 0.5 * Math.sin(now / (110 + (1 - near) * 200));
      const rad = Math.min(W, H) * 0.32;
      c.save(); c.translate(W / 2 + Math.cos(ang) * rad, H / 2 + Math.sin(ang) * rad); c.rotate(ang);
      c.globalAlpha = 0.35 + 0.5 * near * pulse; c.fillStyle = "#ff3b4e"; c.shadowColor = "#ff3b4e"; c.shadowBlur = 14;
      c.beginPath(); c.moveTo(16, 0); c.lineTo(-8, -11); c.lineTo(-3, 0); c.lineTo(-8, 11); c.closePath(); c.fill();
      c.restore();
    }
    if (this.frozenMe > 0) { c.fillStyle = `rgba(140,230,255,${0.18 + 0.05 * Math.sin(now / 90)})`; c.fillRect(0, 0, W, H); }
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
    if (this.gen) dot(this.gen.x, this.gen.y, "#ff3b4e", 3);
    if (this.exit) dot(this.exit.x, this.exit.y, "#3dff8a", 3.5);
    for (const s of this.seekers) dot(s.x, s.y, s.hue);
    for (const h of this.hiders) if (this.hiderVisible(h)) dot(h.x, h.y, "#7fb0ff");
    if (this.mp && this.foe && this.foeVisible()) dot(this.foe.x, this.foe.y, this.role === "s" ? "#7fb0ff" : "#ff3b4e");
    dot(this.me.x, this.me.y, this.role === "s" ? "#ff6b7b" : "#7fb0ff", 3.2);
  }
}
