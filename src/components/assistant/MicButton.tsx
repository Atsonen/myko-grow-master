// Puheentunnistus (fi): MediaRecorder -> POST /api/stt (paikallinen faster-whisper, nginx -> 127.0.0.1:5320).
// Pysähtyy toisesta painalluksesta tai ~1,6 s hiljaisuuden jälkeen (max 30 s). Varalla selaimen Web Speech API.
// Mikrofoni vaatii suojatun yhteyden (https://…); http:llä nappi kertoo ohjeen.
import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2 } from "lucide-react";
type St = "idle" | "rec" | "busy";
export function MicButton({ onText, disabled }: { onText: (t: string, auto: boolean) => void; disabled?: boolean }) {
  const [st, setSt] = useState<St>("idle"); const [msg, setMsg] = useState("");
  const [auto, setAuto] = useState(() => typeof localStorage !== "undefined" && localStorage.getItem("stt_autosend") === "1");
  const R = useRef<{ mr?: MediaRecorder; stream?: MediaStream; ctx?: AudioContext; raf?: number; t0?: number }>({});
  useEffect(() => () => stopAll(), []);
  function stopAll() { const r = R.current; if (r.raf) cancelAnimationFrame(r.raf); r.stream?.getTracks().forEach((t) => t.stop()); r.ctx?.close().catch(() => {}); R.current = {}; }
  function webSpeech(): boolean {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition; if (!SR) return false;
    const r = new SR(); r.lang = "fi-FI"; r.interimResults = false; r.maxAlternatives = 1; setSt("rec"); setMsg("Kuunnellaan (selain)…");
    r.onresult = (e: any) => { const t = e.results[0][0].transcript; setMsg(""); onText(t, auto); };
    r.onerror = (e: any) => setMsg("Puhe: " + e.error); r.onend = () => setSt("idle"); r.start(); return true;
  }
  async function start() {
    setMsg("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setMsg("Mikrofoni vaatii https-yhteyden: avaa https://" + location.hostname + location.pathname); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { setMsg("Mikrofonia ei saatu: " + String((e as Error).message || e)); return; }
    const mime = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => (window as any).MediaRecorder?.isTypeSupported?.(m)) || "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      stopAll(); setSt("busy"); setMsg("Tunnistetaan…");
      try {
        const r = await fetch("/api/stt", { method: "POST", body: new Blob(chunks, { type: mr.mimeType || "audio/webm" }) });
        const d = await r.json(); if (!r.ok) throw new Error(d.detail || r.status);
        setMsg(d.text ? `${(d.ms / 1000).toFixed(1)} s` : "Ei tunnistettua puhetta"); if (d.text) onText(d.text, auto);
      } catch (e) { setMsg("Palvelin ei vastannut – kokeillaan selaimen tunnistusta"); if (!webSpeech()) setMsg("Tunnistus epäonnistui: " + String((e as Error).message || e)); return; }
      setSt("idle");
    };
    const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 1024; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize); let spoke = false, quietSince = 0; const t0 = performance.now();
    const tick = () => {
      an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; const rms = Math.sqrt(s / buf.length), now = performance.now();
      if (rms > 0.02) { spoke = true; quietSince = 0; } else if (spoke && !quietSince) quietSince = now;
      if ((spoke && quietSince && now - quietSince > 1600) || now - t0 > 30000) { if (mr.state === "recording") mr.stop(); return; }
      R.current.raf = requestAnimationFrame(tick);
    };
    R.current = { mr, stream, ctx, t0 }; mr.start(); setSt("rec"); setMsg("Puhu nyt… (paina uudelleen lopettaaksesi)"); tick();
  }
  function click() { if (st === "rec") { const mr = R.current.mr; if (mr && mr.state === "recording") mr.stop(); else setSt("idle"); } else if (st === "idle") start(); }
  return (
    <div className="flex flex-col items-center">
      <button type="button" data-testid="as-mic" disabled={disabled || st === "busy"} onClick={click} title="Puhu (suomi)"
        className={"px-2 rounded " + (st === "rec" ? "text-red-500 animate-pulse" : "")}>
        {st === "busy" ? <Loader2 className="h-4 w-4 animate-spin" /> : st === "rec" ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <label className="text-[10px] text-muted-foreground flex items-center gap-0.5" title="Lähetä tunnistettu teksti heti">
        <input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); localStorage.setItem("stt_autosend", e.target.checked ? "1" : "0"); }} />auto</label>
      {msg ? <div data-testid="as-mic-msg" className="absolute bottom-14 right-2 max-w-[80%] rounded bg-background/95 border px-2 py-0.5 text-[11px] text-muted-foreground">{msg}</div> : null}
    </div>
  );
}
