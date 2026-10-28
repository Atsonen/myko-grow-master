import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getSensorBlockConfig, putSensorBlockConfig } from "@/lib/apiClient";
import { toast } from "sonner";

export function SensorBlockSettings() {
  const [text, setText] = useState("SensorBlock_1\nSensorBlock_2\nSensorBlock_3");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getSensorBlockConfig()
      .then((c) => setText((c.devices ?? []).join("\n")))
      .catch(() => undefined);
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      const devices = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      const r = await putSensorBlockConfig(devices);
      setText(r.devices.join("\n"));
      toast.success("SensorBlock-laitteet tallennettu");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4 space-y-3" data-testid="sb-settings">
      <div>
        <h2 className="text-sm font-mono uppercase text-muted-foreground">SensorBlock-laitteet</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Yksi laite / rivi (MQTT Sensors/nimi). Oletus SensorBlock_1–3. Tallennus backend-asetukseen.
        </p>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full rounded border border-input bg-background p-2 font-mono text-xs"
        data-testid="sb-settings-list"
      />
      <Button size="sm" disabled={busy} onClick={() => void save()} data-testid="sb-settings-save">Tallenna</Button>
    </Card>
  );
}
