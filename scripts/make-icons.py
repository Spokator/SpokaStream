"""Génère le logo SpokaStream : même famille que SpokaSoundBoard (carré arrondi dégradé, sourire), avec un bouton lecture et des ondes."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
S = 2048


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make():
    start, middle, end = (124, 92, 255), (79, 141, 255), (34, 211, 238)
    gradient = Image.new("RGB", (64, 64))
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126
            gradient.putpixel((x, y), lerp(start, middle, t / 0.55) if t < 0.55 else lerp(middle, end, (t - 0.55) / 0.45))
    gradient = gradient.resize((S, S), Image.BICUBIC)

    margin = int(S * 0.04)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((margin, margin, S - margin, S - margin), radius=int(S * 0.225), fill=255)

    art = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(art)

    # Bouton lecture, décalé vers la gauche : les ondes prennent la place à droite.
    cx, cy = S * 0.39, S * 0.43
    r = S * 0.165
    triangle = [(cx - r * 0.62, cy - r), (cx - r * 0.62, cy + r), (cx + r * 1.02, cy)]
    d.polygon(triangle, fill=255)
    outline = int(S * 0.055)
    for a, b in zip(triangle, triangle[1:] + triangle[:1]):
        d.line([a, b], fill=255, width=outline)
        d.ellipse((a[0] - outline / 2, a[1] - outline / 2, a[0] + outline / 2, a[1] + outline / 2), fill=255)

    # Ondes de diffusion
    width = int(S * 0.05)
    for radius, span in ((S * 0.24, 42), (S * 0.345, 38)):
        box = (cx - radius + S * 0.08, cy - radius, cx + radius + S * 0.08, cy + radius)
        d.arc(box, -span, span, fill=255, width=width)

    # Le sourire de la famille Spoka
    smile = (S * 0.22, S * 0.44, S * 0.78, S * 0.85)
    d.arc(smile, 30, 150, fill=255, width=int(S * 0.05))

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(gradient, (0, 0), mask)

    shadow = Image.new("RGBA", (S, S), (20, 10, 70, 0))
    shadow.putalpha(art.filter(ImageFilter.GaussianBlur(S * 0.012)).point(lambda v: v * 0.3))
    shadow = Image.composite(shadow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)
    icon = Image.alpha_composite(icon, shadow)
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    white.putalpha(art)
    icon = Image.alpha_composite(icon, Image.composite(white, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))
    return icon


def main():
    icon = make()
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    public = ROOT / "src" / "renderer" / "public"
    public.mkdir(parents=True, exist_ok=True)
    icon.resize((1024, 1024), Image.LANCZOS).save(build / "icon.png")
    icon.resize((256, 256), Image.LANCZOS).save(public / "logo.png")
    icon.resize((256, 256), Image.LANCZOS).save(build / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()
