import { useEffect, useState } from "react";
import { core } from "./engine/core.ts";
import { get, set, useApp } from "./state/store.ts";
import { isTyping } from "./ui/kit.tsx";
import { ClipPlayer } from "./views/ClipPlayer.tsx";
import { GoLiveModal } from "./views/GoLive.tsx";
import { ControlRequest } from "./views/Hand.tsx";
import { RegieWindow } from "./views/Regie.tsx";
import { Home } from "./views/Home.tsx";
import { Onboarding } from "./views/Onboarding.tsx";
import { OverlayView } from "./views/Overlay.tsx";
import { Palette, ShortcutsModal } from "./views/Palette.tsx";
import { PollModal } from "./views/Poll.tsx";
import { Room } from "./views/Room.tsx";
import { SettingsView } from "./views/Settings.tsx";
import { Lightbox, Rail, TitleBar, Toasts } from "./views/Shell.tsx";
import { TogetherModal } from "./views/Together.tsx";

export function App() {
  return location.hash === "#overlay" ? <OverlayView /> : <MainApp />;
}

function MainApp() {
  const [booted, setBooted] = useState(false);
  const settings = useApp(s => s.settings);
  const view = useApp(s => s.view);
  const room = useApp(s => s.room);
  const goLiveOpen = useApp(s => s.goLiveOpen);
  const dialog = useApp(s => s.dialog);
  const cinema = useApp(s => s.cinema && s.view === "room");
  const regieWindow = useApp(s => s.regieWindow && !!s.publish);
  const accent = settings?.accent;

  useEffect(() => {
    void core.boot().then(() => setBooted(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set({ dialog: get().dialog === "palette" ? null : "palette" });
      } else if (e.key === "?" && !isTyping(e)) {
        set({ dialog: "shortcuts" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (accent) document.documentElement.style.setProperty("--accent", accent);
  }, [accent]);

  const theme = settings?.theme;
  const reduceMotion = settings?.reduceMotion;
  const chatSize = settings?.chatSize;
  const chatCompact = settings?.chatCompact;
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme ?? "dark";
    root.dataset.motion = reduceMotion ? "off" : "on";
    root.dataset.chat = chatCompact ? "compact" : "normal";
    if (chatSize) root.style.setProperty("--chat-size", `${chatSize}px`);
  }, [theme, reduceMotion, chatSize, chatCompact]);

  if (!booted || !settings) return <div className="splash" />;
  if (!settings.onboarded) return <Onboarding />;

  return (
    <div className={`app ${cinema ? "is-cinema" : ""}`}>
      <TitleBar />
      <Rail />
      <main className="content">
        {room && (
          <div className="content-layer" hidden={view !== "room"}>
            <Room />
          </div>
        )}
        {view === "home" && <Home />}
        {view === "settings" && <SettingsView />}
      </main>
      {goLiveOpen && <GoLiveModal />}
      {dialog === "poll" && <PollModal />}
      {dialog === "together" && <TogetherModal />}
      {dialog === "shortcuts" && <ShortcutsModal />}
      {dialog === "palette" && <Palette />}
      <ClipPlayer />
      <ControlRequest />
      {regieWindow && <RegieWindow />}
      <Lightbox />
      <Toasts />
    </div>
  );
}
