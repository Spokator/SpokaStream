import { CornerUpLeft, ImagePlus, MessageCircle, Pin, PinOff, Play, Plus, Reply, SendHorizontal, Smile, SmilePlus, TvMinimalPlay, Trash2, Vote, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ChatMessage } from "@shared/protocol.ts";
import { LIMITS } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { get, memberOf, set, toast, useApp } from "../state/store.ts";
import { clock, mentionsName } from "../ui/format.ts";
import { compressImage } from "../ui/image.ts";
import { IconButton, Popover } from "../ui/kit.tsx";
import { PollCard } from "./Poll.tsx";

const EMOJIS = ["😂", "🔥", "😮", "❤️", "👏", "💀", "🎉", "👀", "😭", "🙏", "😎", "🤯", "👍", "👎", "😅", "🥲", "🤣", "😍", "🤔", "😡"];
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "😮", "😭", "🎉", "💀"];

const URL_PATTERN = /(https?:\/\/[^\s<]+)/g;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Les liens s'ouvrent dans le navigateur, et les @noms du salon ressortent dans le texte. */
export function MessageText({ text }: { text: string }) {
  const members = useApp(s => s.room?.members);
  const mention = useMemo(() => new RegExp(`(@(?:${[...(members ?? []).map(m => escapeRegex(m.name)), "tous"].join("|")}))`, "gi"), [members]);
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
          part.split(mention).map((piece, j) =>
            j % 2 ? (
              <span key={`${i}-${j}`} className="mention">
                {piece}
              </span>
            ) : (
              piece
            ),
          )
        ),
      )}
    </>
  );
}

function Reactions({ message }: { message: ChatMessage }) {
  const userId = useApp(s => s.userId);
  const entries = Object.entries(message.reactions ?? {});
  if (!entries.length) return null;
  return (
    <div className="chat-reactions">
      {entries.map(([emoji, voters]) => (
        <button key={emoji} type="button" className={voters.includes(userId) ? "is-mine" : ""} title={voters.map(id => memberOf(id)?.name ?? "Parti").join(", ")} onClick={() => core.reactChat(message.id, emoji)}>
          {emoji} <b>{voters.length}</b>
        </button>
      ))}
    </div>
  );
}

function ClipCard({ message }: { message: ChatMessage }) {
  const clip = message.clip!;
  const share = useApp(s => (s.clipLoading?.id === clip.id ? s.clipLoading.share : null));
  const here = useApp(s => s.room!.members.some(m => m.id === message.authorId && m.online));
  return (
    <button type="button" className="chat-clip" disabled={!here || share !== null} aria-label={`Ouvrir le clip ${clip.title}`} onClick={() => void core.openClip(message)}>
      {clip.thumb ? <img src={clip.thumb} alt="" /> : <span className="chat-clip-empty" />}
      {here && (
        <span className="chat-clip-play">
          <Play size={18} fill="currentColor" />
        </span>
      )}
      <span className="chat-clip-info">
        <b>{clip.title}</b>
        <small>{here ? `${clip.seconds} s · ${Math.max(1, Math.round(clip.bytes / 1e6))} Mo` : `${message.authorName} est parti avec ce clip`}</small>
      </span>
      {share !== null && <i className="chat-clip-progress" style={{ width: `${Math.round(share * 100)}%` }} />}
    </button>
  );
}

function Message({ message, grouped, reply, canDelete }: { message: ChatMessage; grouped: boolean; reply: ChatMessage | undefined; canDelete: boolean }) {
  const name = useApp(s => s.settings!.profile.name);
  const isOwner = useApp(s => s.room!.ownerId === s.userId);
  const pinned = useApp(s => s.room!.pinned?.id === message.id);
  if (message.kind === "system") return <div className="chat-system">{message.text}</div>;
  const mentioned = message.authorId !== get().userId && mentionsName(message.text, name);
  return (
    <div className={`chat-message ${grouped ? "is-grouped" : ""} ${mentioned ? "is-mentioned" : ""}`}>
      {reply && (
        <div className="chat-reply">
          <CornerUpLeft size={12} />
          <b>{reply.authorName}</b>
          <span>{reply.text || "Image"}</span>
        </div>
      )}
      {!grouped && (
        <div className="chat-head">
          <b style={{ color: message.authorColor }}>{message.authorName}</b>
          <time>{clock(message.at)}</time>
        </div>
      )}
      {message.text && !message.clip && (
        <div className="chat-text">
          <MessageText text={message.text} />
        </div>
      )}
      {message.clip && <ClipCard message={message} />}
      {message.image ? (
        <button type="button" className="chat-image" aria-label="Agrandir l'image" onClick={() => set({ lightbox: message.image })}>
          <img src={message.image} alt="" />
        </button>
      ) : (
        !message.text && <div className="chat-expired">Image expirée</div>
      )}
      <Reactions message={message} />
      <div className="chat-actions">
        <Popover
          align="right"
          trigger={(open, toggle) => (
            <IconButton label="Réagir au message" active={open} onClick={toggle}>
              <SmilePlus size={14} />
            </IconButton>
          )}
        >
          {close => (
            <div className="reaction-grid">
              {QUICK_REACTIONS.map(e => (
                <button
                  key={e}
                  type="button"
                  onClick={() => {
                    core.reactChat(message.id, e);
                    close();
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </Popover>
        <IconButton label="Répondre" onClick={() => set({ replyTo: message })}>
          <Reply size={14} />
        </IconButton>
        {isOwner && (
          <IconButton label={pinned ? "Retirer l'épingle" : "Épingler"} onClick={() => core.pinChat(pinned ? null : message.id)}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </IconButton>
        )}
        {canDelete && (
          <IconButton label="Supprimer" onClick={() => core.deleteChat(message.id)}>
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function PinnedBar() {
  const pinned = useApp(s => s.room!.pinned);
  const isOwner = useApp(s => s.room!.ownerId === s.userId);
  if (!pinned) return null;
  return (
    <div className="chat-pinned">
      <Pin size={13} />
      <span>
        <b>{pinned.authorName}</b> <MessageText text={pinned.text || "Image"} />
      </span>
      {isOwner && (
        <IconButton label="Retirer l'épingle" onClick={() => core.pinChat(null)}>
          <X size={13} />
        </IconButton>
      )}
    </div>
  );
}

function TypingLine() {
  const names = useApp(s =>
    Object.keys(s.typing)
      .map(id => s.room?.members.find(m => m.id === id)?.name)
      .filter(Boolean)
      .join(", "),
  );
  return <div className="chat-typing">{names && `${names} écrit…`}</div>;
}

interface Suggestions {
  start: number;
  names: string[];
}

export function Chat() {
  const history = useApp(s => s.room!.history);
  const userId = useApp(s => s.userId);
  const ownerId = useApp(s => s.room!.ownerId);
  const replyTo = useApp(s => s.replyTo);
  const members = useApp(s => s.room!.members);
  const canShare = useApp(s => s.room!.settings.whoCanStream === "everyone" || s.room!.ownerId === s.userId);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [image, setImage] = useState<string | null>(null);
  const [picked, setPicked] = useState(0);
  const [dropping, setDropping] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);

  useLayoutEffect(() => {
    if (pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  const suggestions = useMemo<Suggestions | null>(() => {
    const before = text.slice(0, caret);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return null;
    const query = match[1]!.toLowerCase();
    const names = [...members.filter(m => m.id !== userId).map(m => m.name), "tous"].filter(n => n.toLowerCase().startsWith(query)).slice(0, 6);
    return names.length ? { start: before.length - query.length - 1, names } : null;
  }, [text, caret, members, userId]);

  const accept = (name: string) => {
    if (!suggestions) return;
    const next = `${text.slice(0, suggestions.start)}@${name} ${text.slice(caret)}`;
    const position = suggestions.start + name.length + 2;
    // Le curseur se replace tout de suite : une image plus tard, une frappe rapide atterrirait au mauvais endroit.
    flushSync(() => {
      setText(next);
      setCaret(position);
    });
    input.current?.focus();
    input.current?.setSelectionRange(position, position);
  };

  const attach = async (file: Blob | null | undefined) => {
    if (!file?.type.startsWith("image/")) return;
    const data = await compressImage(file).catch(() => null);
    if (data) setImage(data);
    else toast("Cette image est trop lourde.", "warning");
  };

  const send = () => {
    const value = text.trim();
    if (!value && !image) return;
    core.sendChat(value, image);
    setText("");
    setImage(null);
    pinned.current = true;
  };

  const hasMessages = history.some(m => m.kind === "user");

  return (
    <div
      className={`chat ${dropping ? "is-dropping" : ""}`}
      onDragOver={e => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => {
        e.preventDefault();
        setDropping(false);
        void attach(e.dataTransfer.files[0]);
      }}
    >
      <PinnedBar />
      <PollCard />
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
      <TypingLine />
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
      {image && (
        <div className="chat-attachment">
          <img src={image} alt="Image à envoyer" />
          <IconButton label="Retirer l'image" onClick={() => setImage(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      <div className="chat-compose">
        {suggestions && (
          <div className="chat-suggestions" role="listbox">
            {suggestions.names.map((name, i) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={i === picked % suggestions.names.length}
                className={i === picked % suggestions.names.length ? "is-on" : ""}
                onMouseDown={e => {
                  e.preventDefault();
                  accept(name);
                }}
              >
                @{name}
              </button>
            ))}
          </div>
        )}
        <div className="chat-input">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={e => {
              void attach(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Popover
            up
            trigger={(open, toggle) => (
              <IconButton label="Ajouter" active={open} onClick={toggle}>
                <Plus size={18} />
              </IconButton>
            )}
          >
            {close => (
              <div className="menu">
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close();
                    fileInput.current?.click();
                  }}
                >
                  <span>
                    <ImagePlus size={15} /> Envoyer une image
                  </span>
                  <small>Tu peux aussi la coller ou la glisser ici</small>
                </button>
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    close();
                    set({ dialog: "poll" });
                  }}
                >
                  <span>
                    <Vote size={15} /> Lancer un sondage
                  </span>
                </button>
                {canShare && (
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      close();
                      set({ dialog: "together" });
                    }}
                  >
                    <span>
                      <TvMinimalPlay size={15} /> Regarder une vidéo ensemble
                    </span>
                  </button>
                )}
              </div>
            )}
          </Popover>
          <textarea
            ref={input}
            rows={1}
            value={text}
            maxLength={LIMITS.chat}
            placeholder="Écris un message"
            aria-label="Message"
            onChange={e => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              setPicked(0);
              if (e.target.value) core.sendTyping();
            }}
            onSelect={e => setCaret(e.currentTarget.selectionStart)}
            onPaste={e => {
              const file = [...e.clipboardData.files].find(f => f.type.startsWith("image/"));
              if (!file) return;
              e.preventDefault();
              void attach(file);
            }}
            onKeyDown={e => {
              if (suggestions) {
                const count = suggestions.names.length;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  return setPicked(p => (p + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
                }
                if (e.key === "Tab" || e.key === "Enter") {
                  e.preventDefault();
                  return accept(suggestions.names[picked % count]!);
                }
              }
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
          <IconButton label="Envoyer" disabled={!text.trim() && !image} onClick={send}>
            <SendHorizontal size={18} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
