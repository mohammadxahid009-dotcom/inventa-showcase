import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

type Sig = { from: string; to?: string } & ({ k: "hello" } | { k: "offer" | "answer"; sdp: string });
export type VoiceState = { connected: boolean; micOn: boolean; peerTalking: boolean; meTalking: boolean; error: string };

const ICE: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
];

/**
 * Peer-to-peer voice chat between the two players.
 * Uses its own dedicated room channel (separate from the busy game channel) and sends the
 * full connection offer in one message (all network routes bundled), so only ~3 small
 * setup messages are ever needed. Keeps retrying until both phones are linked.
 */
export class Voice {
  readonly key: string;
  private ch: RealtimeChannel;
  private ready = false;
  private pc: RTCPeerConnection | null = null;
  private audio: HTMLAudioElement;
  private mic: MediaStream | null = null;
  private helloTimer = 0;
  private meterTimer = 0;
  private actx: AudioContext | null = null;
  private peerAn: AnalyserNode | null = null;
  private st: VoiceState = { connected: false, micOn: false, peerTalking: false, meTalking: false, error: "" };
  private closed = false;
  private id = Math.random().toString(36).slice(2);
  private peerId = "";
  private busy = false;
  private lastOfferAt = 0;

  constructor(room: string, private host: boolean, private onState: (s: VoiceState) => void) {
    this.key = room;
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "");
    this.audio.style.display = "none";
    document.body.appendChild(this.audio);

    this.ch = supabase.channel(`lumen-voice-${room}`, { config: { broadcast: { self: false, ack: false } } });
    this.ch.on("broadcast", { event: "sig" }, ({ payload }) => { void this.onSignal(payload as Sig); });
    this.ch.subscribe((s) => {
      if (s === "SUBSCRIBED") { this.ready = true; this.send({ k: "hello" }); }
    });
    this.helloTimer = window.setInterval(() => {
      if (this.closed || this.st.connected) return;
      this.send({ k: "hello" });
      // host re-offers if an offer went unanswered for a while
      if (this.host && this.peerId && Date.now() - this.lastOfferAt > 12000) void this.makeOffer();
    }, 2000);
    this.meterTimer = window.setInterval(() => {
      const pt = this.level(this.peerAn) > 0.04;
      if (pt !== this.st.peerTalking) this.set({ peerTalking: pt });
    }, 150);
    addEventListener("pointerdown", this.resumeAudio);
    // show the controls immediately for both players
    queueMicrotask(() => this.onState(this.st));
  }

  private send(p: Omit<Sig, "from">) {
    if (!this.ready || this.closed) return;
    void this.ch.send({ type: "broadcast", event: "sig", payload: { ...p, from: this.id } });
  }
  private set(p: Partial<VoiceState>) { this.st = { ...this.st, ...p }; if (!this.closed) this.onState(this.st); }

  private resumeAudio = () => {
    void this.audio.play().catch(() => {});
    void this.actx?.resume().catch(() => {});
  };

  /** Fresh connection each attempt — avoids half-broken states on mobile browsers. */
  private newPc() {
    this.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const tx = pc.addTransceiver("audio", { direction: "sendrecv" });
    const track = this.mic?.getAudioTracks()[0];
    if (track) void tx.sender.replaceTrack(track);
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track]);
      this.audio.srcObject = s;
      this.resumeAudio();
      this.peerAn = this.analyser(s);
    };
    const upd = () => {
      if (this.pc !== pc) return;
      const i = pc.iceConnectionState, c = pc.connectionState;
      const ok = i === "connected" || i === "completed" || c === "connected";
      const dead = i === "failed" || c === "failed" || c === "closed";
      this.set({ connected: ok });
      if (dead && this.host) { this.lastOfferAt = 0; }
    };
    pc.oniceconnectionstatechange = upd;
    pc.onconnectionstatechange = upd;
    this.pc = pc;
    return pc;
  }

  /** Wait until all network routes are found (or 2s), so the whole thing goes in one message. */
  private gather(pc: RTCPeerConnection) {
    return new Promise<void>((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const t = setTimeout(res, 2000);
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
    });
  }

  private async makeOffer() {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.lastOfferAt = Date.now();
    try {
      const pc = this.newPc();
      await pc.setLocalDescription(await pc.createOffer());
      await this.gather(pc);
      if (this.pc !== pc || this.closed) return;
      this.send({ k: "offer", to: this.peerId, sdp: pc.localDescription?.sdp ?? "" });
    } catch { /* retried by timer */ } finally { this.busy = false; }
  }

  private async onSignal(p: Sig) {
    if (this.closed || !p || p.from === this.id) return;
    if (p.to && p.to !== this.id) return;
    try {
      if (p.k === "hello") {
        const isNew = this.peerId !== p.from;
        this.peerId = p.from;
        if (this.host && !this.st.connected && (isNew || Date.now() - this.lastOfferAt > 12000)) void this.makeOffer();
        else if (!this.host && isNew) this.send({ k: "hello" });
      } else if (p.k === "offer" && !this.host) {
        this.peerId = p.from;
        const pc = this.newPc();
        await pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        await this.gather(pc);
        if (this.pc !== pc || this.closed) return;
        this.send({ k: "answer", to: p.from, sdp: pc.localDescription?.sdp ?? "" });
      } else if (p.k === "answer" && this.host) {
        if (this.pc?.signalingState !== "have-local-offer") return;
        await this.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
      }
    } catch { /* ignore; retried */ }
  }

  private analyser(s: MediaStream) {
    try {
      this.actx ??= new AudioContext();
      const an = this.actx.createAnalyser();
      an.fftSize = 256;
      this.actx.createMediaStreamSource(s).connect(an);
      return an;
    } catch { return null; }
  }
  private buf = new Uint8Array(256);
  private level(an: AnalyserNode | null) {
    if (!an) return 0;
    an.getByteTimeDomainData(this.buf);
    let m = 0;
    for (let i = 0; i < an.fftSize; i++) m = Math.max(m, Math.abs(this.buf[i]! - 128));
    return m / 128;
  }

  async setMic(on: boolean) {
    this.resumeAudio();
    if (on && !this.mic) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (this.closed) { this.mic.getTracks().forEach((t) => t.stop()); return; }
        const track = this.mic.getAudioTracks()[0] ?? null;
        const sender = this.pc?.getTransceivers()[0]?.sender;
        if (sender) await sender.replaceTrack(track);
      } catch {
        this.set({ micOn: false, error: "Microphone blocked — allow mic access in your browser." });
        return;
      }
    }
    this.mic?.getAudioTracks().forEach((t) => { t.enabled = on; });
    this.set({ micOn: on, error: "" });
  }

  stop() {
    this.closed = true;
    clearInterval(this.helloTimer); clearInterval(this.meterTimer);
    removeEventListener("pointerdown", this.resumeAudio);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.audio.srcObject = null;
    this.audio.remove();
    void supabase.removeChannel(this.ch);
    void this.actx?.close().catch(() => {});
  }
}
