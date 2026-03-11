# Native Local OCR Architecture

## Goal

- 완전 오프라인 동작
- 현재 Tauri 데스크톱 앱 UI 유지
- 스크린샷, 문서, 한글/영문 혼합 이미지에서 정확도 우선
- macOS / Windows 공통 배포 가능

## Chosen Direction

현재 앱의 브라우저 OCR 계층은 유지하지 않는다.

대신 다음 구조로 전환한다.

1. Tauri frontend
- 역할: 이미지 업로드, 진행 상태, 결과 표시
- OCR 추론은 직접 하지 않음

2. Tauri Rust layer
- 역할: 프런트 요청 수신
- 임시 파일 생성
- sidecar OCR 엔진 실행
- JSON 결과를 프런트로 반환

3. Native OCR sidecar
- 역할: 실제 OCR 추론
- PaddleOCR 기반 로컬 추론 사용
- 모델은 앱에 포함된 로컬 파일만 사용
- 표준 출력으로 JSON 반환

## Why This Direction

브라우저/WebAssembly 기반 OCR은 배포는 쉽지만 정확도와 메모리 안정성이 제한된다.

네이티브 sidecar 구조가 더 적합한 이유:

- 더 큰 모델 사용 가능
- CPU 스레드 활용이 유리
- 대형 이미지 처리 안정성이 높음
- 모델 로딩, 전처리, 후처리를 웹뷰와 분리 가능
- Tauri 공식 `externalBin` 구조로 macOS/Windows 번들 가능

## OCR Engine Choice

권장 엔진:

- PaddleOCR local inference
- 모델 계열:
  - detection: `PP-OCRv5_server_det`
  - recognition: `PP-OCRv5_server_rec`
  - 필요 시 direction classify 추가

이유:

- 한글/영문 혼합 대응력이 Tesseract 계열보다 대체로 우수
- 스크린샷, 문서, 인쇄물에서 정확도 기대치가 높음
- 공식 로컬 추론 경로가 존재함

## Runtime Layout

```text
Frontend (index.html / script.js)
  -> invoke("run_ocr", { imagePath, profile, accuracy })

Rust command (src-tauri)
  -> validate input
  -> create temp workspace
  -> spawn sidecar
  -> collect stdout JSON
  -> return parsed result

Sidecar binary
  -> preprocess image
  -> run detection model
  -> crop line regions
  -> run recognition model
  -> line merge / cleanup
  -> emit JSON
```

## OCR Profiles

프런트에서 단순 모드 토글은 유지하되, 실제 프로필은 sidecar에 전달한다.

- `screenshot`
  - 작은 UI 폰트 대응
  - sharpen / upscale / contrast 강화
  - 긴 세로 이미지 슬라이싱 허용

- `document`
  - 여백 제거
  - deskew 우선
  - 문단 보존 중심

- `accuracy`
  - 느리지만 고정밀
  - 2-pass recognition
  - 더 큰 모델 입력 크기

## Sidecar Input / Output Contract

입력은 파일 경로 기반 JSON으로 고정한다.

Input example:

```json
{
  "image_path": "/tmp/input.png",
  "profile": "screenshot",
  "accuracy": true,
  "language_hint": "ko+en"
}
```

Output example:

```json
{
  "text": "final merged text",
  "lines": [
    {
      "text": "line 1",
      "score": 0.98,
      "box": [[0, 0], [120, 0], [120, 32], [0, 32]]
    }
  ],
  "meta": {
    "engine": "paddleocr",
    "model": "pp-ocr-v5-server",
    "elapsed_ms": 842
  }
}
```

## Packaging Strategy

Tauri sidecar 방식으로 번들한다.

예상 구조:

```text
src-tauri/
  binaries/
    native-ocr-aarch64-apple-darwin
    native-ocr-x86_64-apple-darwin
    native-ocr-x86_64-pc-windows-msvc.exe
  resources/
    models/
      det/
      rec/
      cls/
      dict/
```

Rust/Tauri에서는 sidecar 실행 파일을 직접 호출한다.

## Recommended Implementation Stack

### Option A: Python sidecar + PyInstaller

장점:

- PaddleOCR 공식 생태계 활용이 쉬움
- 구현 속도가 빠름

단점:

- 번들 크기가 큼
- 플랫폼별 빌드 파이프라인 관리 필요

### Option B: C++/Rust wrapper + ONNX Runtime native

장점:

- 속도와 배포 품질이 더 좋음
- 런타임 의존성이 더 적음

단점:

- 구현 난이도가 높음

### Decision

1차 구현은 `Python sidecar + PyInstaller`로 간다.

이유:

- 가장 빠르게 정확도 체감 개선 가능
- 모델 전환, 전처리 실험, 후처리 고도화가 쉬움
- 이후 필요하면 네이티브 ONNX Runtime 쪽으로 재이관 가능

## Frontend Changes

프런트는 최소 변경만 한다.

- 현재 업로드 UX 유지
- 결과 표시 UI 유지
- 진행 상태 표시 유지
- OCR 호출만 `window.Tesseract`에서 Tauri invoke 기반으로 교체

## Rust Layer Changes

추가할 것:

- `run_ocr` command
- temp file lifecycle 관리
- sidecar stdout/stderr 수집
- 실패 시 사용자용 에러 메시지 정규화

## Release Pipeline

릴리스 파이프라인은 다음 단계로 확장한다.

1. macOS runner에서 sidecar macOS binary 빌드
2. Windows runner에서 sidecar Windows binary 빌드
3. sidecar 파일을 `src-tauri/binaries`에 배치
4. Tauri bundle 빌드
5. `dmg` / `exe` 업로드

## Non-Goals

- 브라우저 내 OCR 유지
- CDN 모델 로딩
- 온라인 OCR API 의존

## Next Build Order

1. `native-ocr/` sidecar 프로젝트 추가
2. PaddleOCR 로컬 추론 CLI 작성
3. 표준 출력 JSON 규격 고정
4. Tauri `externalBin` 연결
5. 프런트에서 Tauri command 호출로 교체
6. macOS/Windows CI 빌드 연결
