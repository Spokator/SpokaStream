/** Identifiant Chromium d'une fenêtre : la capture native n'en lit que le numéro. */
export const windowSourceId = (hwnd: number) => `window:${hwnd}:0`;

const hwndOf = (id: string) => id.split(":")[1];

/**
 * Les fenêtres à ajouter à la liste : Chromium rend souvent une miniature vide, et un jeu en plein écran exclusif n'en a jamais,
 * alors que c'est la première chose qu'on vient chercher ici. Le suffixe de ses identifiants change : seul le numéro compte.
 */
export function missingWindows(listed: string[], own: string[], windows: { hwnd: number; title: string }[]) {
  const known = new Set([...listed, ...own].map(hwndOf));
  return windows.filter(window => !known.has(String(window.hwnd)));
}
