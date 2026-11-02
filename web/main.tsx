/** @jsxImportSource preact */
import { ArrowLeft, Download, Radio, Share, Share2, Trash2, UserRound } from "lucide-preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { LIMITS, STORE_URL } from "@shared/protocol.ts";
import { boot, enter, enterCode, forgetRoom, install, leaveRoom, video } from "./client.ts";
import { Avatar, Panes, VoiceBar, VoiceButton } from "./Panes.tsx";
import { Player } from "./Player.tsx";
import { Deck } from "./Deck.tsx";
import { RemoteCard } from "./Regie.tsx";
import { Sheets } from "./Sheets.tsx";
import { get, set, useApp } from "./store.ts";

const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const installed = matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function InstallHint() {
  const canInstall = useApp(s => s.canInstall);
  if (installed) return null;
  if (canInstall) {
    return (
      <button type="button" class="install" onClick={() => void install()}>
        <Download size={17} />
        <span>
          <b>Ajouter à l'écran d'accueil</b>
          <small>SpokaStream s'ouvre alors comme une application</small>
        </span>
      </button>
    );
  }
  if (!isIos) return null;
  return (
    <p class="install">
      <Share size={17} />
      <span>
        <b>Sur iPhone</b>
        <small>Touche Partager, puis « Sur l'écran d'accueil » : tu auras le vrai plein écran.</small>
      </span>
    </p>
  );
}

function Recents() {
  const recents = useApp(s => s.recents);
  const statuses = useApp(s => s.statuses);
  if (!recents.length) return null;
  const sorted = [...recents].sort((a, b) => (statuses[b.id]?.live.length ?? 0) - (statuses[a.id]?.live.length ?? 0));
  return (
    <section class="recents" aria-label="Mes salons">
      <h2>Mes salons</h2>
      {sorted.map(room => {
        const status = statuses[room.id];
        const live = status?.live[0];
        return (
          <div key={room.id} class="recent">
            <button type="button" class="recent-open" onClick={() => void enter(room.code)}>
              {live?.thumb ? <img src={live.thumb} alt="" /> : <span class="thumb-empty" />}
              <span>
                <b>{status?.name || room.name}</b>
                {live ? (
                  <small class="is-live">
                    <Radio size={12} /> {live.ownerName} en direct
                  </small>
                ) : status?.party ? (
                  <small class="is-live">Watch Party : {status.party}</small>
                ) : (
                  <small>{status?.members ? `${status.members} en ligne` : "Personne pour l'instant"}</small>
                )}
              </span>
            </button>
            <button type="button" class="round" aria-label={`Oublier ${room.name}`} onClick={() => forgetRoom(room.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        );
      })}
    </section>
  );
}

/** Un téléphone lié n'a plus rien à se présenter : il sait qui il est, il montre ce qui compte. */
function AccountHead() {
  const name = useApp(s => s.name);
  const color = useApp(s => s.color);
  const avatar = useApp(s => s.avatar);
  const online = useApp(s => s.online);
  const pc = useApp(s => s.remote);
  return (
    <header class="account-head">
      <Avatar name={name} color={color} src={avatar} size={44} />
      <span>
        <b>{name}</b>
        <small>{!online ? "Reconnexion…" : pc ? (pc.idle ? "Ton PC est en ligne" : "Ton PC est en direct") : "Ton PC n'est pas connecté"}</small>
      </span>
    </header>
  );
}

function CodeForm({ wide }: { wide: boolean }) {
  const code = useApp(s => s.code);
  const name = useApp(s => s.name);
  const error = useApp(s => s.error);
  const [draftCode, setDraftCode] = useState(code);
  const [draftName, setDraftName] = useState(name);
  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        void enterCode(draftCode, wide ? draftName.trim() || "Invité" : name);
        setDraftCode("");
      }}
    >
      <label>
        <span>Code du salon, ou code de liaison de ton PC</span>
        <input class="code-input" value={draftCode} maxLength={16} required autoComplete="off" autoCapitalize="characters" spellcheck={false} placeholder="ABCD2345" onInput={e => setDraftCode(e.currentTarget.value)} />
      </label>
      {wide && (
        <label>
          <span>Ton nom</span>
          <input value={draftName} maxLength={LIMITS.name} autoComplete="nickname" placeholder="Comment tes amis te voient" required onInput={e => setDraftName(e.currentTarget.value)} />
        </label>
      )}
      <button type="submit" class="primary">
        Continuer
      </button>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Entry() {
  const notice = useApp(s => s.notice);
  const screen = useApp(s => s.screen);
  const code = useApp(s => s.code);
  const name = useApp(s => s.name);
  const error = useApp(s => s.error);
  const linked = useApp(s => !!s.accountId && s.accountId !== s.userId);
  const [draftName, setDraftName] = useState(name);
  const message = notice && (
    <p class="notice is-card" role="status">
      {notice}
    </p>
  );
  if (linked && screen === "home") {
    return (
      <main class="entry is-linked">
        <AccountHead />
        {message}
        <RemoteCard />
        <Recents />
        <details class="entry-more">
          <summary>Rejoindre avec un code</summary>
          <CodeForm wide={false} />
        </details>
        <InstallHint />
      </main>
    );
  }
  return (
    <main class="entry">
      <div class="entry-card">
        <img src="/icon-192.png" alt="" width={64} height={64} />
        <h1>{screen === "home" ? "Rejoindre un salon" : "Rejoins le salon"}</h1>
        <p>{screen === "home" ? "Entre le code d'un salon. Pour retrouver ton compte, entre le code affiché sur ton PC." : "Le stream démarre ici, sans rien installer."}</p>
        {screen === "home" ? (
          <CodeForm wide />
        ) : (
          <form
            onSubmit={e => {
              e.preventDefault();
              void enter(code, draftName.trim() || "Invité");
            }}
          >
            <p class="entry-code">
              Salon <code>{code}</code>
            </p>
            <label>
              <span>Ton nom</span>
              <input value={draftName} maxLength={LIMITS.name} autoComplete="nickname" placeholder="Comment tes amis te voient" required onInput={e => setDraftName(e.currentTarget.value)} />
            </label>
            <button type="submit" class="primary">
              Regarder
            </button>
            {error && (
              <p class="error" role="alert">
                {error}
              </p>
            )}
          </form>
        )}
      </div>
      <RemoteCard />
      {message}
      <Recents />
      <InstallHint />
      <a class="entry-link" href={STORE_URL} target="_blank" rel="noopener">
        Installer le logiciel pour diffuser
      </a>
    </main>
  );
}

function Room() {
  const name = useApp(s => s.room?.name ?? "Connexion…");
  const online = useApp(s => s.online);
  const avatar = useApp(s => s.avatar);
  const userName = useApp(s => s.name);
  const color = useApp(s => s.color);
  const immersive = useApp(s => s.immersive);
  const fullscreen = useApp(s => s.fullscreen);
  const chatOpen = useApp(s => s.chatOpen);
  const notice = useApp(s => s.notice);

  // Le clavier d'un téléphone réduit la zone visible sans toujours prévenir la page : la mise en page suit la vraie hauteur.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () => document.documentElement.style.setProperty("--view-height", `${viewport.height}px`);
    apply();
    viewport.addEventListener("resize", apply);
    return () => viewport.removeEventListener("resize", apply);
  }, []);

  return (
    <div class={`room ${immersive || fullscreen ? "is-full" : ""} ${chatOpen ? "chat-open" : ""}`}>
      <header class="top">
        <button type="button" class="round" aria-label="Revenir à mes salons" onClick={() => leaveRoom()}>
          <ArrowLeft size={19} />
        </button>
        <h1>{name}</h1>
        {!online && <span class="offline">Reconnexion…</span>}
        <span class="spacer" />
        <VoiceButton />
        <button type="button" class="round" aria-label="Inviter des amis" onClick={() => set({ sheet: "share" })}>
          <Share2 size={18} />
        </button>
        <button type="button" class="avatar-button" aria-label="Mon profil" onClick={() => set({ sheet: "profile" })}>
          {userName ? <Avatar name={userName} color={color} src={avatar} size={30} /> : <UserRound size={18} />}
        </button>
      </header>
      {notice && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
      <Player />
      <VoiceBar />
      <Panes />
    </div>
  );
}

function App() {
  const screen = useApp(s => s.screen);
  const deck = useApp(s => s.deckOpen);
  return (
    <>
      {screen === "room" ? <Room /> : <Entry />}
      <Sheets />
      {deck && <Deck />}
    </>
  );
}

boot();
render(<App />, document.getElementById("root")!);
Object.assign(window, { __web: { get, video } });
