/**
 * Chromium masque ses adresses derrière des noms en .local, qu'OBS ne sait pas résoudre, et l'offre d'OBS n'en donne
 * aucune : sans ça, personne ne trouve personne. Cette réponse ne quitte pas le PC, on peut y mettre les vraies adresses.
 */
export function revealCandidates(sdp: string, addresses: string[]) {
  return sdp.replace(/^(a=candidate:\S+ \d+ \S+ \d+ )\S+\.local( .*)$/gm, (_line, before: string, after: string) => addresses.map(address => `${before}${address}${after}`).join("\r\n"));
}
