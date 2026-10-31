import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { hueOf, initials } from "./format.ts";

type Variant = "default" | "primary" | "live" | "danger" | "ghost";

export function Button({ variant = "default", icon, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode }) {
  return (
    <button type="button" className={`btn btn-${variant} ${className}`} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, active, danger, children, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; danger?: boolean }) {
  return (
    <button type="button" title={label} aria-label={label} className={`icon-btn ${active ? "is-active" : ""} ${danger ? "is-danger" : ""} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Slider({ value, min, max, step = 1, onChange, label, className = "" }: { value: number; min: number; max: number; step?: number; onChange: (value: number) => void; label: string; className?: string }) {
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      aria-label={label}
      className={`slider ${className}`}
      value={value}
      min={min}
      max={max}
      step={step}
      style={{ "--fill": `${percent}%` } as React.CSSProperties}
      onChange={e => onChange(Number(e.target.value))}
    />
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "is-on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <select
      className="select"
      aria-label={label}
      value={String(value)}
      onChange={e => {
        const picked = options.find(o => String(o.value) === e.target.value);
        if (picked) onChange(picked.value);
      }}
    >
      {options.map(o => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-text">
        <div className="field-label">{label}</div>
        {hint && <div className="field-hint">{hint}</div>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function Avatar({ name, color, src, size = 32, ring }: { name: string; color?: string; src?: string | null; size?: number; ring?: boolean }) {
  const background = color ?? `hsl(${hueOf(name)} 55% 50%)`;
  return (
    <span className={`avatar ${ring ? "is-speaking" : ""}`} style={{ width: size, height: size, fontSize: size * 0.38, background }}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

/** Le niveau se met à jour à 60 images/s en touchant le DOM directement : ça ne coûte aucun rendu React. */
export function Meter({ read }: { read: () => number }) {
  const bar = useRef<HTMLElement>(null);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    let frame = 0;
    let shown = 0;
    const tick = () => {
      const next = Math.max(reader.current(), shown * 0.9);
      shown = next;
      if (bar.current) bar.current.style.width = `${Math.round(next * 100)}%`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="meter" aria-hidden>
      <i ref={bar} />
    </div>
  );
}

export function Modal({ title, onClose, children, width = 560, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title} style={{ width }}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton label="Fermer" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Popover({ trigger, children, align = "left", up = false }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="popover-root" ref={root}>
      {trigger(open, () => setOpen(!open))}
      {open && <div className={`popover ${align === "right" ? "is-right" : ""} ${up ? "is-up" : ""}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
