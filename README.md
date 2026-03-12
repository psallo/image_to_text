# Simple OCR Desktop

이미지를 넣으면 텍스트를 추출하는 아주 단순한 Tauri 데스크톱 앱입니다.

## Stack

- Frontend: HTML, CSS, JavaScript
- Desktop shell: Tauri 2
- OCR UI bridge: Tauri command
- OCR engine
  - macOS: Apple Vision
  - Windows: RapidOCR + ONNX Runtime

## Local setup

### 1. Install prerequisites

macOS:

- Node.js 20+
- Rust
- Xcode Command Line Tools

Windows:

- Node.js 20+
- Rust
- Python 3.11+
- Microsoft Visual Studio C++ Build Tools
- WebView2

Rust install:

```bash
curl https://sh.rustup.rs -sSf | sh
```

### 2. Install frontend dependencies

```bash
npm install
```

### 3. Install native OCR dependencies

```bash
python3 -m pip install -r native-ocr/requirements.txt
```

macOS는 sidecar 빌드에 Python 패키지가 필수는 아니고, Windows용 RapidOCR 빌드에 필요합니다.

### 4. Build the native OCR sidecar

```bash
python3 native-ocr/build.py
```

이 명령은 현재 플랫폼용 OCR 실행 파일을 `src-tauri/binaries/`에 생성합니다.
- macOS: Swift + Apple Vision sidecar
- Windows: Python + RapidOCR sidecar

### 5. Run the desktop app

```bash
npm run dev
```

이 명령은 웹 파일을 `dist/`로 복사한 뒤 Tauri 앱을 실행합니다.

### 6. Build bundles

```bash
npm run build
```

빌드 산출물은 `src-tauri/target/release/bundle/` 아래에 생성됩니다.

## Cross-platform builds

- macOS 앱은 macOS에서 빌드하는 것이 가장 안전합니다.
- Windows 앱은 Windows에서 빌드하는 것이 가장 안전합니다.
- 저장소를 GitHub에 올리면 `.github/workflows/build-tauri.yml`로 macOS/Windows 빌드를 자동화할 수 있습니다.

## Notes

- 앱은 OCR 실행 시 인터넷 연결이 필요하지 않습니다.
- 긴 스크린샷은 sidecar 내부에서 세로 슬라이싱 후 병합합니다.
- GitHub Actions는 플랫폼에 따라 해당 sidecar를 빌드한 뒤 Tauri 번들을 생성합니다.
