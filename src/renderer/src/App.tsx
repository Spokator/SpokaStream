import { useEffect, useState } from "react";
import { core } from "./engine/core.ts";
import { useApp } from "./state/store.ts";
import { GoLiveModal } from "./views/GoLive.tsx";
import { Home } from "./views/Home.tsx";
import { Onboarding } from "./views/Onboarding.tsx";
import { OverlayView } from "./views/Overlay.tsx";
import { Room } from "./views/Room.tsx";
import { SettingsView } from "./views/Settings.tsx";
import { Rail, TitleBar, Toasts } from "./views/Shell.tsx";

export function App() {
  return location.hash === "#overlay" ? <OverlayView /> : <MainApp />;
}

function MainApp() {
  const [booted, setBooted] = useState(false);
  const settings = useApp(s => s.settings);
  const view = useApp(s => s.view);
  const room = useApp(s => s.room);
  const goLiveOpen = useApp(s => s.goLiveOpen);

  useEffect(() => {
    void core.boot().then(() => setBooted(true));
  }, []);

  if (!booted || !settings) return <div className="splash" />;
  if (!settings.onboarded) return <Onboarding />;

  return (
    <div className="app">
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
      <Toasts />
    </div>
  );
}
