import { CornerUpLeft, MessageCircle, Reply, SendHorizontal, Smile, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "@shared/protocol.ts";
import { LIMITS } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { set, useApp } from "../state/store.ts";
import { clock } from "../ui/format.ts";
import { IconButton, Popover } from "../ui/kit.tsx";

const EMOJIS = ["😂", "🔥", "😮", "❤️", "👏", "💀", "🎉", "👀", "😭", "🙏", "😎", "🤯", "👍", "👎", "😅", "🥲", "🤣", "😍", "🤔", "😡"];

const URL_PATTERN = /(https?:\/\/[^\s<]+)/g;

function MessageText({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_PATTERN).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            onClick={e => {
              e.preventDefault();
              window.spoka.openExternal(part);
            }}
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function Message({ message, grouped, reply, canDelete }: { message: ChatMessage; grouped: boolean; reply: ChatMessage | undefined; canDelete: boolean }) {
  if (message.kind === "system") return <div className="chat-system">{message.text}</div>;
  return (
    <div className={`chat-message ${grouped ? "is-grouped" : ""}`}>
      {reply && (
        <div className="chat-reply">
          <CornerUpLeft size={12} />
          <b>{reply.authorName}</b>
          <span>{reply.text}</span>
        </div>
      )}
      {!grouped && (
        <div className="chat-head">
          <b style={{ color: message.authorColor }}>{message.authorName}</b>
          <time>{clock(message.at)}</time>
        </div>
      )}
      <div className="chat-text">
        <MessageText text={message.text} />
      </div>
      <div className="chat-actions">
        <IconButton label="Répondre" onClick={() => set({ replyTo: message })}>
          <Reply size={14} />
        </IconButton>
        {canDelete && (
          <IconButton label="Supprimer" onClick={() => core.deleteChat(message.id)}>
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

export function Chat() {
  const history = useApp(s => s.room!.history);
  const userId = useApp(s => s.userId);
  const ownerId = useApp(s => s.room!.ownerId);
  const replyTo = useApp(s => s.replyTo);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  const send = () => {
    const value = text.trim();
    if (!value) return;
    core.sendChat(value);
    setText("");
    pinned.current = true;
  };

  const hasMessages = history.some(m => m.kind === "user");

  return (
    <div className="chat">
      <div
        className="chat-list"
        ref={list}
        onScroll={e => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!hasMessages && (
          <div className="panel-empty">
            <MessageCircle size={26} />
            <p>Pas encore de message. Dis bonjour.</p>
          </div>
        )}
        {history.map((m, i) => {
          const previous = history[i - 1];
          const grouped = !!previous && previous.kind === "user" && m.kind === "user" && previous.authorId === m.authorId && m.at - previous.at < 180_000 && !m.replyTo;
          return <Message key={m.id} message={m} grouped={grouped} reply={m.replyTo ? history.find(h => h.id === m.replyTo) : undefined} canDelete={m.authorId === userId || ownerId === userId} />;
        })}
      </div>
      {replyTo && (
        <div className="chat-replying">
          <span>
            Réponse à <b>{replyTo.authorName}</b>
          </span>
          <IconButton label="Annuler" onClick={() => set({ replyTo: null })}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      <div className="chat-input">
        <textarea
          ref={input}
          rows={1}
          value={text}
          maxLength={LIMITS.chat}
          placeholder="Écris un message"
          aria-label="Message"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Popover
          up
          align="right"
          trigger={(open, toggle) => (
            <IconButton label="Émojis" active={open} onClick={toggle}>
              <Smile size={18} />
            </IconButton>
          )}
        >
          {close => (
            <div className="reaction-grid is-chat">
              {EMOJIS.map(e => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    setText(t => t + e);
                    close();
                    input.current?.focus();
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </Popover>
        <IconButton label="Envoyer" disabled={!text.trim()} onClick={send}>
          <SendHorizontal size={18} />
        </IconButton>
      </div>
    </div>
  );
}
