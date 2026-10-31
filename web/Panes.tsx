/** @jsxImportSource preact */
import { Bell, BellOff, ChevronDown, Crown, Globe, Headphones, HeadphoneOff, ImagePlus, LogOut, Mic, MicOff, PhoneCall, PhoneOff, PictureInPicture2, Pin, Plus, Radio, SendHorizontal, Share2, Smile, TvMinimalPlay, UserRound, Vote, X } from "lucide-preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { LIMITS } from "@shared/protocol.ts";
import type { ChatMessage, Member, StreamInfo } from "@shared/protocol.ts";
import { compressImage } from "../src/renderer/src/ui/image.ts";
import { canShare, choose, closeMini, fetchClip, joinVoice, leaveRoom, leaveVoice, nameOf, openMini, pollVote, react, REACTIONS, reactChat, sendChat, sendTyping, setTalking, toggleDeafen, toggleMic, togglePush } from "./client.ts";
import { get, set, TOGETHER, useApp } from "./store.ts";
import type { Tab } from "./store.ts";

const clock = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function Avatar({ name, color, src, size = 34, ring }: { name: string; color: string; src?: string | null; size?: number; ring?: boolean }) {
  return (
    <span class={`avatar ${ring ? "is-speaking" : ""}`} style={{ width: `${size}px`, height: `${size}px`, background: color, fontSize: `${size * 0.4}px` }}>
      {src ? <img src={src} alt="" /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function RichText({ text }: { text: string }) {
  const members = useApp(s => s.room?.members);
  const mention = useMemo(() => new RegExp(`(@(?:${[...(members ?? []).map(m => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "tous"].join("|")}))`, "gi"), [members]);
  return (
    <>
      {text.split(/(https?:\/\/[^\s<]+)/g).map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part.split(mention).map((piece, j) =>
            j % 2 ? (
              <span key={`${i}-${j}`} class="mention">
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

function ClipCard({ message }: { message: ChatMessage }) {
  const clip = message.clip!;
  const [label, setLabel] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const here = useApp(s => s.room?.members.some(m => m.id === message.authorId && m.online) ?? false);
  const open = async () => {
    setLabel("Réception… 0 %");
    try {
      const bytes = await fetchClip(message, share => setLabel(`Réception… ${Math.round(share * 100)} %`));
      setUrl(URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" })));
      setLabel(null);
    } catch (e) {
      setLabel((e as Error).message);
    }
  };
  return (
    <>
      <button type="button" class="clip" disabled={!here || !!label?.startsWith("Réception")} onClick={e => (e.stopPropagation(), void open())}>
        {clip.thumb && <img src={clip.thumb} alt="" />}
        <span>{label ?? (here ? `▶ ${clip.title} · ${clip.seconds} s · ${Math.max(1, Math.round(clip.bytes / 1e6))} Mo` : `${message.authorName} est parti avec ce clip`)}</span>
      </button>
      {url && (
        <div class="clip-view" role="dialog" aria-label={`Clip ${clip.title}`} onClick={e => e.stopPropagation()}>
          <video id="clip-video" src={url} controls autoPlay playsInline />
          <p>
            <a href={url} download={`${clip.title.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "clip"}.mp4`}>
              Enregistrer
            </a>
            <button type="button" onClick={() => (URL.revokeObjectURL(url), setUrl(null))}>
              Fermer
            </button>
          </p>
        </div>
      )}
    </>
  );
}

function Message({ message, grouped, reply }: { message: ChatMessage; grouped: boolean; reply?: ChatMessage }) {
  const userId = useApp(s => s.userId);
  const name = useApp(s => s.name);
  if (message.kind === "system") return <div class="system">{message.text}</div>;
  const mentioned = message.authorId !== userId && new RegExp(`@(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|tous)\\b`, "i").test(message.text);
  return (
    <div class={`message ${grouped ? "is-grouped" : ""} ${mentioned ? "is-mentioned" : ""}`} data-message={message.id} onClick={e => !(e.target as HTMLElement).closest("a, button, video") && set({ sheet: { message } })}>
      {reply && (
        <div class="reply-quote">
          <b>{reply.authorName}</b> {reply.text || "Image"}
        </div>
      )}
      {!grouped && (
        <div class="message-head">
          <b style={{ color: message.authorColor }}>{message.authorName}</b>
          <time>{clock(message.at)}</time>
        </div>
      )}
      {message.clip ? <ClipCard message={message} /> : message.text && <div class="text"><RichText text={message.text} /></div>}
      {message.image && <img class="picture" src={message.image} alt="" onClick={e => (e.stopPropagation(), window.open(message.image!, "_blank"))} />}
      {message.reactions && Object.keys(message.reactions).length > 0 && (
        <div class="message-reactions">
          {Object.entries(message.reactions).map(([emoji, voters]) => (
            <button key={emoji} type="button" class={voters.includes(userId) ? "is-mine" : ""} onClick={e => (e.stopPropagation(), reactChat(message.id, emoji))}>
              {emoji} {voters.length}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PollCard() {
  const poll = useApp(s => s.room?.poll ?? null);
  const userId = useApp(s => s.userId);
  if (!poll) return null;
  const total = poll.options.reduce((n, o) => n + o.voters.length, 0);
  return (
    <div class="poll">
      <b>{poll.question}</b>
      {poll.options.map((option, index) => {
        const share = total ? Math.round((option.voters.length / total) * 100) : 0;
        return (
          <button key={option.text} type="button" class={option.voters.includes(userId) ? "is-on" : ""} disabled={poll.closed} style={{ "--share": `${share}%` }} onClick={() => pollVote(poll.id, index)}>
            <span>{option.text}</span>
            <em>{share} %</em>
          </button>
        );
      })}
    </div>
  );
}

export function Chat() {
  const history = useApp(s => s.room?.history ?? []);
  const members = useApp(s => s.room?.members ?? []);
  const pinned = useApp(s => s.room?.pinned ?? null);
  const replyTo = useApp(s => s.replyTo);
  const draftImage = useApp(s => s.draftImage);
  const shown = useApp(s => s.shown);
  const userId = useApp(s => s.userId);
  const typing = useApp(s => s.typing);
  const [text, setText] = useState("");
  const [tray, setTray] = useState(false);
  const [menu, setMenu] = useState(false);
  const [away, setAway] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    if (following.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  const query = text.match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  const suggestions = query === undefined ? [] : [...members.filter(m => m.id !== userId).map(m => m.name), "tous"].filter(n => n.toLowerCase().startsWith(query.toLowerCase())).slice(0, 5);

  const send = (e?: Event) => {
    e?.preventDefault();
    sendChat(text);
    setText("");
    setTray(false);
    following.current = true;
  };

  const attach = async (picked: File | undefined) => {
    if (!picked?.type.startsWith("image/")) return;
    const data = await compressImage(picked).catch(() => null);
    if (data) set({ draftImage: data });
  };

  const writers = Object.keys(typing).map(nameOf).join(", ");

  return (
    <div class="chat">
      {pinned && (
        <div class="pinned">
          <Pin size={13} />
          <span>
            <b>{pinned.authorName}</b> {pinned.text}
          </span>
        </div>
      )}
      <PollCard />
      <div
        class="chat-list"
        ref={list}
        onScroll={e => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          setAway(!following.current);
        }}
      >
        {history.map((m, i) => {
          const previous = history[i - 1];
          const grouped = !!previous && previous.kind === "user" && m.kind === "user" && previous.authorId === m.authorId && m.at - previous.at < 180_000 && !m.replyTo;
          return <Message key={m.id} message={m} grouped={grouped} reply={m.replyTo ? history.find(h => h.id === m.replyTo) : undefined} />;
        })}
      </div>
      {away && (
        <button
          type="button"
          class="jump"
          onClick={() => {
            following.current = true;
            setAway(false);
            if (list.current) list.current.scrollTop = list.current.scrollHeight;
          }}
        >
          <ChevronDown size={15} /> Revenir aux derniers messages
        </button>
      )}
      <div class="typing">{writers && `${writers} écrit…`}</div>
      {tray && (
        <div class="emoji-tray">
          {REACTIONS.map(emoji => (
            <button key={emoji} type="button" aria-label={`Réagir ${emoji}`} disabled={!shown} onClick={() => react(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
      {replyTo && (
        <div class="draft">
          <span>
            Réponse à <b>{replyTo.authorName}</b>
          </span>
          <button type="button" aria-label="Annuler la réponse" onClick={() => set({ replyTo: null })}>
            <X size={15} />
          </button>
        </div>
      )}
      {draftImage && (
        <div class="draft">
          <img src={draftImage} alt="Image à envoyer" />
          <button type="button" aria-label="Retirer l'image" onClick={() => set({ draftImage: null })}>
            <X size={15} />
          </button>
        </div>
      )}
      {suggestions.length > 0 && (
        <div class="mentions">
          {suggestions.map(name => (
            <button
              key={name}
              type="button"
              onClick={() => {
                setText(text.replace(/@[^\s@]*$/, `@${name} `));
                input.current?.focus();
              }}
            >
              @{name}
            </button>
          ))}
        </div>
      )}
      {menu && (
        <div class="composer-menu">
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              file.current?.click();
            }}
          >
            <ImagePlus size={17} /> Envoyer une image
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              set({ sheet: "poll" });
            }}
          >
            <Vote size={17} /> Lancer un sondage
          </button>
          {canShare() && (
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                set({ sheet: "together" });
              }}
            >
              <TvMinimalPlay size={17} /> Lancer une Watch Party
            </button>
          )}
        </div>
      )}
      <form class="composer" onSubmit={send}>
        <input ref={file} type="file" accept="image/*" hidden onChange={e => (void attach(e.currentTarget.files?.[0]), (e.currentTarget.value = ""))} />
        <button type="button" class="round" aria-label="Ajouter" aria-expanded={menu} onClick={() => setMenu(on => !on)}>
          <Plus size={20} />
        </button>
        <input
          ref={input}
          value={text}
          maxLength={LIMITS.chat}
          autoComplete="off"
          enterKeyHint="send"
          placeholder="Écris un message"
          aria-label="Message"
          onInput={e => {
            setText(e.currentTarget.value);
            if (e.currentTarget.value) sendTyping();
          }}
        />
        <button type="button" class={`round ${tray ? "is-on" : ""}`} aria-label="Réactions" aria-expanded={tray} onClick={() => setTray(on => !on)}>
          <Smile size={20} />
        </button>
        <button type="submit" class="round is-send" aria-label="Envoyer" disabled={!text.trim() && !draftImage}>
          <SendHorizontal size={19} />
        </button>
      </form>
    </div>
  );
}

function StreamRow({ stream, active }: { stream: StreamInfo; active: boolean }) {
  const mini = useApp(s => s.mini === stream.id);
  const shown = useApp(s => !!s.shown);
  return (
    <div class="stream-row">
      <button type="button" class={`stream ${active ? "is-on" : ""}`} data-stream={stream.id} onClick={() => choose(stream.id)}>
        {stream.thumb ? <img src={stream.thumb} alt="" /> : <span class="thumb-empty" />}
        <span>
          <b>{nameOf(stream.ownerId)}</b>
          <small>{stream.title || stream.sourceName}</small>
          <small>
            {stream.viewers.length} spectateur{stream.viewers.length > 1 ? "s" : ""}
            {stream.paused ? " · en pause" : ""}
          </small>
        </span>
      </button>
      {shown && !active && (
        <button type="button" class={`round ${mini ? "is-on" : ""}`} aria-label={mini ? "Fermer la mini-vue" : `Garder ${nameOf(stream.ownerId)} en petit par-dessus`} aria-pressed={mini} onClick={() => (mini ? closeMini() : void openMini(stream.id))}>
          <PictureInPicture2 size={18} />
        </button>
      )}
    </div>
  );
}

function Live() {
  const streams = useApp(s => s.room?.streams ?? []);
  const together = useApp(s => s.room?.together ?? null);
  const shown = useApp(s => s.shown);
  const userId = useApp(s => s.userId);
  const others = streams.filter(s => s.ownerId !== userId);
  return (
    <div class="pane-scroll">
      {others.length === 0 && !together && <p class="empty">Personne ne diffuse. Dès qu'un ami lance un stream, il apparaît ici.</p>}
      {others.map(stream => (
        <StreamRow key={stream.id} stream={stream} active={shown === stream.id} />
      ))}
      {together && (
        <button type="button" class={`stream ${shown === TOGETHER ? "is-on" : ""}`} onClick={() => choose(TOGETHER)}>
          {together.url ? <span class="thumb-empty" /> : <img src={`https://i.ytimg.com/vi/${together.videoId}/mqdefault.jpg`} alt="" />}
          <span>
            <b>Watch Party</b>
            <small>{together.title}</small>
            {together.queue.length > 0 && <small>{together.queue.length} à suivre</small>}
          </span>
        </button>
      )}
      {canShare() && (
        <button type="button" class="wide" onClick={() => set({ sheet: "together" })}>
          <TvMinimalPlay size={17} /> Lancer une Watch Party
        </button>
      )}
    </div>
  );
}

function MemberRow({ member }: { member: Member }) {
  const speaking = useApp(s => !!s.speaking[member.id]);
  const userId = useApp(s => s.userId);
  const ownerId = useApp(s => s.room?.ownerId);
  const live = useApp(s => s.room?.streams.some(x => x.ownerId === member.id) ?? false);
  const state = !member.online ? "Reconnexion…" : live ? "En direct" : member.voice ? (member.voice.muted ? "En vocal, micro coupé" : "En vocal") : member.web ? "Sur le web" : "Dans le salon";
  return (
    <div class={`member ${member.online ? "" : "is-offline"}`}>
      <Avatar name={member.name} color={member.color} src={member.avatar} ring={speaking} />
      <span class="member-text">
        <b>
          {member.name}
          {member.id === userId && <small> (toi)</small>}
          {member.id === ownerId && <Crown size={12} class="crown" aria-label="Propriétaire" />}
        </b>
        <small>{state}</small>
      </span>
      {live && <Radio size={15} class="is-live" aria-label="En direct" />}
      {member.web && <Globe size={15} aria-label="Dans un navigateur" />}
      {member.voice && (member.voice.muted ? <MicOff size={15} class="is-off" aria-label="Micro coupé" /> : <Mic size={15} aria-label="Micro actif" />)}
      {member.voice?.deafened && <HeadphoneOff size={15} class="is-off" aria-label="Sourdine" />}
    </div>
  );
}

function Salon() {
  const members = useApp(s => s.room?.members ?? []);
  const code = useApp(s => s.code);
  const dataMb = useApp(s => s.dataMb);
  const push = useApp(s => s.push);
  const sorted = [...members].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, "fr"));
  return (
    <div class="pane-scroll">
      <button type="button" class="invite" onClick={() => set({ sheet: "share" })}>
        <Share2 size={17} />
        <span>
          <b>Inviter des amis</b>
          <small>Code {code}</small>
        </span>
      </button>
      {sorted.map(m => (
        <MemberRow key={m.id} member={m} />
      ))}
      <div class="pane-actions">
        {push !== "unsupported" && (
          <button type="button" disabled={push === "blocked"} onClick={() => void togglePush()}>
            {push === "on" ? <BellOff size={16} /> : <Bell size={16} />}
            {push === "on" ? "Ne plus être prévenu" : push === "blocked" ? "Notifications refusées dans les réglages du téléphone" : "Me prévenir quand un ami passe en direct"}
          </button>
        )}
        <button type="button" onClick={() => set({ sheet: "profile" })}>
          <UserRound size={16} /> Mon profil et mes réglages
        </button>
        <button type="button" onClick={() => leaveRoom()}>
          <LogOut size={16} /> Quitter le salon
        </button>
      </div>
      <p class="empty">{dataMb >= 1 ? `${Math.round(dataMb)} Mo reçus depuis ton arrivée.` : ""}</p>
    </div>
  );
}

export function VoiceBar() {
  const on = useApp(s => s.voiceOn);
  const micOn = useApp(s => s.micOn);
  const deafened = useApp(s => s.deafened);
  const pushToTalk = useApp(s => s.pushToTalk);
  const talking = useApp(s => s.talking);
  const speaking = useApp(s => s.speaking);
  if (!on) return null;
  const names = Object.keys(speaking).map(id => (id === get().userId ? "Toi" : nameOf(id)));
  return (
    <div class="voice-bar" role="region" aria-label="Vocal">
      <span class="voice-now">{names.length ? `${names.join(", ")} parle${names.length > 1 ? "nt" : ""}` : "En vocal"}</span>
      {pushToTalk ? (
        <button type="button" class={`talk ${talking ? "is-on" : ""}`} onPointerDown={() => setTalking(true)} onPointerUp={() => setTalking(false)} onPointerCancel={() => setTalking(false)} onContextMenu={e => e.preventDefault()}>
          {talking ? "Je parle…" : "Maintenir pour parler"}
        </button>
      ) : (
        <button type="button" class={`round ${micOn ? "" : "is-off"}`} aria-label={micOn ? "Couper mon micro" : "Réactiver mon micro"} onClick={toggleMic}>
          {micOn ? <Mic size={18} /> : <MicOff size={18} />}
        </button>
      )}
      <button type="button" class={`round ${deafened ? "is-off" : ""}`} aria-label={deafened ? "Réactiver le son du vocal" : "Couper le son du vocal"} onClick={toggleDeafen}>
        {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
      </button>
      <button type="button" class="round is-leave" aria-label="Quitter le vocal" onClick={leaveVoice}>
        <PhoneOff size={18} />
      </button>
    </div>
  );
}

export function VoiceButton() {
  const on = useApp(s => s.voiceOn);
  if (on) return null;
  return (
    <button type="button" class="head-action" aria-label="Rejoindre le vocal" onClick={() => void joinVoice()}>
      <PhoneCall size={16} /> <span>Vocal</span>
    </button>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "live", label: "En direct" },
  { id: "room", label: "Salon" },
];

export function Panes() {
  const tab = useApp(s => s.tab);
  const remote = useApp(s => !!s.remote);
  const unread = useApp(s => s.unread);
  const liveCount = useApp(s => (s.room?.streams.filter(x => x.ownerId !== s.userId).length ?? 0) + (s.room?.together ? 1 : 0));
  const memberCount = useApp(s => s.room?.members.filter(m => m.online).length ?? 0);
  const badge = (id: Tab) => (id === "chat" ? unread : id === "live" ? liveCount : id === "room" ? memberCount : 0);
  return (
    <section class="panes" aria-label="Salon">
      <div class="tabs" role="tablist">
        {remote && (
          <button type="button" class="tab-regie" onClick={() => set({ deckOpen: true })}>
            Régie
          </button>
        )}
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} class={tab === t.id ? "is-on" : ""} onClick={() => set({ tab: t.id, ...(t.id === "chat" ? { unread: 0 } : {}) })}>
            {t.label}
            {badge(t.id) > 0 && <em class={t.id === "chat" ? "is-alert" : ""}>{badge(t.id)}</em>}
          </button>
        ))}
        <button type="button" class="close-drawer" aria-label="Fermer le panneau" onClick={() => set({ chatOpen: false })}>
          <X size={17} />
        </button>
      </div>
      <div class="pane">
        {tab === "chat" && <Chat />}
        {tab === "live" && <Live />}
        {tab === "room" && <Salon />}
      </div>
    </section>
  );
}
