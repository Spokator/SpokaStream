import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { duration, hueOf, initials } from "./format.ts";

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

/** Durée qui avance d'elle-même : pas besoin de redessiner toute la vue chaque seconde. */
export function Uptime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{duration(now - since)}</>;
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

/** Vrai quand la frappe est destinée à un champ : les raccourcis à une touche doivent alors se taire. */
export const isTyping = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement | null;
  return e.ctrlKey || e.altKey || e.metaKey || !!target?.closest("input, textarea, select, [contenteditable]") || !!document.querySelector(".modal-backdrop");
};

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

const POPOVER_GAP = 6;
const POPOVER_MARGIN = 10;
const POPOVER_MAX_HEIGHT = 460;

/**
 * Le menu vit hors de l'arbre, à la racine de la page : une fenêtre qui défile ou une tuile ne peut plus le couper.
 * En plein écran, seul l'élément affiché existe à l'écran : le menu s'attache donc à lui.
 */
export function Popover({ trigger, children, align = "left", up = false }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect();
      if (!anchor) return;
      const wanted = Math.min(element.scrollHeight + 2, POPOVER_MAX_HEIGHT);
      const below = window.innerHeight - anchor.bottom - POPOVER_GAP - POPOVER_MARGIN;
      const above = anchor.top - POPOVER_GAP - POPOVER_MARGIN;
      const goUp = up ? above >= wanted || above > below : below < wanted && above > below;
      const maxHeight = Math.min(wanted, goUp ? above : below);
      const width = element.offsetWidth;
      const left = Math.max(POPOVER_MARGIN, Math.min(align === "right" ? anchor.right - width : anchor.left, window.innerWidth - width - POPOVER_MARGIN));
      setStyle({ left, maxHeight, top: goUp ? anchor.top - POPOVER_GAP - maxHeight : anchor.bottom + POPOVER_GAP });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, up, align]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Échap ferme le menu, pas la fenêtre qui se trouve dessous.
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", close);
    };
  }, [open]);

  const toggle = () => {
    setStyle({ visibility: "hidden" });
    setOpen(!open);
  };

  return (
    <div className="popover-root" ref={root}>
      {trigger(open, toggle)}
      {open &&
        createPortal(
          <div className="popover" ref={panel} style={style}>
            {children(() => setOpen(false))}
          </div>,
          document.fullscreenElement ?? document.body,
        )}
    </div>
  );
}
