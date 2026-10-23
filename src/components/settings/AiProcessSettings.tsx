import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Ver = { id: number; at: string; by: string | null; chars: number };
type Doc = { content: string; at: string | null; version: number | null; versions: Ver[]; promptMode: "full" | "summary" };

const t = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("fi-FI", { timeZone: "Europe/Helsinki", day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/** "AI: prosessikuvaus" – editable markdown that is injected into every DeepSeek prompt. Each save = new version. */
export function AiProcessSettings() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch("/api/ai/process");
    const b = (await r.json()) as Doc;
    setDoc(b);
    setText(b.content);
  }, []);
  useEffect(() => { load().catch((e: Error) => toast.error(e.message)); }, [load]);
  if (!doc) return null;
  const dirty = text !== doc.content;
  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/ai/process", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      toast.success("Prosessikuvaus tallennettu");
      await load();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const loadVersion = async (id: number) => {
    const r = await fetch(`/api/ai/process/${id}`);
    const b = await r.json();
    if (r.ok) { setText(b.content); toast.message(`Versio ${t(b.at)} ladattu editoriin (tallenna ottaaksesi käyttöön)`); }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="ai-process">
      <div>
        <h2 className="text-sm font-semibold">AI: prosessikuvaus</h2>
        <p className="text-xs text-muted-foreground">
          Lisätään jokaiseen DeepSeek-kehotteeseen (PID-analyysi, poikkeamavalvoja, kirjanpitoassistentti tiivistelmänä).
          Yli 8000 merkin kuvauksesta käytetään vain osiota "## Tiivistelmä". Nyt: {doc.promptMode === "full" ? "koko teksti" : "tiivistelmä"}, {text.length} merkkiä.
        </p>
      </div>
      <textarea
        className="h-96 w-full rounded border border-input bg-background p-2 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!dirty || busy} onClick={save}>Tallenna uusi versio</Button>
        <Button size="sm" variant="outline" disabled={!dirty || busy} onClick={() => setText(doc.content)}>Peru muutokset</Button>
        <span className="text-xs text-muted-foreground">Voimassa: {t(doc.at)}</span>
      </div>
      {doc.versions.length > 1 && (
        <div className="space-y-1 text-xs">
          <div className="font-mono uppercase text-muted-foreground">Versiot</div>
          {doc.versions.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{t(v.at)}</span>
              <span className="text-muted-foreground">{v.by ?? "?"} · {v.chars} merkkiä</span>
              {v.id !== doc.version && <button type="button" className="underline" onClick={() => loadVersion(v.id)}>lataa editoriin</button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
