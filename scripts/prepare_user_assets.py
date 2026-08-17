from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps


REPOSITORY = Path(__file__).resolve().parents[1]
SOURCE = REPOSITORY.parent / "爱莉希雅"
PUBLIC = REPOSITORY / "public"
PREVIOUS_ASSET_ROOT = PUBLIC / "assets" / "elytrue-20260817"
OLD_ASSET_ROOTS = (
    PUBLIC / "assets" / "elytrue-20260813-r2",
    PUBLIC / "assets" / "elytrue-20260813",
)
ASSET_VERSION = "elytrue-20260817-fmp4"
ASSET_ROOT = PUBLIC / "assets" / ASSET_VERSION
MAX_VIDEO_SEGMENT_BYTES = 15_000_000


@dataclass(frozen=True)
class ImageSource:
    source: Path
    preview: Path
    original: Path
    max_size: tuple[int, int]
    quality: int


def image_source(
    source: str,
    preview: str,
    original: str,
    *,
    portrait: bool = False,
) -> ImageSource:
    return ImageSource(
        SOURCE / source,
        ASSET_ROOT / preview,
        ASSET_ROOT / original,
        (1440, 2160) if portrait else (1920, 1200),
        80 if portrait else 76,
    )


IMAGES = (
    *(
        image_source(
            f"横屏/landscape{number}{extension}",
            f"bg/auto/landscape/landscape{number}.webp",
            f"originals/auto/landscape/landscape{number}{extension}",
        )
        for number, extension in (
            (1, ".jpg"),
            (2, ".jpg"),
            (3, ".jpg"),
            (4, ".jpg"),
            (5, ".jpg"),
            (6, ".jpg"),
            (7, ".jpg"),
        )
    ),
    *(
        image_source(
            f"横屏/{name}{extension}",
            f"bg/auto/landscape/{name}.webp",
            f"originals/auto/landscape/{name}{extension}",
        )
        for name, extension in (
            ("1", ".jpg"),
            ("2", ".jpg"),
            ("3", ".jpg"),
            ("4", ".jpg"),
            ("7", ".jpg"),
            ("9", ".jpg"),
            ("10", ".jpg"),
            ("12", ".jpg"),
            ("14", ".jpg"),
            ("封面", ".jpg"),
        )
    ),
    *(
        image_source(
            f"竖屏图片/portrait{number}{extension}",
            f"bg/auto/portrait/portrait{number}.webp",
            f"originals/auto/portrait/portrait{number}{extension}",
            portrait=True,
        )
        for number, extension in (
            (1, ".jpg"),
            (2, ".jpg"),
            (3, ".jpg"),
            (4, ".jpg"),
            (5, ".jpg"),
            (6, ".jpg"),
            (7, ".jpg"),
            (8, ".jpg"),
            (9, ".jpg"),
        )
    ),
    image_source(
        "竖屏图片/8.jpg",
        "bg/auto/portrait/8.webp",
        "originals/auto/portrait/8.jpg",
        portrait=True,
    ),
    image_source(
        "竖屏图片/11.jpg",
        "bg/auto/portrait/11.webp",
        "originals/auto/portrait/11.jpg",
        portrait=True,
    ),
    image_source(
        "横屏特殊/集合！沁夏友乐园/16.jpg",
        "bg/themes/summer/16.webp",
        "originals/themes/summer/16.jpg",
    ),
    image_source(
        "横屏特殊/生日快乐！/6.jpg",
        "bg/themes/birthday-desktop/6.webp",
        "originals/themes/birthday-desktop/6.jpg",
    ),
    *(
        image_source(
            f"横屏特殊/偕行！青春畅想/{name}.jpg",
            f"bg/themes/youth/{name}.webp",
            f"originals/themes/youth/{name}.jpg",
        )
        for name in ("17", "18", "19")
    ),
    image_source(
        "横屏特殊/致爱莉希雅/17.jpg",
        "bg/themes/for-elysia/17.webp",
        "originals/themes/for-elysia/17.jpg",
    ),
    image_source(
        "竖屏特殊/生日快乐！/5.jpg",
        "bg/themes/birthday-mobile/5.webp",
        "originals/themes/birthday-mobile/5.jpg",
        portrait=True,
    ),
    image_source(
        "视频/妖精小姐的魔法邀约/封面.jpg",
        "bg/video/magical-invitation/封面.webp",
        "originals/video/magical-invitation/封面.jpg",
    ),
    image_source(
        "视频/爱莉希雅的化妆小课堂/封面.jpg",
        "bg/video/makeup-class/封面.webp",
        "originals/video/makeup-class/封面.jpg",
    ),
)


VIDEOS = (
    (
        "story-because-of-you",
        SOURCE
        / "视频"
        / "因你而在的故事"
        / "动画短片「因你而在的故事」-圣芙蕾雅档案馆-崩坏3WIKI.mp4",
    ),
    (
        "magical-invitation",
        SOURCE / "视频" / "妖精小姐的魔法邀约" / "妖精小姐的魔法邀约.mp4",
    ),
    (
        "makeup-class",
        SOURCE
        / "视频"
        / "爱莉希雅的化妆小课堂"
        / "爱莉希雅的化妆小课堂.mp4",
    ),
)


def prepare_image(record: ImageSource) -> None:
    if not record.source.is_file():
        raise FileNotFoundError(record.source)
    record.preview.parent.mkdir(parents=True, exist_ok=True)
    record.original.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(record.source) as opened:
        image = ImageOps.exif_transpose(opened)
        has_alpha = "A" in image.getbands()
        preview = image.convert("RGBA" if has_alpha else "RGB")
        preview.thumbnail(record.max_size, Image.Resampling.LANCZOS)
        preview.save(
            record.preview,
            format="WEBP",
            quality=record.quality,
            method=6,
            exact=has_alpha,
        )
    shutil.copy2(record.source, record.original)


def ffmpeg_executable() -> str:
    configured = os.environ.get("FFMPEG_EXE")
    candidate = configured or shutil.which("ffmpeg")
    if not candidate:
        raise RuntimeError(
            "ffmpeg is required; set FFMPEG_EXE to a temporary executable"
        )
    return candidate


def run_ffmpeg(source: Path, output: Path, *, reencode: bool) -> None:
    output.mkdir(parents=True, exist_ok=True)
    for child in output.iterdir():
        if child.is_file():
            child.unlink()
    command = [
        ffmpeg_executable(),
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
    ]
    if reencode:
        command.extend(
            [
                "-c:v",
                "libx265",
                "-preset",
                "medium",
                "-crf",
                "24",
                "-maxrate",
                "8M",
                "-bufsize",
                "12M",
                "-pix_fmt",
                "yuv420p",
                "-force_key_frames",
                "expr:gte(t,n_forced*10)",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ]
        )
    else:
        command.extend(["-c", "copy"])
    command.extend(
        [
            "-tag:v",
            "hvc1",
            "-hls_time",
            "10",
            "-hls_playlist_type",
            "vod",
            "-hls_segment_type",
            "fmp4",
            "-hls_fmp4_init_filename",
            "init.mp4",
            "-hls_flags",
            "independent_segments",
            "-hls_segment_filename",
            "segment-%03d.m4s",
            "index.m3u8",
        ]
    )
    subprocess.run(command, check=True, cwd=output)


def prepare_video(slug: str, source: Path) -> tuple[int, int]:
    if not source.is_file():
        raise FileNotFoundError(source)
    output = ASSET_ROOT / "video" / slug
    run_ffmpeg(source, output, reencode=False)
    segments = sorted(output.glob("segment-*.m4s"))
    if not segments:
        raise RuntimeError(f"no HLS segments generated for {source}")
    if max(segment.stat().st_size for segment in segments) > MAX_VIDEO_SEGMENT_BYTES:
        run_ffmpeg(source, output, reencode=True)
        segments = sorted(output.glob("segment-*.m4s"))
    maximum = max(segment.stat().st_size for segment in segments)
    if maximum > MAX_VIDEO_SEGMENT_BYTES:
        raise RuntimeError(
            f"video segment exceeds {MAX_VIDEO_SEGMENT_BYTES} bytes: {source} ({maximum})"
        )
    playlist = (output / "index.m3u8").read_text("utf8")
    if "#EXT-X-ENDLIST" not in playlist:
        raise RuntimeError(f"HLS playlist is not VOD-complete: {source}")
    if '#EXT-X-MAP:URI="init.mp4"' not in playlist:
        raise RuntimeError(f"HLS playlist has no fMP4 initialization segment: {source}")
    return len(segments), maximum


def copy_music(existing_music: Path) -> int:
    destination = ASSET_ROOT / "bgm"
    destination.mkdir(parents=True, exist_ok=True)
    songs = sorted(existing_music.glob("*.mp3"))
    if len(songs) != 11:
        raise RuntimeError(f"expected 11 existing songs, found {len(songs)}")
    for song in songs:
        shutil.copy2(song, destination / song.name)
    return len(songs)


def main() -> None:
    if not SOURCE.is_dir():
        raise FileNotFoundError(SOURCE)
    current_music = next(
        (
            candidate / "bgm"
            for candidate in (PREVIOUS_ASSET_ROOT, *OLD_ASSET_ROOTS, ASSET_ROOT)
            if (candidate / "bgm").is_dir()
        ),
        ASSET_ROOT / "bgm",
    )
    with tempfile.TemporaryDirectory(prefix="elytrue-music-") as temporary:
        staged_music = Path(temporary)
        for song in current_music.glob("*.mp3"):
            shutil.copy2(song, staged_music / song.name)

        if ASSET_ROOT.exists():
            shutil.rmtree(ASSET_ROOT)
        ASSET_ROOT.mkdir(parents=True)

        for record in IMAGES:
            prepare_image(record)
        song_count = copy_music(staged_music)
        video_stats = {
            slug: prepare_video(slug, source) for slug, source in VIDEOS
        }

    for legacy_root in (PREVIOUS_ASSET_ROOT, *OLD_ASSET_ROOTS):
        if legacy_root.exists():
            shutil.rmtree(legacy_root)

    print(
        f"Prepared {len(IMAGES)} canonical images, {song_count} songs and "
        f"{len(VIDEOS)} HLS videos in {ASSET_VERSION}."
    )
    for slug, (segments, maximum) in video_stats.items():
        print(f"- {slug}: {segments} segments, largest {maximum} bytes")


if __name__ == "__main__":
    main()
