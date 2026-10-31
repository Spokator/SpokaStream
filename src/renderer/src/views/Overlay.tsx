import { Gamepad2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OverlayEvent, OverlayRegion, OverlaySettings } from "@shared/ipc.ts";
import { StrokeCanvas } from "../ui/strokes.ts";

interface ChatLine {
  id: number;
  name: string;
  color: string;
  text: string;
}

interface Floating {
  id: number;
  emoji: string;
  left: number;
  name: string;
}

/** Calque posé sur l'écran du diffuseur. Rien n'y est cliquable et il n'apparaît pas dans le stream. */
export function OverlayView() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [viewers, setViewers] = useState(0);
  const [region, setRegion] = useState<OverlayRegion | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [reactions, setReactions] = useState<Floating[]>([]);
  const [poll, setPoll] = useState<Extract<OverlayEvent, { type: "poll" }>["poll"]>(null);
  const [control, setControl] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const strokes = new StrokeCanvas(canvas.current!);
    let next = 0;
    const off = window.spoka.onOverlayEvent((event: OverlayEvent) => {
      switch (event.type) {
        case "settings":
          return setSettings(event.settings);
        case "region":
          return setRegion(event.region);
        case "viewers":
          return setViewers(event.count);
        case "poll":
          return setPoll(event.poll);
        case "control":
          return setControl(event.text);
        case "stroke":
          return strokes.add(event.id, event.tool, event.color, event.points, event.end);
        case "clear":
          return strokes.clear();
        case "chat": {
          const id = ++next;
          setChat(list => [...list.slice(-4), { id, name: event.name, color: event.color, text: event.text }]);
          setTimeout(() => setChat(list => list.filter(l => l.id !== id)), 9000);
          return;
        }
        case "reaction": {
          const id = ++next;
          setReactions(list => [...list.slice(-20), { id, emoji: event.emoji, left: 4 + Math.random() * 14, name: event.name }]);
          setTimeout(() => setReactions(list => list.filter(r => r.id !== id)), 3000);
          return;
        }
      }
    });
    return () => {
      off();
      strokes.dispose();
    };
  }, []);

  return (
    <div className="overlay" style={region ? { left: region.x, top: region.y, width: region.width, height: region.height, right: "auto", bottom: "auto" } : undefined}>
      <canvas ref={canvas} className="overlay-canvas" />
      {control && (
        <div className="overlay-control">
          <Gamepad2 size={16} />
          {control}
        </div>
      )}
      {settings && (
        <div className={`overlay-corner ${settings.corner}`} style={{ zoom: settings.size ?? 1, opacity: settings.opacity ?? 1 }}>
          {settings.viewers && (
            <div className="overlay-viewers">
              <i />
              <Users size={14} />
              {viewers}
            </div>
          )}
          {settings.chat &&
            chat.map(line => (
              <div key={line.id} className="overlay-chat">
                <b style={{ color: line.color }}>{line.name}</b> {line.text}
              </div>
            ))}
          {settings.chat && poll && (
            <div className="overlay-poll">
              <b>{poll.question}</b>
              {poll.options.map(option => (
                <div key={option.text}>
                  <span>{option.text}</span>
                  <em>{option.votes}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {settings?.reactions && (
        <div className="reactions is-overlay">
          {reactions.map(r => (
            <span key={r.id} className="reaction" style={{ left: `${r.left}%` }}>
              {r.emoji}
              <small>{r.name}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
