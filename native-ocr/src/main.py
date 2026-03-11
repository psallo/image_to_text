from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image-path", required=True)
    parser.add_argument("--profile", choices=["auto", "screenshot", "document"], default="auto")
    parser.add_argument("--accuracy", action="store_true")
    parser.add_argument("--language-hint", default="ko+en")
    return parser.parse_args()


def ensure_color(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    return image


def detect_profile(image: np.ndarray) -> str:
    height, width = image.shape[:2]
    ratio = height / max(1, width)
    gray = cv2.cvtColor(ensure_color(image), cv2.COLOR_BGR2GRAY)
    white_ratio = float(np.mean(gray > 228))
    stddev = float(np.std(gray))

    if ratio >= 2.0 or height >= 2600:
        return "screenshot"
    if white_ratio >= 0.72 and stddev <= 55 and ratio >= 1.1:
        return "document"
    return "screenshot"


def resolve_profile(image: np.ndarray, requested_profile: str) -> str:
    if requested_profile != "auto":
        return requested_profile
    return detect_profile(image)


def upscale_image(image: np.ndarray, target_width: int) -> np.ndarray:
    height, width = image.shape[:2]
    if width >= target_width:
        return image
    scale = target_width / max(1, width)
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


def screenshot_preprocess(image: np.ndarray, enhanced: bool) -> np.ndarray:
    image = upscale_image(image, 2200 if enhanced else 1700)
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0 if enhanced else 2.2, tileGridSize=(8, 8))
    l_channel = clahe.apply(l_channel)
    image = cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)), cv2.COLOR_LAB2BGR)
    sharpen_kernel = np.array(
        [[0, -1, 0], [-1, 5.8 if enhanced else 4.9, -1], [0, -1, 0]],
        dtype=np.float32,
    )
    image = cv2.filter2D(image, -1, sharpen_kernel)
    return image


def document_preprocess(image: np.ndarray, enhanced: bool) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.fastNlMeansDenoising(gray, None, 8 if enhanced else 5, 7, 21)
    if enhanced:
        gray = cv2.adaptiveThreshold(
            gray,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            31,
            10,
        )
    else:
        gray = cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def preprocess(image: np.ndarray, profile: str, enhanced: bool) -> np.ndarray:
    image = ensure_color(image)
    if profile == "document":
        return document_preprocess(image, enhanced)
    return screenshot_preprocess(image, enhanced)


def create_engine(profile: str, accuracy: bool) -> RapidOCR:
    return RapidOCR(
        print_verbose=False,
        width_height_ratio=-1 if profile == "screenshot" else 8,
        min_height=10 if accuracy else 16,
    )


def line_score(line: list) -> float:
    try:
        return float(line[2])
    except Exception:
        return 0.0


def line_length(line: list) -> int:
    return len(str(line[1]).strip())


def line_anchor(line: list) -> tuple[float, float]:
    try:
        box = line[0]
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        return min(ys), min(xs)
    except Exception:
        return 0.0, 0.0


def normalize_text_line(text: str) -> str:
    return " ".join(text.split()).strip()


def merge_boxes(box: list, offset_y: int) -> list:
    merged = []
    for x, y in box:
        merged.append([x, y + offset_y])
    return merged


def should_merge_line(current_line: str, next_line: str) -> bool:
    if not current_line or not next_line:
        return False
    if current_line.endswith((".", "!", "?", ":", ")", "]")):
        return False
    if next_line[:1].isdigit():
        return False
    if current_line[-1].isalnum() and next_line[0].isalnum():
        return True
    if current_line[-1] in ("-", "/"):
        return True
    return False


def post_process(lines: list[list]) -> tuple[str, list[dict]]:
    sorted_lines = sorted(lines, key=line_anchor)
    normalized = []
    last_text = None

    for line in sorted_lines:
        text = normalize_text_line(str(line[1]))
        if not text:
            continue
        if last_text == text:
            continue
        last_text = text
        normalized.append(
            {
                "box": line[0],
                "text": text,
                "score": round(line_score(line), 4),
            }
        )

    merged_lines = []
    for line in normalized:
        if merged_lines and should_merge_line(merged_lines[-1]["text"], line["text"]):
            merged_lines[-1]["text"] = f'{merged_lines[-1]["text"]} {line["text"]}'.strip()
            merged_lines[-1]["score"] = max(merged_lines[-1]["score"], line["score"])
            continue
        merged_lines.append(line)

    text = "\n".join(line["text"] for line in merged_lines).strip()
    return text, merged_lines


def run_pass(ocr: RapidOCR, image: np.ndarray, profile: str, accuracy: bool) -> tuple[list[list], float]:
    result, _ = ocr(
        image,
        box_thresh=0.38 if accuracy else 0.48,
        unclip_ratio=2.0 if profile == "document" else 1.8,
        text_score=0.32 if accuracy else 0.45,
    )
    lines = result or []
    average = sum(line_score(line) for line in lines) / len(lines) if lines else 0.0
    return lines, average


def choose_best(primary: tuple[list[list], float], secondary: tuple[list[list], float]) -> list[list]:
    primary_lines, primary_score = primary
    secondary_lines, secondary_score = secondary
    primary_rank = primary_score * 100 + sum(line_length(line) for line in primary_lines) * 0.05
    secondary_rank = secondary_score * 100 + sum(line_length(line) for line in secondary_lines) * 0.05
    return primary_lines if primary_rank >= secondary_rank else secondary_lines


def build_slices(image: np.ndarray, profile: str, accuracy: bool) -> list[tuple[np.ndarray, int]]:
    height, width = image.shape[:2]
    if profile != "screenshot" or height < 2600:
        return [(image, 0)]

    slice_height = 1700 if accuracy else 2200
    slice_overlap = 260 if accuracy else 180
    slices = []
    offset_y = 0

    while offset_y < height:
        current_height = min(slice_height, height - offset_y)
        segment = image[offset_y : offset_y + current_height, 0:width].copy()
        slices.append((segment, offset_y))
        if offset_y + current_height >= height:
            break
        offset_y += current_height - slice_overlap

    return slices


def run_ocr(ocr: RapidOCR, image: np.ndarray, profile: str, accuracy: bool) -> list[list]:
    lines: list[list] = []

    for segment, offset_y in build_slices(image, profile, accuracy):
        primary = run_pass(ocr, preprocess(segment, profile, False), profile, accuracy)
        if accuracy:
            secondary = run_pass(ocr, preprocess(segment, profile, True), profile, True)
            selected = choose_best(primary, secondary)
        else:
            selected = primary[0]

        for line in selected:
            adjusted = [merge_boxes(line[0], offset_y), line[1], line_score(line)]
            lines.append(adjusted)

    return lines


def main() -> int:
    args = parse_args()
    image_path = Path(args.image_path)
    image = cv2.imread(str(image_path))
    if image is None:
        print(json.dumps({"error": f"Failed to read image: {image_path}"}), file=sys.stderr)
        return 1

    profile = resolve_profile(image, args.profile)
    ocr = create_engine(profile, args.accuracy)
    lines = run_ocr(ocr, image, profile, args.accuracy)
    text, normalized_lines = post_process(lines)

    payload = {
        "text": text,
        "lines": normalized_lines,
        "meta": {
            "engine": "rapidocr_onnxruntime",
            "profile": profile,
            "profile_source": "manual" if args.profile != "auto" else "auto",
            "accuracy": args.accuracy,
            "language_hint": args.language_hint,
        },
    }
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
