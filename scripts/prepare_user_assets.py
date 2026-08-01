from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageOps


WORKSPACE = Path(__file__).resolve().parents[3]
SOURCE = WORKSPACE / "素材"
PUBLIC = Path(__file__).resolve().parents[1] / "public"
ASSET_VERSION = "elytrue-20260724"

LANDSCAPE_SOURCES = (
    ("landscape1", SOURCE / "横图" / "官图" / "1.jpg"),
    ("landscape2", SOURCE / "横图" / "官图" / "2.png"),
    ("landscape3", SOURCE / "横图" / "合悟昂" / "1.png"),
    ("landscape4", SOURCE / "横图" / "合悟昂" / "2.png"),
    ("landscape5", SOURCE / "横图" / "喵咕君QAQ(KH3)" / "1.png"),
    ("landscape6", SOURCE / "横图" / "喵咕君QAQ(KH3)" / "2.jpg"),
    ("landscape7", SOURCE / "横图" / "喵咕君QAQ(KH3)" / "3.jpg"),
)

PORTRAIT_SOURCES = (
    ("portrait1", SOURCE / "竖图" / "nami" / "143282621_p0.jpg"),
    ("portrait2", SOURCE / "竖图" / "nami" / "nami.png"),
    ("portrait3", SOURCE / "竖图" / "roena" / "roena.png"),
    ("portrait4", SOURCE / "竖图" / "合悟昂" / "合悟昂.png"),
    ("portrait5", SOURCE / "竖图" / "合悟昂" / "合悟昂3.png"),
    ("portrait6", SOURCE / "竖图" / "喵咕君QAQ(KH3)" / "喵咕君2.jpg"),
    ("portrait7", SOURCE / "竖图" / "喵咕君QAQ(KH3)" / "喵咕君3.jpg"),
    ("portrait8", SOURCE / "竖图" / "喵咕君QAQ(KH3)" / "喵咕君4.jpg"),
    ("portrait9", SOURCE / "竖图" / "喵咕君QAQ(KH3)" / "喵咕君5.jpg"),
)

MUSIC_SOURCES = (
    "黄龄 HOYO-MiX - TruE.mp3",
    "HOYO-MiX - Conflict.mp3",
    "HOYO-MiX - Elysia.mp3",
    "HOYO-MiX - Elysian Realm.mp3",
    "HOYO-MiX - Erupt.mp3",
    "HOYO-MiX - ForEly.mp3",
    "HOYO-MiX - Last Waltz.mp3",
    "HOYO-MiX - Subtle.mp3",
    "HOYO-MiX - Sweet Trap.mp3",
    "HOYO-MiX - The Flawless Human.mp3",
)


def prepare_image(
    name: str,
    source: Path,
    destination: Path,
    max_size: tuple[int, int],
    quality: int,
) -> None:
    with Image.open(source) as opened:
        original = ImageOps.exif_transpose(opened).convert("RGB")
        preview = original.copy()
        preview.thumbnail(max_size, Image.Resampling.LANCZOS)
        preview.save(
            destination / f"{name}.webp",
            format="WEBP",
            quality=quality,
            method=6,
        )


def prepare_social_image(source: Path, destination: Path) -> None:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        social = ImageOps.fit(
            image,
            (1200, 630),
            method=Image.Resampling.LANCZOS,
            centering=(0.42, 0.5),
        )
        social.save(
            destination,
            format="JPEG",
            quality=86,
            optimize=True,
            progressive=True,
        )


def prepare_favicon(source: Path, destination: Path) -> None:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
        icon = ImageOps.fit(
            image,
            (320, 320),
            method=Image.Resampling.LANCZOS,
            centering=(0.38, 0.45),
        )
        icon.save(destination, format="PNG", optimize=True)


def main() -> None:
    images_output = PUBLIC / "assets" / ASSET_VERSION / "bg"
    originals_output = PUBLIC / "assets" / ASSET_VERSION / "originals"
    music_output = PUBLIC / "assets" / ASSET_VERSION / "bgm"
    resource_output = PUBLIC / "res"
    for output in (images_output, originals_output, music_output):
        if output.exists():
            shutil.rmtree(output)
        output.mkdir(parents=True, exist_ok=True)
    resource_output.mkdir(parents=True, exist_ok=True)

    for name, source in LANDSCAPE_SOURCES:
        if not source.is_file():
            raise FileNotFoundError(source)
        prepare_image(name, source, images_output, (1920, 1200), 76)
        shutil.copy2(source, originals_output / f"{name}{source.suffix.lower()}")

    for name, source in PORTRAIT_SOURCES:
        if not source.is_file():
            raise FileNotFoundError(source)
        prepare_image(name, source, images_output, (1440, 2160), 80)
        shutil.copy2(source, originals_output / f"{name}{source.suffix.lower()}")

    prepare_social_image(LANDSCAPE_SOURCES[1][1], PUBLIC / "social-share.jpg")
    prepare_favicon(LANDSCAPE_SOURCES[1][1], resource_output / "favicon-320.png")

    for source_name in MUSIC_SOURCES:
        source = SOURCE / "Music" / source_name
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copy2(source, music_output / source_name)

    print(
        f"Prepared {len(LANDSCAPE_SOURCES)} landscape WebP backgrounds, "
        f"{len(PORTRAIT_SOURCES)} portrait WebP backgrounds, "
        f"{len(LANDSCAPE_SOURCES) + len(PORTRAIT_SOURCES)} originals and "
        f"{len(MUSIC_SOURCES)} music tracks."
    )


if __name__ == "__main__":
    main()
