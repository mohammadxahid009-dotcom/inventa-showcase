import type { RealtimeChannel } from "@supabase/supabase-js";

type Sig = { from?: string } & ({ k: "hello" } | { k: "offer" | "answer"; sdp: string } | { k: "ice"; c: RTCIceCandidateInit });
export type VoiceState = { connected: boolean; micOn: boolean; peerTalking: boolean; meTalking: boolean; error: string };

/** Peer-to-peer voice chat between the two players, using the game room for setup messages. */
export class Voice {
  readonly ch: RealtimeChannel;
  private pc: RTCPeerConnection;
  private tx: RTCRtpTransceiver;
  private audio = new Audio();
  private mic: MediaStream | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private helloTimer = 0;
  private meterTimer = 0;
  private actx: AudioContext | null = null;
  private peerAn: AnalyserNode | null = null;
  private meAn: AnalyserNode | null = null;
  private st: VoiceState = { connected: false, micOn: false, peerTalking: false, meTalking: false, error: "" };
  private closed = false;
  private id = Math.random().toString(36).slice(2);
  private peerId = "";

  constructor(ch: RealtimeChannel, private host: boolean, private onState: (s: VoiceState) => void) {
    this.ch = ch;
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "");
    this.audio.style.display = "none";
    document.body.appendChild(this.audio);
    this.pc = new RTCPeerConnection({ iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
    ] });
    this.tx = this.pc.addTransceiver("audio", { direction: "sendrecv" });
    this.pc.onicecandidate = (e) => { if (e.candidate) this.send({ k: "ice", c: e.candidate.toJSON() }); };
    this.pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track]);
      this.audio.srcObject = s;
      this.resumeAudio();
      this.peerAn = this.analyser(s);
    };
    const upd = () => {
      const i = this.pc.iceConnectionState, c = this.pc.connectionState;
      const ok = i === "connected" || i === "completed" || c === "connected";
      this.set({ connected: ok });
      if (i === "failed" && this.host) void this.makeOffer(true);
    };
    this.pc.oniceconnectionstatechange = upd;
    this.pc.onconnectionstatechange = upd;
    // Both sides keep announcing themselves until connected, so whoever joins later still links up.
    this.send({ k: "hello" });
    this.helloTimer = window.setInterval(() => { if (!this.st.connected) this.send({ k: "hello" }); }, 2500);
    this.meterTimer = window.setInterval(() => {
      const pt = this.level(this.peerAn) > 0.04, mt = false;
      if (pt !== this.st.peerTalking || mt !== this.st.meTalking) this.set({ peerTalking: pt, meTalking: mt });
    }, 150);
    addEventListener("pointerdown", this.resumeAudio);
  }

  private send(p: Sig) { void this.ch.send({ type: "broadcast", event: "rtc", payload: { ...p, from: this.id } }); }
  private offering = false;
  private async makeOffer(restart = false) {
    if (this.offering) return;
    this.offering = true;
    try {
      if (this.pc.signalingState !== "stable") await this.pc.setLocalDescription({ type: "rollback" }).catch(() => {});
      const o = await this.pc.createOffer({ iceRestart: restart });
      await this.pc.setLocalDescription(o);
      this.send({ k: "offer", sdp: o.sdp ?? "" });
    } finally { this.offering = false; }
  }
  private set(p: Partial<VoiceState>) { this.st = { ...this.st, ...p }; if (!this.closed) this.onState(this.st); }

  private resumeAudio = () => {
    void this.audio.play().catch(() => {});
    void this.actx?.resume().catch(() => {});
  };

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

  async onSignal(p: Sig) {
    if (this.closed || !p || p.from === this.id) return;
    if (p.from && this.peerId && p.from !== this.peerId && p.k !== "hello") return;
    try {
      if (p.k === "hello") {
        if (p.from) this.peerId = p.from;
        if (this.host && !this.st.connected) await this.makeOffer(!!this.pc.remoteDescription);
        else if (!this.host && !this.st.connected) this.send({ k: "hello" });
      } else if (p.k === "offer" && !this.host) {
        if (this.pc.signalingState !== "stable") await this.pc.setLocalDescription({ type: "rollback" }).catch(() => {});
        await this.pc.setRemoteDescription({ type: "offer", sdp: p.sdp });
        await this.flushIce();
        const a = await this.pc.createAnswer();
        await this.pc.setLocalDescription(a);
        this.send({ k: "answer", sdp: a.sdp ?? "" });
      } else if (p.k === "answer" && this.host) {
        if (this.pc.signalingState !== "have-local-offer") return;
        await this.pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
        await this.flushIce();
      } else if (p.k === "ice") {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(p.c).catch(() => {});
        else this.pendingIce.push(p.c);
      }
    } catch { /* ignore a bad setup message; the guest retries */ }
  }
  private async flushIce() {
    for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
  }

  async setMic(on: boolean) {
    this.resumeAudio();
    if (on && !this.mic) {
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (this.closed) { this.mic.getTracks().forEach((t) => t.stop()); return; }
        await this.tx.sender.replaceTrack(this.mic.getAudioTracks()[0] ?? null);
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
    this.pc.close();
    this.audio.srcObject = null;
    this.audio.remove();
    void this.actx?.close().catch(() => {});
  }
}
