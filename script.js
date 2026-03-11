import * as ort from "onnxruntime-web";
import Ocr from "@gutenye/ocr-browser";

const imageInput = document.querySelector("#imageInput");
const dropzone = document.querySelector("#dropzone");
const previewImage = document.querySelector("#previewImage");
const previewFrame = document.querySelector("#previewFrame");
const resultText = document.querySelector("#resultText");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const copyButton = document.querySelector("#copyButton");
const accuracyMode = document.querySelector("#accuracyMode");

const MODEL_PATHS = {
  detectionPath: "./assets/ocr/ch_PP-OCRv4_det_infer.onnx",
  recognitionPath: "./assets/ocr/ch_PP-OCRv4_rec_infer.onnx",
  dictionaryPath: "./assets/ocr/ppocr_keys_v1.txt",
};

const MAX_IMAGE_WIDTH = 2600;
const MAX_IMAGE_HEIGHT = 14000;
const MAX_IMAGE_PIXELS = 24_000_000;
const DEFAULT_SLICE_HEIGHT = 2600;
const DEFAULT_SLICE_OVERLAP = 220;
const ACCURACY_SLICE_HEIGHT = 1800;
const ACCURACY_SLICE_OVERLAP = 320;
const MIN_BASE_WIDTH = 1800;
const MIN_ACCURACY_WIDTH = 2400;

let activePreviewUrl = null;
let ocrPromise = null;

const isAccuracyMode = () => Boolean(accuracyMode?.checked);

const setStatus = (message, progress = 0) => {
  statusText.textContent = message;
  progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;
};

const getCanvasContext = (canvas) =>
  canvas.getContext("2d", { alpha: false, willReadFrequently: true });

const resetPreview = () => {
  if (activePreviewUrl) {
    URL.revokeObjectURL(activePreviewUrl);
    activePreviewUrl = null;
  }

  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  previewFrame.querySelector(".empty-message")?.remove();
};

const showPlaceholder = (message) => {
  previewFrame.querySelector(".empty-message")?.remove();
  const placeholder = document.createElement("p");
  placeholder.className = "empty-message";
  placeholder.textContent = message;
  previewFrame.appendChild(placeholder);
};

const renderImage = (file) => {
  resetPreview();
  activePreviewUrl = URL.createObjectURL(file);
  previewImage.src = activePreviewUrl;
  previewImage.hidden = false;
};

const loadBitmap = async (file) => {
  try {
    return await createImageBitmap(file);
  } catch (error) {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });

    URL.revokeObjectURL(url);
    return image;
  }
};

const computeScale = (width, height, accuracy) => {
  const minWidth = accuracy ? MIN_ACCURACY_WIDTH : MIN_BASE_WIDTH;
  const upscale = Math.max(1, minWidth / Math.max(1, width));
  let scale = Math.min(
    upscale,
    MAX_IMAGE_WIDTH / width,
    MAX_IMAGE_HEIGHT / height,
    Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
  );

  if (!Number.isFinite(scale) || scale <= 0) {
    scale = 1;
  }

  return scale;
};

const createPreparedCanvas = (bitmap, scale, options = {}) => {
  const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = getCanvasContext(canvas);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  if (!options.enhanced) {
    return canvas;
  }

  const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const gray = r * 0.299 + g * 0.587 + b * 0.114;
    const contrast = options.contrast ?? 1.24;
    const shifted = (gray - 128) * contrast + 128;
    const normalized = shifted > 220 ? 255 : shifted < 24 ? 0 : shifted;
    data[index] = normalized;
    data[index + 1] = normalized;
    data[index + 2] = normalized;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
};

const canvasToFile = async (canvas, name) => {
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (value) => {
        if (value) {
          resolve(value);
          return;
        }
        reject(new Error("이미지 변환에 실패했습니다."));
      },
      "image/png",
      1,
    );
  });

  return new File([blob], name, { type: "image/png" });
};

const normalizeImage = async (file, enhanced = false) => {
  const bitmap = await loadBitmap(file);
  const accuracy = isAccuracyMode();
  const scale = computeScale(bitmap.width, bitmap.height, accuracy);
  setStatus(enhanced ? "보정 이미지 생성 중" : "이미지 최적화 중", enhanced ? 12 : 8);
  const canvas = createPreparedCanvas(bitmap, scale, {
    enhanced,
    contrast: accuracy ? 1.32 : 1.18,
  });

  if ("close" in bitmap && typeof bitmap.close === "function") {
    bitmap.close();
  }

  return {
    width: canvas.width,
    height: canvas.height,
    file: await canvasToFile(
      canvas,
      file.name.replace(/\.\w+$/, "") + (enhanced ? "-enhanced.png" : "-base.png"),
    ),
  };
};

const sliceImage = async (file, width, height) => {
  const bitmap = await loadBitmap(file);
  const accuracy = isAccuracyMode();
  const sliceHeight = accuracy ? ACCURACY_SLICE_HEIGHT : DEFAULT_SLICE_HEIGHT;
  const sliceOverlap = accuracy ? ACCURACY_SLICE_OVERLAP : DEFAULT_SLICE_OVERLAP;
  const slices = [];
  let offsetY = 0;
  let index = 0;

  while (offsetY < height) {
    const currentHeight = Math.min(sliceHeight, height - offsetY);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = currentHeight;

    const context = getCanvasContext(canvas);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, currentHeight);
    context.drawImage(bitmap, 0, offsetY, width, currentHeight, 0, 0, width, currentHeight);

    slices.push(
      await canvasToFile(
        canvas,
        file.name.replace(/\.\w+$/, "") + `-slice-${String(index).padStart(2, "0")}.png`,
      ),
    );

    if (offsetY + currentHeight >= height) {
      break;
    }

    offsetY += currentHeight - sliceOverlap;
    index += 1;
  }

  if ("close" in bitmap && typeof bitmap.close === "function") {
    bitmap.close();
  }

  return slices;
};

const getOcrEngine = async () => {
  if (!ocrPromise) {
    ort.env.wasm.wasmPaths = "./assets/ort/";
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    ort.env.wasm.simd = true;
    ocrPromise = Ocr.create({ models: MODEL_PATHS });
  }

  return ocrPromise;
};

const normalizeLine = (line) =>
  line
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;!?%])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .trim();

const dedupeAdjacentLines = (lines) => {
  const deduped = [];

  for (const line of lines) {
    if (!line) continue;
    const previous = deduped[deduped.length - 1];
    if (!previous) {
      deduped.push(line);
      continue;
    }

    if (line === previous) continue;
    if (previous.includes(line) || line.includes(previous)) {
      deduped[deduped.length - 1] = previous.length >= line.length ? previous : line;
      continue;
    }

    deduped.push(line);
  }

  return deduped;
};

const mergeWrappedLines = (lines) => {
  const merged = [];

  for (const line of lines) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      /[A-Za-z0-9가-힣]$/.test(previous) &&
      /^[a-z0-9가-힣("'[\-]/.test(line) &&
      !/[.!?:)]$/.test(previous)
    ) {
      merged[merged.length - 1] = `${previous} ${line}`.replace(/\s+/g, " ");
      continue;
    }

    merged.push(line);
  }

  return merged;
};

const finalizeText = (lines) =>
  mergeWrappedLines(dedupeAdjacentLines(lines.map(normalizeLine).filter(Boolean))).join("\n");

const getLineScore = (line) => line?.score ?? line?.mean ?? 0;

const rankResult = (lines) => {
  const text = finalizeText(lines.map((line) => line.text || ""));
  const averageScore =
    lines.length > 0 ? lines.reduce((sum, line) => sum + getLineScore(line), 0) / lines.length : 0;
  return averageScore * 100 + text.length * 0.06;
};

const detectLines = async (ocr, file, progressMessage, progress) => {
  const url = URL.createObjectURL(file);
  try {
    setStatus(progressMessage, progress);
    const lines = await ocr.detect(url);
    return lines
      .filter((line) => (line.text || "").trim())
      .sort((left, right) => {
        const leftY = left.box?.[0]?.[1] ?? 0;
        const rightY = right.box?.[0]?.[1] ?? 0;
        if (Math.abs(leftY - rightY) > 12) {
          return leftY - rightY;
        }
        const leftX = left.box?.[0]?.[0] ?? 0;
        const rightX = right.box?.[0]?.[0] ?? 0;
        return leftX - rightX;
      });
  } finally {
    URL.revokeObjectURL(url);
  }
};

const extractText = async (file) => {
  resultText.value = "";
  copyButton.disabled = true;
  setStatus("로컬 OCR 엔진 준비 중", 4);

  try {
    const ocr = await getOcrEngine();
    const baseImage = await normalizeImage(file, false);
    const baseSlices = await sliceImage(baseImage.file, baseImage.width, baseImage.height);
    const accuracy = isAccuracyMode();
    let enhancedSlices = [];

    if (accuracy) {
      const enhancedImage = await normalizeImage(file, true);
      enhancedSlices = await sliceImage(
        enhancedImage.file,
        enhancedImage.width,
        enhancedImage.height,
      );
    }

    const collectedLines = [];
    for (let index = 0; index < baseSlices.length; index += 1) {
      const primaryLines = await detectLines(
        ocr,
        baseSlices[index],
        `텍스트 추출 중 (${index + 1}/${baseSlices.length})`,
        12 + ((index + 1) / baseSlices.length) * (accuracy ? 40 : 76),
      );

      if (!accuracy) {
        collectedLines.push(...primaryLines);
        continue;
      }

      const secondarySlice = enhancedSlices[index] || baseSlices[index];
      const secondaryLines = await detectLines(
        ocr,
        secondarySlice,
        `정밀 분석 중 (${index + 1}/${baseSlices.length})`,
        56 + ((index + 1) / baseSlices.length) * 34,
      );

      const bestLines = rankResult(primaryLines) >= rankResult(secondaryLines) ? primaryLines : secondaryLines;
      collectedLines.push(...bestLines);
    }

    resultText.value = finalizeText(collectedLines.map((line) => line.text || ""));
    copyButton.disabled = !resultText.value;
    setStatus("추출 완료", 100);
  } catch (error) {
    console.error(error);
    resultText.value = "";
    copyButton.disabled = true;
    setStatus("추출 실패", 0);
  }
};

const handleFile = async (file) => {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("이미지 파일만 업로드할 수 있습니다", 0);
    return;
  }

  renderImage(file);
  await extractText(file);
};

imageInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  await handleFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
  });
});

dropzone.addEventListener("drop", async (event) => {
  const [file] = event.dataTransfer?.files || [];
  await handleFile(file);
});

copyButton.addEventListener("click", async () => {
  if (!resultText.value) return;

  try {
    await navigator.clipboard.writeText(resultText.value);
    setStatus("텍스트를 복사했습니다", 100);
  } catch (error) {
    console.error(error);
    setStatus("복사 실패", 100);
  }
});

resetPreview();
showPlaceholder("업로드한 이미지가 여기에 표시됩니다.");
