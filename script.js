const imageInput = document.querySelector("#imageInput");
const dropzone = document.querySelector("#dropzone");
const previewImage = document.querySelector("#previewImage");
const previewFrame = document.querySelector("#previewFrame");
const resultText = document.querySelector("#resultText");
const statusText = document.querySelector("#statusText");
const progressBar = document.querySelector("#progressBar");
const copyButton = document.querySelector("#copyButton");

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

const computeScale = (sourceWidth, sourceHeight) => {
  let scale = Math.min(
    1,
    MAX_IMAGE_WIDTH / sourceWidth,
    MAX_IMAGE_HEIGHT / sourceHeight,
    Math.sqrt(MAX_IMAGE_PIXELS / (sourceWidth * sourceHeight)),
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

const drawNormalizedCanvas = (bitmap, scale) => {
  const upscale = Math.max(1, MIN_OCR_WIDTH / Math.max(1, bitmap.width * scale));
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
    const boosted = gray > 210 ? 255 : gray < 145 ? 0 : Math.min(255, Math.max(0, gray * 0.96));
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
  const scale = computeScale(bitmap.width, bitmap.height);

  setStatus("긴 이미지를 OCR용으로 최적화 중", 8);
  const canvas = drawNormalizedCanvas(bitmap, scale);
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
  let offsetY = 0;
  let index = 0;

  while (offsetY < height) {
    const currentHeight = Math.min(OCR_SLICE_HEIGHT, height - offsetY);
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

    offsetY += currentHeight - OCR_SLICE_OVERLAP;
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
      tessedit_pageseg_mode: "6",
      user_defined_dpi: "300",
      textord_tabfind_find_tables: "0",
    });
    const results = [];

    for (let index = 0; index < slices.length; index += 1) {
      const progressBase = 15 + (index / slices.length) * 75;
      setStatus(`텍스트 추출 중 (${index + 1}/${slices.length})`, progressBase);
      const {
        data: { text },
      } = await worker.recognize(slices[index]);
      results.push(text.trim());
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
