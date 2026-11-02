/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import type { AccountLimits } from "@shared/protocol.ts";
import { NO_LIMITS } from "@shared/protocol.ts";

const HEIGHTS = [0, 2160, 1440, 1080, 720, 480, 360];
const RATES = [0, 60, 30, 15];

/** Le débit en Mb/s pour la personne qui lit, en kb/s pour le serveur. */
const megabits = (kbps: number) => (kbps ? String(kbps / 1000) : "");

export function limitsSummary(limits: AccountLimits | null | undefined) {
  if (!limits) return "";
  const parts: string[] = [];
  if (limits.maxKbps) parts.push(`${limits.maxKbps / 1000} Mb/s`);
  if (limits.maxHeight) parts.push(`${limits.maxHeight}p`);
  if (limits.maxFps) parts.push(`${limits.maxFps} i/s`);
  if (limits.maxViewers) parts.push(`${limits.maxViewers} spect.`);
  if (!limits.canStream) parts.push("pas de direct");
  if (!limits.canUseRelay) parts.push("pas de relais");
  if (!limits.canCreateRooms) parts.push("pas de salon");
  if (!limits.canWatchParty) parts.push("pas de Watch Party");
  return parts.join(", ");
}

interface Props {
  value: AccountLimits | null;
  /** Le nom de ce qu'on règle, pour les lecteurs d'écran. */
  label: string;
  onApply: (limits: AccountLimits) => void;
  onClear: () => void;
  clearLabel: string;
  /** Pour un compte seulement : les limites du serveur n'expirent pas. */
  children?: preact.ComponentChildren;
}

export function LimitsForm({ value, label, onApply, onClear, clearLabel, children }: Props) {
  const [draft, setDraft] = useState<AccountLimits>({ ...NO_LIMITS, ...value });
  const change = (patch: Partial<AccountLimits>) => setDraft({ ...draft, ...patch });
  // Gardé tel que tapé : relu à chaque touche, « 2.05 » deviendrait 2 puis 25.
  const [rate, setRate] = useState(megabits(value?.maxKbps ?? 0));
  const writeRate = (text: string) => {
    setRate(text);
    change({ maxKbps: Math.round((Number(text.replace(",", ".")) || 0) * 1000) });
  };
  const whole = (text: string) => Math.max(0, Math.round(Number(text.replace(",", ".")) || 0));
  return (
    <div class="limits">
      <div class="form-grid">
        <label class="form-field">
          <span>Débit total envoyé, en Mb/s</span>
          <input inputMode="decimal" value={rate} placeholder="Sans limite" aria-label={`Débit de ${label}`} onInput={e => writeRate(e.currentTarget.value)} />
        </label>
        <label class="form-field">
          <span>Spectateurs par stream</span>
          <input type="number" min={0} value={draft.maxViewers || ""} placeholder="Sans limite" aria-label={`Spectateurs de ${label}`} onInput={e => change({ maxViewers: whole(e.currentTarget.value) })} />
        </label>
        <label class="form-field">
          <span>Définition</span>
          <select value={draft.maxHeight} aria-label={`Définition de ${label}`} onChange={e => change({ maxHeight: Number(e.currentTarget.value) })}>
            {HEIGHTS.map(height => (
              <option key={height} value={height}>
                {height ? `${height}p` : "Sans limite"}
              </option>
            ))}
          </select>
        </label>
        <label class="form-field">
          <span>Cadence</span>
          <select value={draft.maxFps} aria-label={`Cadence de ${label}`} onChange={e => change({ maxFps: Number(e.currentTarget.value) })}>
            {RATES.map(rate => (
              <option key={rate} value={rate}>
                {rate ? `${rate} i/s` : "Sans limite"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label class="tool-check">
        <input type="checkbox" checked={draft.canStream} onChange={e => change({ canStream: e.currentTarget.checked })} /> Peut lancer un direct
      </label>
      <label class="tool-check">
        <input type="checkbox" checked={draft.canUseRelay} onChange={e => change({ canUseRelay: e.currentTarget.checked })} /> Peut passer par le relais du serveur
      </label>
      <label class="tool-check">
        <input type="checkbox" checked={draft.canCreateRooms} onChange={e => change({ canCreateRooms: e.currentTarget.checked })} /> Peut créer des salons
      </label>
      <label class="tool-check">
        <input type="checkbox" checked={draft.canWatchParty} onChange={e => change({ canWatchParty: e.currentTarget.checked })} /> Peut lancer une Watch Party
      </label>
      <div class="tool-row">
        {children}
        <button type="button" class="primary" onClick={() => onApply(draft)}>
          Appliquer
        </button>
        {value && (
          <button type="button" onClick={onClear}>
            {clearLabel}
          </button>
        )}
      </div>
    </div>
  );
}
