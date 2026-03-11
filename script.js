const imageInput = document.querySelector("#imageInput");
const dropzone = document.querySelector("#dropzone");
const previewImage = document.querySelector("#previewImage");
const previewFrame = document.querySelector("#previewFrame");
const resultText = document.querySelector("#resultText");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const copyButton = document.querySelector("#copyButton");
const accuracyMode = document.querySelector("#accuracyMode");

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

    if (columnSplit) {
      const rightWidth = width - columnSplit.rightX;
      if (columnSplit.leftWidth < 80 || rightWidth < 80) {
        slices.push(
          await canvasToFile(
            canvas,
            file.name.replace(/\.\w+$/, "") + `-slice-${String(index).padStart(2, "0")}.png`,
          ),
        );
      } else {
        const leftCanvas = document.createElement("canvas");
        leftCanvas.width = columnSplit.leftWidth;
        leftCanvas.height = currentHeight;
        leftCanvas
          .getContext("2d", { alpha: false, willReadFrequently: true })
          .drawImage(
            canvas,
            0,
            0,
            columnSplit.leftWidth,
            currentHeight,
            0,
            0,
            columnSplit.leftWidth,
            currentHeight,
          );

        const rightCanvas = document.createElement("canvas");
        rightCanvas.width = rightWidth;
        rightCanvas.height = currentHeight;
        rightCanvas
          .getContext("2d", { alpha: false, willReadFrequently: true })
          .drawImage(
            canvas,
            columnSplit.rightX,
            0,
            rightWidth,
            currentHeight,
            0,
            0,
            rightWidth,
            currentHeight,
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
          canvas,
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
      tessedit_pageseg_mode: accuracy ? "4" : "6",
      user_defined_dpi: "300",
      textord_tabfind_find_tables: "0",
    });
    const results = [];

    for (let index = 0; index < slices.length; index += 1) {
      const baseText = await recognizeSlice(worker, slices[index], index, slices.length, {
        progressBase: accuracy ? 12 : 15,
        progressSpan: accuracy ? 48 : 75,
      });

      if (!accuracy) {
        results.push(baseText);
        continue;
      }

      const altText = await recognizeSlice(worker, slices[index], index, slices.length, {
        passLabel: " · 정밀 분석",
        progressBase: 60,
        progressSpan: 34,
        parameters: {
          preserve_interword_spaces: "1",
          tessedit_pageseg_mode: "11",
          user_defined_dpi: "360",
          textord_tabfind_find_tables: "0",
        },
      });

      results.push(chooseBestText([baseText, altText]));
    }

    resultText.value = results.filter(Boolean).join("\n\n");
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
