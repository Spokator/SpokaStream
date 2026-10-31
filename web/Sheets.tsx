/** @jsxImportSource preact */
import { Copy, Reply, Share2, Trash2, X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { LIMITS } from "@shared/protocol.ts";
import type { ChatMessage } from "@shared/protocol.ts";
import { deleteChat, inviteLink, pollClose, pollCreate, pollDismiss, QUALITIES, reactChat, saveProfile, setLatency, setPushToTalk, setQuality, shareInvite, togetherAdd } from "./client.ts";
import { set, useApp } from "./store.ts";

const QUICK = ["👍", "❤️", "😂", "🔥", "😮", "😭", "🎉", "💀"];
const COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#f59e0b", "#f472b6", "#fb7185", "#a78bfa", "#60a5fa"];

const close = () => set({ sheet: null });

function Sheet({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="sheet-backdrop" onClick={e => e.target === e.currentTarget && close()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button type="button" class="round" aria-label="Fermer le panneau" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <div class="sheet-body">{children}</div>
      </div>
    </div>
  );
}

function QualitySheet() {
  const quality = useApp(s => s.quality);
  const latency = useApp(s => s.latency);
  const stats = useApp(s => s.stats);
  const dataMb = useApp(s => s.dataMb);
  return (
    <Sheet title="Qualité">
      {QUALITIES.map((q, index) => (
        <button key={q.label} type="button" class={`choice ${quality === index ? "is-on" : ""}`} onClick={() => (setQuality(index), close())}>
          <b>{q.label}</b>
          <small>{q.hint}</small>
        </button>
      ))}
      <h3>Délai</h3>
      <div class="segment">
        <button type="button" class={latency === "balanced" ? "is-on" : ""} onClick={() => setLatency("balanced")}>
          Au plus près du direct
        </button>
        <button type="button" class={latency === "stable" ? "is-on" : ""} onClick={() => setLatency("stable")}>
          Connexion instable
        </button>
      </div>
      {stats && (
        <p class="sheet-note">
          {stats.height}p · {stats.fps} i/s · {(stats.kbps / 1000).toFixed(1)} Mb/s · {stats.lostPct} % de pertes
          {stats.relay ? " · par le relais" : " · en direct du PC"}
          <br />
          {Math.round(dataMb)} Mo reçus depuis ton arrivée
        </p>
      )}
    </Sheet>
  );
}

async function pictureToAvatar(file: File) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 160;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 160, 160);
  bitmap.close();
  const data = canvas.toDataURL("image/jpeg", 0.8);
  return data.length <= LIMITS.avatarBytes ? data : null;
}

function ProfileSheet() {
  const name = useApp(s => s.name);
  const color = useApp(s => s.color);
  const avatar = useApp(s => s.avatar);
  const pushToTalk = useApp(s => s.pushToTalk);
  const [draft, setDraft] = useState(name);
  return (
    <Sheet title="Mon profil">
      <label class="field">
        <span>Nom affiché</span>
        <input value={draft} maxLength={LIMITS.name} aria-label="Nom affiché" onInput={e => setDraft(e.currentTarget.value)} onBlur={() => draft.trim() && draft !== name && saveProfile({ name: draft.trim() })} />
      </label>
      <div class="field">
        <span>Couleur</span>
        <div class="colors">
          {COLORS.map(c => (
            <button key={c} type="button" aria-label={`Couleur ${c}`} aria-pressed={c === color} class={c === color ? "is-on" : ""} style={{ background: c }} onClick={() => saveProfile({ color: c })} />
          ))}
        </div>
      </div>
      <label class="field">
        <span>Photo</span>
        <input
          type="file"
          accept="image/*"
          aria-label="Choisir une photo"
          onChange={e => {
            const file = e.currentTarget.files?.[0];
            if (file) void pictureToAvatar(file).then(data => data && saveProfile({ avatar: data }));
          }}
        />
      </label>
      {avatar && (
        <button type="button" class="wide" onClick={() => saveProfile({ avatar: null })}>
          Retirer ma photo
        </button>
      )}
      <label class="switch">
        <input type="checkbox" checked={pushToTalk} onChange={e => setPushToTalk(e.currentTarget.checked)} />
        <span>
          <b>Mode talkie</b>
          <small>Le micro ne s'ouvre que pendant que tu appuies</small>
        </span>
      </label>
    </Sheet>
  );
}

function PollSheet() {
  const poll = useApp(s => s.room?.poll ?? null);
  const userId = useApp(s => s.userId);
  const owner = useApp(s => s.room?.ownerId === s.userId);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const filled = options.filter(o => o.trim());
  return (
    <Sheet title="Sondage">
      {poll && (poll.authorId === userId || owner) && (
        <div class="pane-actions">
          {!poll.closed && (
            <button type="button" onClick={() => pollClose(poll.id)}>
              Terminer le sondage en cours
            </button>
          )}
          <button type="button" onClick={() => pollDismiss(poll.id)}>
            Retirer le sondage
          </button>
        </div>
      )}
      <label class="field">
        <span>Question</span>
        <input value={question} maxLength={LIMITS.pollQuestion} placeholder="On regarde quoi ce soir ?" aria-label="Question du sondage" onInput={e => setQuestion(e.currentTarget.value)} />
      </label>
      {options.map((option, index) => (
        <label key={index} class="field">
          <span>Choix {index + 1}</span>
          <input value={option} maxLength={LIMITS.pollOption} aria-label={`Choix ${index + 1}`} onInput={e => setOptions(options.map((o, i) => (i === index ? e.currentTarget.value : o)))} />
        </label>
      ))}
      {options.length < LIMITS.pollOptions && (
        <button type="button" class="wide" onClick={() => setOptions([...options, ""])}>
          Ajouter un choix
        </button>
      )}
      <button
        type="button"
        class="primary"
        disabled={!question.trim() || filled.length < 2}
        onClick={() => {
          pollCreate(question.trim(), filled);
          close();
        }}
      >
        Lancer le sondage
      </button>
    </Sheet>
  );
}

function TogetherSheet() {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  return (
    <Sheet title="Regarder ensemble">
      <p class="sheet-note">Colle un lien YouTube : chacun lit la vidéo de son côté et tout le salon reste synchronisé.</p>
      <label class="field">
        <span>Lien de la vidéo</span>
        <input value={link} placeholder="https://www.youtube.com/watch?v=…" inputMode="url" aria-label="Lien YouTube" onInput={e => setLink(e.currentTarget.value)} />
      </label>
      {error && <p class="error">{error}</p>}
      <button
        type="button"
        class="primary"
        disabled={!link.trim()}
        onClick={() => {
          void togetherAdd(link).then(problem => {
            if (problem) setError(problem);
            else close();
          });
        }}
      >
        Lancer pour tout le salon
      </button>
    </Sheet>
  );
}

function ShareSheet() {
  const code = useApp(s => s.code);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet title="Inviter des amis">
      <p class="share-code">{code}</p>
      <p class="sheet-note">Pas besoin d'application : le lien s'ouvre dans le navigateur. Ou donne le code, à entrer sur {location.host}.</p>
      <button type="button" class="primary" onClick={() => void shareInvite()}>
        <Share2 size={17} /> Partager le lien
      </button>
      <button
        type="button"
        class="wide"
        onClick={() => {
          void navigator.clipboard?.writeText(inviteLink()).then(() => setCopied(true));
        }}
      >
        <Copy size={16} /> {copied ? "Lien copié" : "Copier le lien"}
      </button>
    </Sheet>
  );
}

function MessageSheet({ message }: { message: ChatMessage }) {
  const mine = useApp(s => message.authorId === s.userId || s.room?.ownerId === s.userId);
  return (
    <Sheet title={`Message de ${message.authorName}`}>
      <div class="emoji-tray">
        {QUICK.map(emoji => (
          <button key={emoji} type="button" aria-label={`Réagir au message ${emoji}`} onClick={() => (reactChat(message.id, emoji), close())}>
            {emoji}
          </button>
        ))}
      </div>
      <button type="button" class="wide" onClick={() => set({ replyTo: message, sheet: null, tab: "chat" })}>
        <Reply size={16} /> Répondre
      </button>
      {message.text && !message.clip && (
        <button
          type="button"
          class="wide"
          onClick={() => {
            void navigator.clipboard?.writeText(message.text);
            close();
          }}
        >
          <Copy size={16} /> Copier le texte
        </button>
      )}
      {mine && (
        <button type="button" class="wide is-danger" onClick={() => (deleteChat(message.id), close())}>
          <Trash2 size={16} /> Supprimer
        </button>
      )}
    </Sheet>
  );
}

export function Sheets() {
  const sheet = useApp(s => s.sheet);
  if (!sheet) return null;
  if (typeof sheet === "object") return <MessageSheet message={sheet.message} />;
  if (sheet === "quality") return <QualitySheet />;
  if (sheet === "profile") return <ProfileSheet />;
  if (sheet === "poll") return <PollSheet />;
  if (sheet === "together") return <TogetherSheet />;
  return <ShareSheet />;
}
