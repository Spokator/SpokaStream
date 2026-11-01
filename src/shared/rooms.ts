const MAX_ROOMS = 30;

/** Ouvrir un salon le met à jour sans le déplacer : la liste doit rester à sa place sous la main. Un nouveau salon arrive à la fin. */
export function rememberRoom<T extends { id: string }>(rooms: T[], room: T, limit = MAX_ROOMS) {
  if (rooms.some(known => known.id === room.id)) return rooms.map(known => (known.id === room.id ? room : known));
  return [...rooms, room].slice(-limit);
}
