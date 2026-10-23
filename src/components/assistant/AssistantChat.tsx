import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { MessageSquare, X, Paperclip, Send, Check, Ban, Printer } from "lucide-react";
import { requestJson } from "@/lib/apiClient";

type Card = { id: string; action: "create" | "move" | "event"; body: any; preview: any };
type Msg = { role: "user" | "assistant" | "system"; text: string; cards?: Card[]; labels?: string[] };
const SIZES = ["30x12", "40x12", "22x12", "30x15", "50x30"];
const ACT: Record<string, string> = { create: "Luo yksiköt", move: "Siirrä / muuta tila", event: "Kirjaa tapahtuma" };

function labelUrl(codes: string[], size: string, format: string) {
  return `/api/labels?codes=${encodeURIComponent(codes.join(","))}&size=${size}&format=${format}`;
}

function Preview({ c }: { c: Card }) {
  const p = c.preview || {};
  if (c.action === "create") {
    const u = p.unit || {};
    return (
      <div className="text-xs space-y-1">
        <div>{(p.codes || []).length} kpl · {u.type} · {u.substrate || "—"} · kanta {u.strainCode || "—"} · {u.location || "—"} · {u.status}</div>
        <div>Erä-aika: {u.batchTime ? new Date(u.batchTime).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki" }) : "—"}</div>
        {u.origins?.length ? <div>Alkuperä: {u.origins.map((o: any) => o.parent || o.type).join(", ")}</div> : null}
        <div className="font-mono break-words">{(p.codes || []).join(", ")}</div>
      </div>
    );
  }
  if (c.action === "move") {
    return (
      <table className="text-xs w-full" data-testid="as-move-table"><thead><tr className="text-left text-muted-foreground"><th>ID</th><th>Ennen</th><th>Jälkeen</th></tr></thead>
        <tbody>{(p.units || []).map((u: any) => (
          <tr key={u.code} className={u.changed ? "" : "opacity-50"}><td className="font-mono">{u.code}</td>
            <td>{u.before?.location} / {u.before?.status}</td><td className="font-semibold">{u.after?.location} / {u.after?.status}</td></tr>))}
        </tbody></table>
    );
  }
  return <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(p.events || p, null, 1).slice(0, 1200)}</pre>;
}

function Labels({ codes }: { codes: string[] }) {
  const [size, setSize] = useState("30x12");
  return (
    <div className="mt-2 rounded border p-2 text-xs space-y-1" data-testid="as-labels">
      <div className="font-semibold">Tarrat ({codes.length}) – NIIMBOT D110</div>
      <div className="flex flex-wrap gap-1 items-center">
        <select value={size} onChange={(e) => setSize(e.target.value)} className="border rounded px-1 bg-background">
          {SIZES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <a className="underline" href={labelUrl(codes, size, codes.length === 1 ? "png" : "zip")}>{codes.length === 1 ? "PNG" : "ZIP (PNG)"}</a>
        <a className="underline" href={labelUrl(codes, size, "pdf")}>PDF</a>
        <a className="underline" href={labelUrl(codes, size, "xlsx")}>Lataa tarralista (Excel)</a>
        <a className="underline" href={`/api/labels.csv?codes=${encodeURIComponent(codes.join(","))}`}>CSV</a>
        <button className="inline-flex items-center gap-1 underline" title="Lataa PNG ja avaa niim.blue (Chrome/Edge, Bluetooth)"
          onClick={() => { window.open(labelUrl(codes.slice(0, 1), size, "png"), "_blank"); window.open("https://niim.blue/", "_blank"); }}>
          <Printer className="h-3 w-3" />Tulosta Niimbotille</button>
      </div>
      <img alt="tarra" className="border bg-white" style={{ imageRendering: "pixelated", height: 48 }} src={labelUrl(codes.slice(0, 1), size, "png") + "&inline=1"} />
    </div>
  );
}

export function AssistantChat() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: "assistant", text: "Hei! Voin luoda yksiköitä, siirtää niitä ja kirjata tapahtumia. Voit liittää kuvan tarroista (QR/viivakoodi). Mitään ei tallenneta ilman vahvistustasi." }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploads, setUploads] = useState<{ id: string; name: string; info: string }[]>([]);
  const [done, setDone] = useState<Record<string, string>>({});
  const sid = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy, open]);
  if (!(path === "/" || path.startsWith("/plants"))) return null;

  const push = (m: Msg) => setMsgs((x) => [...x, m]);
  async function send() {
    if (!text.trim() && !uploads.length) return;
    const t = text.trim() || "Katso liitetty kuva.";
    push({ role: "user", text: t + (uploads.length ? `  📎 ${uploads.map((u) => u.name).join(", ")}` : "") });
    setText(""); setBusy(true);
    try {
      const r = await requestJson<any>("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: sid.current, text: t, uploadIds: uploads.map((u) => u.id) }) });
      sid.current = r.sessionId; setUploads([]);
      push({ role: "assistant", text: r.reply || "", cards: r.cards });
    } catch (e: any) { push({ role: "system", text: "Virhe: " + (e?.message || e) }); }
    setBusy(false);
  }
  async function upload(f: File) {
    setBusy(true);
    try {
      const b64 = await new Promise<string>((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(f); });
      const r = await requestJson<any>("/api/assistant/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.name, dataBase64: b64, sessionId: sid.current }) });
      const codes = [...(r.qr || []), ...(r.barcodes || [])];
      const info = `${r.method}: ${codes.length ? codes.join(", ") : "ei koodeja"}${r.unknown?.length ? ` (tuntemattomat: ${r.unknown.join(", ")})` : ""}`;
      setUploads((u) => [...u, { id: r.id, name: f.name, info }]);
      push({ role: "system", text: `Kuva ${f.name} – ${info}${r.exif?.DateTimeOriginal ? ` · kuvattu ${r.exif.DateTimeOriginal}` : ""}` });
    } catch (e: any) { push({ role: "system", text: "Kuvan käsittely epäonnistui: " + (e?.message || e) }); }
    setBusy(false);
  }
  async function decide(c: Card, ok: boolean) {
    setBusy(true);
    try {
      if (!ok) { await requestJson("/api/assistant/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: c.id }) }); setDone((d) => ({ ...d, [c.id]: "Hylätty" })); }
      else {
        const r = await requestJson<any>("/api/assistant/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: c.id }) });
        setDone((d) => ({ ...d, [c.id]: "Tallennettu" }));
        push({ role: "system", text: "Tallennettu kirjanpitoon (lähde: assistant).", labels: r.labels?.length ? r.labels : undefined });
      }
    } catch (e: any) { push({ role: "system", text: "Tallennus epäonnistui: " + (e?.message || e) }); }
    setBusy(false);
  }

  if (!open) return (
    <button data-testid="as-open" onClick={() => setOpen(true)} className="fixed bottom-4 right-4 z-50 inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-4 py-3 shadow-lg">
      <MessageSquare className="h-4 w-4" />Assistentti</button>
  );
  return (
    <div data-testid="as-panel" className="fixed bottom-4 right-4 z-50 w-[min(440px,calc(100vw-2rem))] h-[min(640px,calc(100vh-6rem))] flex flex-col rounded-lg border bg-background shadow-2xl">
      <div className="flex items-center justify-between border-b px-3 py-2"><div className="font-semibold text-sm">Assistentti</div>
        <button onClick={() => setOpen(false)} aria-label="Sulje"><X className="h-4 w-4" /></button></div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 text-sm">
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "ml-8 rounded bg-primary/10 p-2" : m.role === "system" ? "text-xs text-muted-foreground" : "mr-4 rounded bg-muted p-2"}>
            <div className="whitespace-pre-wrap">{m.text}</div>
            {m.cards?.map((c) => (
              <div key={c.id} data-testid="as-card" className="mt-2 rounded border-2 border-amber-500 bg-background p-2 space-y-2">
                <div className="text-xs font-semibold uppercase">Vahvista: {ACT[c.action] || c.action}</div>
                <Preview c={c} />
                {done[c.id] ? <div className="text-xs font-semibold">{done[c.id]}</div> : (
                  <div className="flex gap-2">
                    <button data-testid="as-confirm" disabled={busy} onClick={() => decide(c, true)} className="inline-flex items-center gap-1 rounded bg-green-600 text-white px-3 py-1 text-xs"><Check className="h-3 w-3" />Vahvista</button>
                    <button data-testid="as-reject" disabled={busy} onClick={() => decide(c, false)} className="inline-flex items-center gap-1 rounded border px-3 py-1 text-xs"><Ban className="h-3 w-3" />Hylkää</button>
                  </div>)}
              </div>))}
            {m.labels ? <Labels codes={m.labels} /> : null}
          </div>))}
        {busy ? <div className="text-xs text-muted-foreground">Mietitään…</div> : null}
      </div>
      {uploads.length ? <div className="px-3 text-xs text-muted-foreground">📎 {uploads.map((u) => u.name).join(", ")}</div> : null}
      <div className="flex gap-1 border-t p-2">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" data-testid="as-file" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} title="Liitä kuva" className="px-2"><Paperclip className="h-4 w-4" /></button>
        <textarea data-testid="as-input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="esim. luo viisi purkkia…" className="flex-1 resize-none rounded border bg-background px-2 py-1 text-sm"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!busy) send(); } }} />
        <button data-testid="as-send" disabled={busy} onClick={send} className="px-2"><Send className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
export default AssistantChat;
