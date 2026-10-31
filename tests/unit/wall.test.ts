import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutWall, snapRect } from "../../src/renderer/src/ui/wall.ts";

const none = () => undefined;
const W = 1280;
const H = 720;

test("la grille garde tout dans la scène et ne superpose rien", () => {
  for (let n = 1; n <= 9; n++) {
    const ids = Array.from({ length: n }, (_, i) => `s${i}`);
    const rects = Object.values(layoutWall("grid", ids, null, W, H, none));
    assert.equal(rects.length, n);
    for (const a of rects) {
      assert.ok(a.x >= -0.01 && a.y >= -0.01 && a.x + a.w <= W + 0.01 && a.y + a.h <= H + 0.01, `${n} images : ${JSON.stringify(a)}`);
      for (const b of rects) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01;
        assert.ok(apart, `${n} images se chevauchent`);
      }
    }
  }
});

test("deux images passent côte à côte en grand écran, l'une sur l'autre en écran haut", () => {
  const wide = layoutWall("grid", ["a", "b"], null, W, H, none);
  assert.equal(wide.a!.y, wide.b!.y);
  const tall = layoutWall("grid", ["a", "b"], null, 500, 900, none);
  assert.equal(tall.a!.x, tall.b!.x);
});

test("l'image principale prend la place, les autres se rangent", () => {
  const focus = layoutWall("focus", ["a", "b", "c"], "b", W, H, none);
  assert.equal(focus.b!.w, W);
  assert.ok(focus.a!.y >= focus.b!.h);
  const side = layoutWall("side", ["a", "b", "c"], "b", W, H, none);
  assert.equal(side.b!.h, H);
  assert.ok(side.a!.x >= side.b!.w);
  const pip = layoutWall("pip", ["a", "b"], "a", W, H, none);
  assert.equal(pip.a!.w, W);
  assert.ok(pip.b!.w < W / 3);
});

test("beaucoup d'images réduisent le bandeau au lieu de sortir de la scène", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const rects = layoutWall("focus", ids, "s0", W, H, none);
  for (const id of ids) assert.ok(rects[id]!.x + rects[id]!.w <= W + 0.01);
});

test("une disposition libre suit la taille de la scène, et une image nouvelle trouve une place", () => {
  const rects = layoutWall("free", ["a", "b"], null, 1000, 500, id => (id === "a" ? { x: 0.5, y: 0.5, w: 0.25, h: 0.25 } : undefined));
  assert.deepEqual(rects.a, { x: 500, y: 250, w: 250, h: 125 });
  assert.ok(rects.b!.w > 0);
});

test("une image glissée s'aimante aux bords et reste dans la scène", () => {
  const snapped = snapRect({ x: 6, y: 7, w: 300, h: 200 }, [], W, H, false);
  assert.equal(snapped.x, 0);
  assert.equal(snapped.y, 0);
  const inside = snapRect({ x: 5000, y: 5000, w: 300, h: 200 }, [], W, H, false);
  assert.equal(inside.x + inside.w, W);
  assert.equal(inside.y + inside.h, H);
  const neighbour = snapRect({ x: 406, y: 300, w: 300, h: 200 }, [{ x: 100, y: 100, w: 300, h: 150 }], W, H, false);
  assert.equal(neighbour.x, 400);
  assert.ok(snapRect({ x: 0, y: 0, w: 40, h: 20 }, [], W, H, true).w >= 200, "taille minimale");
});
