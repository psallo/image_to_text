# Native OCR Sidecar

이 폴더는 완전 로컬 고정밀 OCR 엔진용 sidecar 프로젝트입니다.

의도된 구조:

```text
native-ocr/
  src/
  models/
  build/
```

목표:

- macOS: Apple Vision 기반 로컬 추론
- Windows: RapidOCR 기반 로컬 추론
- JSON stdin/stdout 또는 인자 기반 호출
- macOS/Windows sidecar 바이너리 생성

현재 상태:

- macOS용 Swift Vision CLI 구현
- Windows용 `rapidocr_onnxruntime` 기반 CLI 구현
- `python native-ocr/build.py`로 sidecar 바이너리 빌드 가능
