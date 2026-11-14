"""Generate crisp multi-resolution Windows .ico icon for Cafe One."""

from pathlib import Path
from PIL import Image, ImageDraw


def build_icon(out_path: Path) -> None:
    size = 1024
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded square warm espresso badge background
    pad = 48
    radius = 220
    draw.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=radius,
        fill=(27, 14, 8, 255),
        outline=(212, 160, 88, 255),
        width=28,
    )

    # Inner golden ring highlight
    inner_pad = 96
    draw.rounded_rectangle(
        [inner_pad, inner_pad, size - inner_pad, size - inner_pad],
        radius=176,
        fill=(43, 22, 12, 255),
        outline=(122, 68, 36, 180),
        width=10,
    )

    # Minimal geometric espresso cup & crema silhouette
    cup_left, cup_top, cup_right, cup_bottom = 250, 390, 710, 745
    draw.rounded_rectangle(
        [cup_left, cup_top, cup_right, cup_bottom],
        radius=120,
        fill=(245, 230, 211, 255),
    )
    # Trim flat top of cup cleanly and overlay warm amber coffee surface
    draw.rectangle([cup_left, cup_top, cup_right, cup_top + 115], fill=(245, 230, 211, 255))
    draw.rounded_rectangle(
        [cup_left + 26, cup_top + 22, cup_right - 26, cup_top + 88],
        radius=30,
        fill=(184, 118, 46, 255),
    )

    # Cup handle on the right
    draw.arc(
        [650, 440, 815, 640],
        start=270,
        end=90,
        fill=(245, 230, 211, 255),
        width=54,
    )

    # Saucer base
    draw.rounded_rectangle([225, 768, 735, 816], radius=24, fill=(217, 155, 75, 255))

    # Minimal three steam lines above cup
    for sx, top_y in ((380, 225), (480, 185), (580, 225)):
        draw.rounded_rectangle([sx - 18, top_y, sx + 18, 345], radius=18, fill=(243, 198, 143, 255))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    master = img.resize((256, 256), Image.Resampling.LANCZOS)
    master.save(
        out_path,
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    target = root / "assets" / "cafe-one.ico"
    build_icon(target)
    print("Generated icon:", target)
