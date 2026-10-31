import type { WallMode, WallRect } from "@shared/ipc.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GAP = 8;
const RATIO = 16 / 9;
const PIP_MARGIN = 12;
/** Au-dessus de la barre de commandes de l'image en grand. */
const PIP_BOTTOM = 72;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Le nombre de colonnes qui donne les plus grandes images, et la dernière rangée reste centrée. */
function gridRects(ids: string[], width: number, height: number) {
  const count = ids.length;
  let columns = 1;
  let best = 0;
  for (let c = 1; c <= count; c++) {
    const rows = Math.ceil(count / c);
    const cellW = (width - GAP * (c - 1)) / c;
    const cellH = (height - GAP * (rows - 1)) / rows;
    const size = Math.min(cellW, cellH * RATIO);
    if (size > best) {
      best = size;
      columns = c;
    }
  }
  const rows = Math.ceil(count / columns);
  const w = (width - GAP * (columns - 1)) / columns;
  const h = (height - GAP * (rows - 1)) / rows;
  const result: Record<string, Rect> = {};
  ids.forEach((id, index) => {
    const row = Math.floor(index / columns);
    const inRow = row === rows - 1 ? count - row * columns : columns;
    const shift = (width - inRow * w - (inRow - 1) * GAP) / 2;
    result[id] = { x: shift + (index % columns) * (w + GAP), y: row * (h + GAP), w, h };
  });
  return result;
}

function focusRects(main: string, rest: string[], width: number, height: number) {
  const n = rest.length;
  let h = clamp(height * 0.2, 96, 190);
  let w = h * RATIO;
  if (n * w + (n - 1) * GAP > width) {
    w = (width - (n - 1) * GAP) / n;
    h = w / RATIO;
  }
  const result: Record<string, Rect> = { [main]: { x: 0, y: 0, w: width, h: height - h - GAP } };
  const shift = (width - n * w - (n - 1) * GAP) / 2;
  rest.forEach((id, index) => (result[id] = { x: shift + index * (w + GAP), y: height - h, w, h }));
  return result;
}

function sideRects(main: string, rest: string[], width: number, height: number) {
  const n = rest.length;
  const w = clamp(width * 0.24, 180, 380);
  const h = Math.min(w / RATIO, (height - (n - 1) * GAP) / n);
  const result: Record<string, Rect> = { [main]: { x: 0, y: 0, w: width - w - GAP, h: height } };
  const shift = Math.max(0, (height - n * h - (n - 1) * GAP) / 2);
  rest.forEach((id, index) => (result[id] = { x: width - w, y: shift + index * (h + GAP), w, h }));
  return result;
}

function pipRects(main: string, rest: string[], width: number, height: number) {
  const w = clamp(width * 0.2, 160, 360);
  const h = w / RATIO;
  const perColumn = Math.max(1, Math.floor((height - PIP_BOTTOM - PIP_MARGIN + GAP) / (h + GAP)));
  const result: Record<string, Rect> = { [main]: { x: 0, y: 0, w: width, h: height } };
  rest.forEach((id, index) => {
    const column = Math.floor(index / perColumn);
    const row = index % perColumn;
    result[id] = { x: width - PIP_MARGIN - w - column * (w + GAP), y: height - PIP_BOTTOM - h - row * (h + GAP), w, h };
  });
  return result;
}

/** Où va chaque image, en pixels. Une seule fonction pour toutes les dispositions : passer de l'une à l'autre ne recrée aucun lecteur. */
export function layoutWall(mode: WallMode, ids: string[], main: string | null, width: number, height: number, free: (id: string) => WallRect | undefined): Record<string, Rect> {
  if (!ids.length || width <= 0 || height <= 0) return {};
  if (mode === "free") {
    const fallback = gridRects(ids, width, height);
    const result: Record<string, Rect> = {};
    for (const id of ids) {
      const saved = free(id);
      result[id] = saved ? { x: saved.x * width, y: saved.y * height, w: saved.w * width, h: saved.h * height } : fallback[id]!;
    }
    return result;
  }
  const lead = main && ids.includes(main) ? main : ids[0]!;
  const rest = ids.filter(id => id !== lead);
  if (mode === "grid" || !rest.length) return gridRects(ids, width, height);
  if (mode === "side") return sideRects(lead, rest, width, height);
  if (mode === "pip") return pipRects(lead, rest, width, height);
  return focusRects(lead, rest, width, height);
}

const SNAP = 10;

/** Déplacer ou agrandir aimante le bord de l'image à ceux de la scène et des autres images. */
export function snapRect(rect: Rect, others: Rect[], width: number, height: number, resizing: boolean): Rect {
  const xLines = [0, width, ...others.flatMap(o => [o.x, o.x + o.w])];
  const yLines = [0, height, ...others.flatMap(o => [o.y, o.y + o.h])];
  const nearest = (value: number, lines: number[]) => {
    const line = lines.reduce((best, candidate) => (Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best), Infinity);
    return Math.abs(line - value) <= SNAP ? line : null;
  };
  const next = { ...rect };
  if (resizing) {
    const right = nearest(rect.x + rect.w, xLines);
    const bottom = nearest(rect.y + rect.h, yLines);
    if (right !== null) next.w = right - rect.x;
    if (bottom !== null) next.h = bottom - rect.y;
  } else {
    const left = nearest(rect.x, xLines);
    const right = nearest(rect.x + rect.w, xLines);
    const top = nearest(rect.y, yLines);
    const bottom = nearest(rect.y + rect.h, yLines);
    if (left !== null) next.x = left;
    else if (right !== null) next.x = right - rect.w;
    if (top !== null) next.y = top;
    else if (bottom !== null) next.y = bottom - rect.h;
  }
  next.w = clamp(next.w, 200, width);
  next.h = clamp(next.h, 112, height);
  next.x = clamp(next.x, 0, width - next.w);
  next.y = clamp(next.y, 0, height - next.h);
  return next;
}
