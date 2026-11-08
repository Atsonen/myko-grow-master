// Täyttöpumpun prosessisymboli ja lähdesäiliön arvio. Ei muuta FillPumpModal-tiedostoa.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  getFillSource, postFillSourceReference, postFillSourceRefill, setFillPump,
  type FillPumpResponse, type FillSourceEstimate,
} from "@/lib/apiClient";
import {
  ESTIMATE_LABEL, FILL_GRAPHIC, buildFillPresentation, fillActionEffect, renderFillPumpInner, sourceDialogModel,
} from "@/lib/fillPumpScene.js";

export function useFillSourcePanel() {
  const [est, setEst] = useState<FillSourceEstimate | null>(null);
  const [estError, setEstError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [refText, setRefText] = useState("1320");
  const [busy, setBusy] = useState(false);
  const reload = () => getFillSource()
    .then((d) => { setEst(d); setEstError(null); return d; })
    .catch((e) => { setEstError(e instanceof Error ? e.message : String(e)); return null; });
  useEffect(() => {
    let alive = true;
    const load = () => {
      getFillSource()
        .then((d) => { if (alive) { setEst(d); setEstError(null); } })
        .catch((e) => { if (alive) setEstError(e instanceof Error ? e.message : String(e)); });
    };
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { est, estError, open, setOpen, refText, setRefText, busy, setBusy, reload };
}

export function FillPumpSvg({
  editing, fill, panel, onOpenModal, onChanged,
}: {
  editing: boolean;
  fill: FillPumpResponse | null;
  panel: ReturnType<typeof useFillSourcePanel>;
  onOpenModal: () => void;
  onChanged: () => void;
}) {
  const host = useRef<SVGGElement>(null);
  const pres = buildFillPresentation(fill, panel.est, panel.estError);
  const markup = renderFillPumpInner(pres, { interactive: !editing });
  const ctx = useRef({ pres, panel, onOpenModal, onChanged });
  ctx.current = { pres, panel, onOpenModal, onChanged };

  useEffect(() => {
    const el = host.current;
    if (!el || editing) return;
    const onClick = (ev: Event) => {
      const hit = (ev.target as Element | null)?.closest?.("[data-action]");
      const action = hit?.getAttribute("data-action");
      if (!action) return;
      ev.stopPropagation();
      ev.preventDefault();
      const { pres: p, panel: pan, onOpenModal: openModal, onChanged: changed } = ctx.current;
      const effect = fillActionEffect(action, { ...p, busy: pan.busy });
      if (effect.type === "open-modal") openModal();
      else if (effect.type === "open-source") {
        pan.setRefText(String(pan.est?.referenceS ?? 1320));
        pan.setOpen(true);
      } else if (effect.type === "confirm-enable") {
        if (!window.confirm(effect.confirmText)) return;
        pan.setBusy(true);
        setFillPump({ Cfg_Enable: effect.next })
          .then(() => { toast.success(effect.next ? "Täyttö sallittu" : "Täyttö estetty"); changed(); })
          .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
          .finally(() => pan.setBusy(false));
      }
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [editing]);

  return (
    <g
      ref={host}
      transform={`translate(${FILL_GRAPHIC.x} ${FILL_GRAPHIC.y})`}
      data-testid="fill-pump-graphic"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export function FillSourceDialog({ panel }: { panel: ReturnType<typeof useFillSourcePanel> }) {
  const dialog = sourceDialogModel(panel.est);
  const commitRefill = () => {
    const effect = fillActionEffect("refill", { busy: panel.busy });
    if (effect.type !== "confirm-refill" || !window.confirm(effect.confirmText)) return;
    const idempotencyKey = crypto.randomUUID();
    panel.setBusy(true);
    postFillSourceRefill(idempotencyKey)
      .then(() => panel.reload())
      .then((d) => { if (d) toast.success("Säiliö merkitty täydeksi"); })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => panel.setBusy(false));
  };
  const commitReference = () => {
    const effect = fillActionEffect("reference", { busy: panel.busy });
    const n = Number(panel.refText);
    if (!Number.isInteger(n) || n < 60 || n > 86400) {
      toast.error("Viite 60–86400 s");
      return;
    }
    if (effect.type !== "confirm-reference" || !window.confirm(`${effect.confirmText}\n${panel.est?.referenceS ?? 1320} s → ${n} s`)) return;
    panel.setBusy(true);
    postFillSourceReference(n, crypto.randomUUID())
      .then(() => panel.reload())
      .then((d) => { if (d) { panel.setRefText(String(d.referenceS)); toast.success(`Viite ${d.referenceS} s`); } })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => panel.setBusy(false));
  };
  return (
    <Dialog open={panel.open} onOpenChange={panel.setOpen}>
      <DialogContent className="max-w-md font-mono" data-testid="fill-source-dialog">
        <DialogHeader><DialogTitle>{dialog.title}</DialogTitle></DialogHeader>
        <div className="space-y-2 text-sm">
          <p>{dialog.label}</p>
          <p className="text-xs text-muted-foreground">{dialog.meaning}</p>
          <p data-testid="fill-source-now">
            {dialog.available ? `${dialog.coarsePct} % · kertymä ${dialog.accumulatedS} s / viite ${dialog.referenceS} s` : dialog.noAnchor}
          </p>
          {dialog.coarsePct === 0 && <p>{dialog.zeroNote}</p>}
          <p className="text-xs text-muted-foreground">{panel.est?.qualityNote}</p>
          {panel.estError && <p className="text-xs text-red-400">{panel.estError}</p>}
          <button type="button" disabled={panel.busy} data-testid="fill-source-refill" className="rounded bg-sky-700 px-3 py-1 text-white disabled:opacity-40" onClick={commitRefill}>
            {dialog.fullRefill}
          </button>
          <p className="text-xs text-muted-foreground">{dialog.fullRefillHelp}</p>
          <label className="block text-xs">
            Viiteaika (s)
            <input data-testid="fill-source-ref" className="mt-1 h-8 w-full rounded border border-border bg-background px-2" value={panel.refText} onChange={(e) => panel.setRefText(e.target.value)} />
          </label>
          <button type="button" disabled={panel.busy} className="rounded border border-border px-3 py-1 disabled:opacity-40" onClick={commitReference}>Tallenna viite</button>
          <p className="text-xs text-muted-foreground">{dialog.refHelp}</p>
          {dialog.refLog.length > 0 && (
            <ul className="max-h-28 overflow-auto text-xs text-muted-foreground">
              {dialog.refLog.slice(-5).reverse().map((r, i) => (
                <li key={`${r.at}-${i}`}>{r.at} · {r.oldS} s → {r.newS} s</li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">{ESTIMATE_LABEL}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
