const imageInput = document.querySelector("#imageInput");
const dropzone = document.querySelector("#dropzone");
const previewImage = document.querySelector("#previewImage");
const previewFrame = document.querySelector("#previewFrame");
const resultText = document.querySelector("#resultText");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const copyButton = document.querySelector("#copyButton");
const accuracyMode = document.querySelector("#accuracyMode");
const ocrMode = document.querySelector("#ocrMode");

let activeObjectUrl = null;
let workerPromise = null;

const OCR_VERSION = "5.1.1";
const MAX_IMAGE_WIDTH = 2400;
const MAX_IMAGE_HEIGHT = 12000;
const MAX_IMAGE_PIXELS = 18_000_000;
const OCR_SLICE_HEIGHT = 2200;
const OCR_SLICE_OVERLAP = 180;
const MIN_OCR_WIDTH = 1400;
const COLUMN_GAP_TRIGGER = 245;
const ACCURACY_MIN_OCR_WIDTH = 2200;
const ACCURACY_SLICE_HEIGHT = 1600;
const ACCURACY_SLICE_OVERLAP = 260;

const setStatus = (message, progress = 0) => {
  statusText.textContent = message;
  progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;
};

const getCanvasContext = (canvas) =>
  canvas.getContext("2d", { alpha: false, willReadFrequently: true });

const resetPreview = () => {
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
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
  activeObjectUrl = URL.createObjectURL(file);
  previewImage.src = activeObjectUrl;
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

const isAccuracyMode = () => Boolean(accuracyMode?.checked);
const getOcrMode = () => ocrMode?.value || "screenshot";

const computeScale = (sourceWidth, sourceHeight, options = {}) => {
  const maxImageWidth = options.maxImageWidth ?? MAX_IMAGE_WIDTH;
  const maxImageHeight = options.maxImageHeight ?? MAX_IMAGE_HEIGHT;
  const maxImagePixels = options.maxImagePixels ?? MAX_IMAGE_PIXELS;
  let scale = Math.min(
    1,
    maxImageWidth / sourceWidth,
    maxImageHeight / sourceHeight,
    Math.sqrt(maxImagePixels / (sourceWidth * sourceHeight)),
  );

  if (!Number.isFinite(scale) || scale <= 0) {
    scale = 1;
  }

  return scale;
};

const detectColumnSplit = (context, width, height) => {
  if (width < 900) {
    return null;
  }

  const sampleTop = Math.floor(height * 0.15);
  const sampleHeight = Math.max(400, Math.floor(height * 0.7));
  const imageData = context.getImageData(0, sampleTop, width, Math.min(sampleHeight, height - sampleTop));
  const { data } = imageData;
  const whitespaceScores = new Array(width).fill(0);

  for (let x = 0; x < width; x += 1) {
    let whitePixels = 0;
    for (let y = 0; y < imageData.height; y += 1) {
      const index = (y * width + x) * 4;
      const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
      if (gray > 245) {
        whitePixels += 1;
      }
    }
    whitespaceScores[x] = whitePixels / imageData.height;
  }

  const centerStart = Math.floor(width * 0.22);
  const centerEnd = Math.ceil(width * 0.78);
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;

  for (let x = centerStart; x < centerEnd; x += 1) {
    if (whitespaceScores[x] > 0.985) {
      if (currentStart === -1) {
        currentStart = x;
      }
    } else if (currentStart !== -1) {
      const length = x - currentStart;
      if (length > bestLength) {
        bestStart = currentStart;
        bestLength = length;
      }
      currentStart = -1;
    }
  }

  if (currentStart !== -1) {
    const length = centerEnd - currentStart;
    if (length > bestLength) {
      bestStart = currentStart;
      bestLength = length;
    }
  }

  if (bestLength < COLUMN_GAP_TRIGGER) {
    return null;
  }

  return {
    leftWidth: Math.max(1, bestStart - 20),
    rightX: Math.min(width - 1, bestStart + bestLength + 20),
  };
};

const drawNormalizedCanvas = (bitmap, scale, options = {}) => {
  const targetMinWidth = options.targetMinWidth ?? MIN_OCR_WIDTH;
  const thresholdHigh = options.thresholdHigh ?? 210;
  const thresholdLow = options.thresholdLow ?? 145;
  const grayScaleFactor = options.grayScaleFactor ?? 0.96;
  const upscale = Math.max(1, targetMinWidth / Math.max(1, bitmap.width * scale));
  const finalScale = scale * upscale;
  const targetWidth = Math.max(1, Math.round(bitmap.width * finalScale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * finalScale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = getCanvasContext(canvas);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    const boosted =
      gray > thresholdHigh
        ? 255
        : gray < thresholdLow
          ? 0
          : Math.min(255, Math.max(0, gray * grayScaleFactor));
    data[index] = boosted;
    data[index + 1] = boosted;
    data[index + 2] = boosted;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
};

const applyThresholdVariant = (sourceCanvas, options = {}) => {
  const thresholdHigh = options.thresholdHigh ?? 215;
  const thresholdLow = options.thresholdLow ?? 140;
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const context = getCanvasContext(canvas);
  context.drawImage(sourceCanvas, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const gray = data[index];
    const value = gray > thresholdHigh ? 255 : gray < thresholdLow ? 0 : gray;
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
};

const applySharpenVariant = (sourceCanvas) => {
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const context = getCanvasContext(canvas);
  context.drawImage(sourceCanvas, 0, 0);
  const source = context.getImageData(0, 0, canvas.width, canvas.height);
  const target = context.createImageData(canvas.width, canvas.height);
  const { width, height, data } = source;
  const targetData = target.data;
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let value = 0;
      let kernelIndex = 0;

      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const index = ((y + ky) * width + (x + kx)) * 4;
          value += data[index] * kernel[kernelIndex];
          kernelIndex += 1;
        }
      }

      const clamped = Math.max(0, Math.min(255, value));
      const pixelIndex = (y * width + x) * 4;
      targetData[pixelIndex] = clamped;
      targetData[pixelIndex + 1] = clamped;
      targetData[pixelIndex + 2] = clamped;
      targetData[pixelIndex + 3] = 255;
    }
  }

  context.putImageData(target, 0, 0);
  return canvas;
};

const trimEmptyEdges = (sourceCanvas) => {
  const context = getCanvasContext(sourceCanvas);
  const imageData = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const { data, width, height } = imageData;
  let top = 0;
  let bottom = height - 1;

  const rowInk = (y) => {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index] < 240) return true;
    }
    return false;
  };

  while (top < bottom && !rowInk(top)) top += 1;
  while (bottom > top && !rowInk(bottom)) bottom -= 1;

  if (top === 0 && bottom === height - 1) {
    return sourceCanvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = bottom - top + 1;
  getCanvasContext(canvas).drawImage(
    sourceCanvas,
    0,
    top,
    width,
    canvas.height,
    0,
    0,
    width,
    canvas.height,
  );
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

const normalizeImage = async (file) => {
  const bitmap = await loadBitmap(file);
  const accuracy = isAccuracyMode();
  const scale = computeScale(bitmap.width, bitmap.height, {
    maxImageWidth: accuracy ? 2800 : MAX_IMAGE_WIDTH,
    maxImageHeight: accuracy ? 14000 : MAX_IMAGE_HEIGHT,
    maxImagePixels: accuracy ? 24_000_000 : MAX_IMAGE_PIXELS,
  });

  setStatus(accuracy ? "정확도 우선 전처리 중" : "긴 이미지를 OCR용으로 최적화 중", 8);
  const canvas = drawNormalizedCanvas(bitmap, scale, {
    targetMinWidth: accuracy ? ACCURACY_MIN_OCR_WIDTH : MIN_OCR_WIDTH,
    thresholdHigh: accuracy ? 218 : 210,
    thresholdLow: accuracy ? 132 : 145,
    grayScaleFactor: accuracy ? 0.92 : 0.96,
  });
  const context = getCanvasContext(canvas);
  const columnSplit = detectColumnSplit(context, canvas.width, canvas.height);

  if ("close" in bitmap && typeof bitmap.close === "function") {
    bitmap.close();
  }

  const normalizedFile = await canvasToFile(
    canvas,
    file.name.replace(/\.\w+$/, "") + "-normalized.png",
  );

  return {
    file: normalizedFile,
    width: canvas.width,
    height: canvas.height,
    columnSplit,
  };
};

const sliceImage = async (file, width, height, columnSplit = null) => {
  const bitmap = await loadBitmap(file);
  const slices = [];
  const accuracy = isAccuracyMode();
  const mode = getOcrMode();
  const sliceHeight = accuracy ? ACCURACY_SLICE_HEIGHT : OCR_SLICE_HEIGHT;
  const sliceOverlap = accuracy ? ACCURACY_SLICE_OVERLAP : OCR_SLICE_OVERLAP;
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
    context.drawImage(
      bitmap,
      0,
      offsetY,
      width,
      currentHeight,
      0,
      0,
      width,
      currentHeight,
    );
    const preparedCanvas = mode === "document" ? trimEmptyEdges(canvas) : canvas;

    if (columnSplit) {
      const workingCanvas = preparedCanvas;
      const rightWidth = workingCanvas.width - columnSplit.rightX;
      if (columnSplit.leftWidth < 80 || rightWidth < 80) {
        slices.push(
          await canvasToFile(
            workingCanvas,
            file.name.replace(/\.\w+$/, "") + `-slice-${String(index).padStart(2, "0")}.png`,
          ),
        );
      } else {
        const leftCanvas = document.createElement("canvas");
        leftCanvas.width = columnSplit.leftWidth;
        leftCanvas.height = workingCanvas.height;
        leftCanvas
          .getContext("2d", { alpha: false, willReadFrequently: true })
          .drawImage(
            workingCanvas,
            0,
            0,
            columnSplit.leftWidth,
            workingCanvas.height,
            0,
            0,
            columnSplit.leftWidth,
            workingCanvas.height,
          );

        const rightCanvas = document.createElement("canvas");
        rightCanvas.width = rightWidth;
        rightCanvas.height = workingCanvas.height;
        rightCanvas
          .getContext("2d", { alpha: false, willReadFrequently: true })
          .drawImage(
            workingCanvas,
            columnSplit.rightX,
            0,
            rightWidth,
            workingCanvas.height,
            0,
            0,
            rightWidth,
            workingCanvas.height,
          );

        slices.push(
          await canvasToFile(
            leftCanvas,
            file.name.replace(/\.\w+$/, "") + `-slice-${String(index).padStart(2, "0")}-left.png`,
          ),
        );
        slices.push(
          await canvasToFile(
            rightCanvas,
            file.name.replace(/\.\w+$/, "") + `-slice-${String(index).padStart(2, "0")}-right.png`,
          ),
        );
      }
    } else {
      slices.push(
        await canvasToFile(
          preparedCanvas,
          file.name.replace(/\.\w+$/, "") + `-slice-${String(index).padStart(2, "0")}.png`,
        ),
      );
    }

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

const getWorker = async () => {
  if (!window.Tesseract) {
    throw new Error("OCR 라이브러리를 불러오지 못했습니다.");
  }

  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker("kor+eng", 1, {
      workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${OCR_VERSION}/dist/worker.min.js`,
      corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${OCR_VERSION}`,
      cacheMethod: "none",
      logger: ({ status, progress }) => {
        const normalized = typeof progress === "number" ? progress * 100 : 10;
        const label =
          status === "recognizing text" ? "텍스트 추출 중" : "이미지 처리 중";
        setStatus(label, normalized);
      },
    });
  }

  return workerPromise;
};

const scoreText = (text) => {
  if (!text) return 0;
  const hangulMatches = text.match(/[가-힣]/g) || [];
  const latinMatches = text.match(/[A-Za-z]/g) || [];
  const digitMatches = text.match(/[0-9]/g) || [];
  const weirdMatches = text.match(/[^\s가-힣A-Za-z0-9.,:;!?@%/()\-_'"]/g) || [];
  return hangulMatches.length * 2 + latinMatches.length + digitMatches.length * 0.8 - weirdMatches.length * 1.4;
};

const chooseBestText = (candidates) =>
  candidates
    .filter(Boolean)
    .sort((left, right) => scoreText(right) - scoreText(left))[0] || "";

const normalizeLine = (line) =>
  line
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;!?%])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .trim();

const shouldMergeLine = (currentLine, nextLine) => {
  if (!currentLine || !nextLine) return false;
  if (/[.!?:)]$/.test(currentLine)) return false;
  if (/^[0-9]+[.)-]/.test(nextLine)) return false;
  if (/^[A-Z0-9][A-Za-z0-9\s]{0,6}$/.test(currentLine)) return false;
  return /[가-힣A-Za-z0-9]$/.test(currentLine) && /^[가-힣a-z0-9("']/.test(nextLine);
};

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

const postProcessText = (text, mode) => {
  const rawLines = text
    .split("\n")
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  const mergedLines = [];
  for (const line of rawLines) {
    const previous = mergedLines[mergedLines.length - 1];
    if (shouldMergeLine(previous, line)) {
      mergedLines[mergedLines.length - 1] = `${previous} ${line}`.replace(/\s+/g, " ");
      continue;
    }
    mergedLines.push(line);
  }

  const deduped = dedupeAdjacentLines(mergedLines);
  if (mode === "document") {
    return deduped.join("\n");
  }

  const grouped = [];
  for (const line of deduped) {
    if (/^[0-9]+[.)-]/.test(line) || /^[A-Z][A-Za-z\s]{2,}$/.test(line)) {
      grouped.push(`\n${line}`);
      continue;
    }
    grouped.push(line);
  }
  return grouped.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const createSliceVariants = async (sliceFile, mode, accuracy) => {
  const bitmap = await loadBitmap(sliceFile);
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = bitmap.width;
  baseCanvas.height = bitmap.height;
  getCanvasContext(baseCanvas).drawImage(bitmap, 0, 0);

  if ("close" in bitmap && typeof bitmap.close === "function") {
    bitmap.close();
  }

  const variants = [
    {
      label: "",
      file: await canvasToFile(baseCanvas, sliceFile.name.replace(".png", "-base.png")),
      parameters: {
        tessedit_pageseg_mode: mode === "document" ? "6" : accuracy ? "4" : "11",
        user_defined_dpi: accuracy ? "360" : "300",
      },
    },
  ];

  const thresholdCanvas = applyThresholdVariant(baseCanvas, {
    thresholdHigh: mode === "document" ? 224 : 216,
    thresholdLow: mode === "document" ? 150 : 132,
  });
  variants.push({
    label: " · threshold",
    file: await canvasToFile(thresholdCanvas, sliceFile.name.replace(".png", "-threshold.png")),
    parameters: {
      tessedit_pageseg_mode: mode === "document" ? "6" : "11",
      user_defined_dpi: accuracy ? "380" : "320",
    },
  });

  const sharpenCanvas = applySharpenVariant(baseCanvas);
  variants.push({
    label: " · sharpen",
    file: await canvasToFile(sharpenCanvas, sliceFile.name.replace(".png", "-sharpen.png")),
    parameters: {
      tessedit_pageseg_mode: mode === "document" ? "4" : "11",
      user_defined_dpi: accuracy ? "400" : "320",
    },
  });

  return variants;
};

const recognizeSlice = async (worker, slice, index, total, options = {}) => {
  const passLabel = options.passLabel ?? "";
  const progressBase = options.progressBase ?? 15;
  const progressSpan = options.progressSpan ?? 75;
  const progress = progressBase + ((index + 1) / total) * progressSpan;
  setStatus(`텍스트 추출 중 (${index + 1}/${total})${passLabel}`, progress);

  if (options.parameters) {
    await worker.setParameters(options.parameters);
  }

  const {
    data: { text },
  } = await worker.recognize(slice);

  return text.trim();
};

const extractText = async (file) => {
  if (!window.Tesseract) {
    setStatus("OCR 라이브러리를 불러오지 못했습니다", 0);
    resultText.value = "";
    return;
  }

  resultText.value = "";
  copyButton.disabled = true;
  setStatus("이미지 분석 준비 중", 5);

  try {
    const accuracy = isAccuracyMode();
    const mode = getOcrMode();
    const normalized = await normalizeImage(file);
    const slices = await sliceImage(
      normalized.file,
      normalized.width,
      normalized.height,
      normalized.columnSplit,
    );
    const worker = await getWorker();
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: mode === "document" ? "6" : accuracy ? "4" : "11",
      user_defined_dpi: mode === "document" ? "360" : "300",
      textord_tabfind_find_tables: "0",
    });
    const results = [];

    for (let index = 0; index < slices.length; index += 1) {
      const variants = await createSliceVariants(slices[index], mode, accuracy);
      const candidates = [];

      for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
        const variant = variants[variantIndex];
        const candidate = await recognizeSlice(worker, variant.file, index, slices.length, {
          passLabel: variant.label,
          progressBase: 12 + (variantIndex / variants.length) * 48,
          progressSpan: accuracy ? 18 : 22,
          parameters: {
            preserve_interword_spaces: "1",
            textord_tabfind_find_tables: "0",
            ...variant.parameters,
          },
        });
        candidates.push(candidate);
        if (!accuracy && variantIndex === 1) break;
      }

      results.push(chooseBestText(candidates));
    }

    resultText.value = postProcessText(results.filter(Boolean).join("\n\n"), mode);
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
