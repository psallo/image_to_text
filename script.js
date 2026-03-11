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

const setStatus = (message, progress = 0) => {
  statusText.textContent = message;
  progressBar.style.width = `${Math.max(0, Math.min(progress, 100))}%`;
};

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

const isAccuracyMode = () => Boolean(accuracyMode?.checked);

const normalizeLine = (line) =>
  line
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;!?%])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .trim();

const shouldMergeLine = (currentLine, nextLine) => {
  if (!currentLine || !nextLine) return false;
  if (/[.!?:)\]]$/.test(currentLine)) return false;
  if (/^[0-9]+[.)-]/.test(nextLine)) return false;
  return /[가-힣A-Za-z0-9]$/.test(currentLine) && /^[가-힣A-Za-z0-9("'\[]/.test(nextLine);
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

const postProcessText = (text, profile = "screenshot") => {
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
  if (profile === "document") {
    return deduped.join("\n");
  }

  return deduped.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const getTauriInvoke = () => window.__TAURI__?.core?.invoke;

const readFileBytes = async (file) => Array.from(new Uint8Array(await file.arrayBuffer()));

const invokeNativeOcr = async (file) => {
  const invoke = getTauriInvoke();
  if (!invoke) {
    throw new Error("네이티브 OCR은 데스크톱 앱에서만 실행됩니다.");
  }

  setStatus("이미지 전송 준비 중", 12);
  const imageBytes = await readFileBytes(file);
  setStatus("로컬 OCR 엔진 실행 중", 42);
  const response = await invoke("run_native_ocr", {
    payload: {
      imageBytes,
      filename: file.name,
      accuracy: isAccuracyMode(),
    },
  });
  setStatus("결과 정리 중", 84);
  return JSON.parse(response);
};

const extractText = async (file) => {
  resultText.value = "";
  copyButton.disabled = true;
  setStatus("이미지 분석 준비 중", 4);

  try {
    const payload = await invokeNativeOcr(file);
    const text = postProcessText(payload.text || "", payload.meta?.profile || "screenshot");

    resultText.value = text;
    copyButton.disabled = !text;
    setStatus(text ? "추출 완료" : "텍스트를 찾지 못했습니다", 100);
  } catch (error) {
    console.error(error);
    resultText.value = "";
    copyButton.disabled = true;
    setStatus(error.message || "추출 실패", 0);
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
if (!getTauriInvoke()) {
  setStatus("데스크톱 앱에서 로컬 OCR을 사용할 수 있습니다", 0);
}
