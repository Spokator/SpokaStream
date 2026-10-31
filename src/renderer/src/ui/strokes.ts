import type { DrawTool } from "@shared/protocol.ts";

interface DrawnStroke {
  tool: DrawTool;
  color: string;
  points: number[];
  updatedAt: number;
  ended: boolean;
}

const LASER_LIFE_MS = 1400;

/** Dessins et pointeurs laser, partagés par les tuiles et le calque posé sur l'écran du diffuseur. */
export class StrokeCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly strokes = new Map<string, DrawnStroke>();
  private frame = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d")!;
  }

  add(id: string, tool: DrawTool, color: string, points: number[], end: boolean) {
    const existing = this.strokes.get(id);
    if (existing) {
      existing.points.push(...points);
      existing.updatedAt = performance.now();
      existing.ended = end;
    } else {
      this.strokes.set(id, { tool, color, points: [...points], updatedAt: performance.now(), ended: end });
    }
    this.schedule();
  }

  clear() {
    this.strokes.clear();
    this.schedule();
  }

  private schedule() {
    this.frame ||= requestAnimationFrame(() => this.draw());
  }

  private draw() {
    this.frame = 0;
    const { canvas, context: ctx } = this;
    const width = canvas.clientWidth * devicePixelRatio;
    const height = canvas.clientHeight * devicePixelRatio;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const now = performance.now();
    const scale = Math.max(1, width / 900);
    let animating = false;
    for (const [id, stroke] of this.strokes) {
      let alpha = 1;
      if (stroke.tool === "laser") {
        alpha = stroke.ended ? 1 - (now - stroke.updatedAt) / LASER_LIFE_MS : 1;
        if (alpha <= 0) {
          this.strokes.delete(id);
          continue;
        }
        animating = true;
      }
      const p = stroke.points;
      if (p.length < 2) continue;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = (stroke.tool === "laser" ? 3.5 : 4) * scale;
      ctx.shadowColor = stroke.color;
      ctx.shadowBlur = stroke.tool === "laser" ? 14 * scale : 0;
      ctx.beginPath();
      ctx.moveTo(p[0]! * width, p[1]! * height);
      for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i]! * width, p[i + 1]! * height);
      if (p.length === 2) ctx.lineTo(p[0]! * width + 0.1, p[1]! * height);
      ctx.stroke();
      if (stroke.tool === "laser") {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(p[p.length - 2]! * width, p[p.length - 1]! * height, 3.5 * scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (animating) this.schedule();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}
