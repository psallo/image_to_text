# Simple OCR Desktop

이미지를 넣으면 텍스트를 추출하는 아주 단순한 Tauri 데스크톱 앱입니다.

## Stack

- Frontend: HTML, CSS, JavaScript
- Desktop shell: Tauri 2
- OCR: Tesseract.js

## Local setup

### 1. Install prerequisites

macOS:

- Node.js 20+
- Rust
- Xcode Command Line Tools

Windows:

- Node.js 20+
- Rust
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

### 3. Run the desktop app

```bash
npm run dev
```

이 명령은 웹 파일을 `dist/`로 복사한 뒤 Tauri 앱을 실행합니다.

### 4. Build bundles

```bash
npm run build
```

빌드 산출물은 `src-tauri/target/release/bundle/` 아래에 생성됩니다.

## Cross-platform builds

- macOS 앱은 macOS에서 빌드하는 것이 가장 안전합니다.
- Windows 앱은 Windows에서 빌드하는 것이 가장 안전합니다.
- 저장소를 GitHub에 올리면 `.github/workflows/build-tauri.yml`로 macOS/Windows 빌드를 자동화할 수 있습니다.

## Notes

- 현재 OCR 엔진은 CDN에서 로드되므로 첫 실행 시 인터넷 연결이 필요합니다.
- 긴 스크린샷 이미지를 위해 전처리, 슬라이싱, 컬럼 분리 로직이 포함되어 있습니다.
