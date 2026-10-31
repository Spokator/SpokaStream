import type { IceServer } from "@shared/protocol.ts";

/** forceRelay n'existe qu'en test : il oblige la vidéo à passer par le relais, donc par internet, même entre deux instances locales. */
export const rtcConfig = (iceServers: IceServer[]): RTCConfiguration => ({
  iceServers,
  bundlePolicy: "max-bundle",
  iceTransportPolicy: window.spoka.forceRelay ? "relay" : "all",
});
