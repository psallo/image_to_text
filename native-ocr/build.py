from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = ROOT / "native-ocr"
ENTRYPOINT = SIDECAR_DIR / "src" / "main.py"
DIST_DIR = SIDECAR_DIR / "dist"
BUILD_DIR = SIDECAR_DIR / "build"
BINARIES_DIR = ROOT / "src-tauri" / "binaries"
SWIFT_PACKAGE_DIR = SIDECAR_DIR


def detect_target() -> str:
    output = subprocess.check_output(["rustc", "-vV"], text=True)
    for line in output.splitlines():
        if line.startswith("host: "):
            return line.split("host: ", 1)[1].strip()
    raise RuntimeError("Failed to detect Rust host target")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default=detect_target())
    return parser.parse_args()


def build_python_sidecar(target: str) -> Path:
    pyinstaller_args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "native-ocr",
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(BUILD_DIR),
        "--collect-all",
        "rapidocr_onnxruntime",
        "--collect-all",
        "onnxruntime",
        "--collect-all",
        "cv2",
        str(ENTRYPOINT),
    ]
    subprocess.check_call(pyinstaller_args, cwd=ROOT)

    built_name = "native-ocr.exe" if sys.platform == "win32" else "native-ocr"
    return DIST_DIR / built_name


def build_macos_sidecar() -> Path:
    subprocess.check_call(
        ["swift", "build", "-c", "release", "--product", "native-ocr"],
        cwd=SWIFT_PACKAGE_DIR,
    )
    return SWIFT_PACKAGE_DIR / ".build" / "release" / "native-ocr"


def main() -> int:
    args = parse_args()
    target = args.target

    if target.endswith("apple-darwin"):
        built_path = build_macos_sidecar()
    else:
        built_path = build_python_sidecar(target)

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    target_name = f"native-ocr-{target}"
    if target.endswith("windows-msvc"):
        target_name += ".exe"
    shutil.copy2(built_path, BINARIES_DIR / target_name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
