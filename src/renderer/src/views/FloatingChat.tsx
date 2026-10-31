import { useEffect, useState } from "react";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";
import { isTyping } from "../ui/kit.tsx";
import { MessageText } from "./Chat.tsx";

const CHAT_SHOWN_MS = 12_000;

export function useFullscreen(root: React.RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const update = () => setFullscreen(!!root.current && document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [root]);
  return fullscreen;
}

export const toggleFullscreen = (element: HTMLElement | null) => void (document.fullscreenElement ? document.exitFullscreen() : element?.requestFullscreen());

/** Quand le panneau n'est plus là, le chat vient sur l'image : on continue à lire et à répondre sans sortir du plein écran. */
export function FloatingChat() {
  const history = useApp(s => s.room?.history);
  const [now, setNow] = useState(Date.now());
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || isTyping(e)) return;
      e.preventDefault();
      setWriting(true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const recent = (history ?? []).filter(m => m.kind === "user" && (writing || now - m.at < CHAT_SHOWN_MS)).slice(-6);
  return (
    <div className="floating-chat">
      {recent.map(m => (
        <div key={m.id} className="floating-line">
          <b style={{ color: m.authorColor }}>{m.authorName}</b> {m.text ? <MessageText text={m.text} /> : "a envoyé une image"}
        </div>
      ))}
      {writing && (
        <input
          className="floating-input"
          autoFocus
          value={text}
          placeholder="Écris un message, Entrée pour envoyer"
          aria-label="Message rapide"
          onChange={e => setText(e.target.value)}
          onBlur={() => setWriting(false)}
          onKeyDown={e => {
            if (e.key === "Escape") setWriting(false);
            if (e.key !== "Enter") return;
            if (text.trim()) core.sendChat(text.trim());
            setText("");
            setWriting(false);
          }}
        />
      )}
    </div>
  );
}
