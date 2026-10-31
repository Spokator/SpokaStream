import "@fontsource-variable/inter";
import { createRoot } from "react-dom/client";
import type { SpokaApi } from "@shared/ipc.ts";
import { App } from "./App.tsx";
import "./styles.css";

declare global {
  interface Window {
    spoka: SpokaApi;
  }
}

createRoot(document.getElementById("root")!).render(<App />);
