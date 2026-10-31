import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { SpokaApi } from "../shared/ipc.ts";

function subscribe<A extends unknown[]>(channel: string, cb: (...args: A) => void) {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
}

const info = ipcRenderer.sendSync("sync:info") as Pick<SpokaApi, "version" | "isPackaged" | "selfPid" | "testMode" | "forceRelay">;

// Un MessagePort ne passe pas par contextBridge : il rejoint la page par postMessage, seule voie prévue par Electron.
ipcRenderer.on("audio:port", (event, message: { captureId: number }) => {
  window.postMessage({ type: "spoka-audio-port", captureId: message.captureId }, "*", event.ports);
});

const api: SpokaApi = {
  ...info,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: patch => ipcRenderer.invoke("settings:set", patch),
  onSettings: cb => subscribe("settings:changed", cb),

  listSources: () => ipcRenderer.invoke("sources:list"),
  audioStatus: () => ipcRenderer.invoke("audio:status"),
  onAudioStatus: cb => subscribe("audio:status", cb),
  audioApps: () => ipcRenderer.invoke("audio:apps"),
  startCapture: (mode, pid) => ipcRenderer.invoke("audio:capture-start", mode, pid),
  stopCapture: captureId => ipcRenderer.invoke("audio:capture-stop", captureId),
  watchKeys: keys => ipcRenderer.invoke("audio:watch-keys", keys),
  onKey: cb => subscribe("audio:key", cb),
  startNativeVideo: request => ipcRenderer.invoke("video:start", request),
  configureNativeVideo: (fps, maxHeight) => ipcRenderer.invoke("video:configure", fps, maxHeight),
  stopNativeVideo: url => ipcRenderer.invoke("video:stop", url),
  onNativeVideoEnded: cb => subscribe("video:ended", cb),
  controlArm: target => ipcRenderer.invoke("control:arm", target),
  controlInput: events => ipcRenderer.send("control:input", events),
  controlDisarm: () => ipcRenderer.send("control:disarm"),
  onControlBlocked: cb => subscribe("control:blocked", cb),
  regieOnTop: onTop => ipcRenderer.send("regie:on-top", onTop),
  obsInfo: () => ipcRenderer.invoke("obs:info"),
  obsAnswer: (id, sdp) => ipcRenderer.send("obs:answer", id, sdp),
  onObsOffer: cb => subscribe("obs:offer", cb),
  onObsEnd: cb => subscribe("obs:end", cb),

  setTray: state => ipcRenderer.send("tray:set", state),
  showWindow: () => ipcRenderer.send("window:show"),
  onHotkey: cb => subscribe("hotkey", cb),
  onTrayAction: cb => subscribe("tray-action", cb),
  onDeepLink: cb => subscribe("deep-link", cb),
  onNotificationClick: cb => subscribe("notification-click", cb),
  notify: request => ipcRenderer.send("notify", request),

  overlayOpen: target => ipcRenderer.invoke("overlay:open", target),
  overlayClose: () => ipcRenderer.send("overlay:close"),
  overlaySend: event => ipcRenderer.send("overlay:send", event),
  onOverlayEvent: cb => subscribe("overlay:event", cb),

  youtubeInfo: videoId => ipcRenderer.invoke("youtube:info", videoId),
  recordStart: fileName => ipcRenderer.invoke("record:start", fileName),
  recordWrite: (id, chunk) => ipcRenderer.invoke("record:write", id, chunk),
  recordStop: id => ipcRenderer.invoke("record:stop", id),
  saveScreenshot: (fileName, png) => ipcRenderer.invoke("screenshot:save", fileName, png),
  reveal: file => ipcRenderer.send("reveal", file),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),

  updateCheck: () => ipcRenderer.send("update:check"),
  updateInstall: () => ipcRenderer.send("update:install"),
  updateStatus: () => ipcRenderer.invoke("update:status"),
  onUpdateStatus: cb => subscribe("update:status", cb),

  hostStatus: () => ipcRenderer.invoke("host:status"),
  hostStart: port => ipcRenderer.invoke("host:start", port),
  hostStop: () => ipcRenderer.invoke("host:stop"),

  openExternal: url => ipcRenderer.send("open-external", url),
  copyText: text => ipcRenderer.send("copy-text", text),
  logLine: line => ipcRenderer.send("log", line),
  diagnostics: () => ipcRenderer.invoke("diagnostics"),
};

contextBridge.exposeInMainWorld("spoka", api);
