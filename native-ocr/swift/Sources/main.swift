import CoreGraphics
import Foundation
import ImageIO
import Vision

struct OCRLine: Encodable {
    var box: [[Double]]
    var text: String
    var score: Double
}

struct OCRMeta: Encodable {
    let engine: String
    let profile: String
    let profileSource: String
    let accuracy: Bool
    let languageHint: String
}

struct OCRPayload: Encodable {
    let text: String
    let lines: [OCRLine]
    let meta: OCRMeta
}

struct CLIOptions {
    let imagePath: String
    let accuracy: Bool
    let languageHint: String
}

enum VisionOCRError: LocalizedError {
    case missingImagePath
    case invalidImage(String)

    var errorDescription: String? {
        switch self {
        case .missingImagePath:
            return "Missing required argument: --image-path"
        case .invalidImage(let path):
            return "Failed to read image: \(path)"
        }
    }
}

func parseArguments() throws -> CLIOptions {
    let args = Array(CommandLine.arguments.dropFirst())
    var imagePath: String?
    var accuracy = false
    var languageHint = "ko+en"

    var index = 0
    while index < args.count {
        let argument = args[index]
        switch argument {
        case "--image-path":
            index += 1
            guard index < args.count else { throw VisionOCRError.missingImagePath }
            imagePath = args[index]
        case "--accuracy":
            accuracy = true
        case "--language-hint":
            index += 1
            guard index < args.count else { throw VisionOCRError.missingImagePath }
            languageHint = args[index]
        default:
            break
        }
        index += 1
    }

    guard let imagePath else {
        throw VisionOCRError.missingImagePath
    }

    return CLIOptions(
        imagePath: imagePath,
        accuracy: accuracy,
        languageHint: languageHint
    )
}

func loadImage(_ path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path)
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw VisionOCRError.invalidImage(path)
    }
    return image
}

func normalizeLine(_ line: String) -> String {
    line.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

func shouldMerge(_ current: String, _ next: String) -> Bool {
    guard !current.isEmpty, !next.isEmpty else { return false }
    guard current.range(of: #"[.!?:)\]]$"#, options: .regularExpression) == nil else { return false }
    guard next.range(of: #"^[0-9]+[.)-]"#, options: .regularExpression) == nil else { return false }
    let currentPattern = #"[가-힣A-Za-z0-9]$"#
    let nextPattern = #"^[가-힣A-Za-z0-9("'[]"#
    return current.range(of: currentPattern, options: .regularExpression) != nil
        && next.range(of: nextPattern, options: .regularExpression) != nil
}

func mergeLines(_ observations: [VNRecognizedTextObservation], imageHeight: Double) -> [OCRLine] {
    let sorted = observations.sorted {
        if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.02 {
            return $0.boundingBox.midY > $1.boundingBox.midY
        }
        return $0.boundingBox.minX < $1.boundingBox.minX
    }

    var lines: [OCRLine] = []

    for observation in sorted {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = normalizeLine(candidate.string)
        guard !text.isEmpty else { continue }

        let rect = observation.boundingBox
        let minX = rect.minX
        let maxX = rect.maxX
        let topY = 1.0 - rect.maxY
        let bottomY = 1.0 - rect.minY
        let box = [
            [minX, topY * imageHeight],
            [maxX, topY * imageHeight],
            [maxX, bottomY * imageHeight],
            [minX, bottomY * imageHeight],
        ]

        let score = Double(candidate.confidence)
        if var last = lines.last, shouldMerge(last.text, text) {
            last.text = "\(last.text) \(text)"
            last.score = max(last.score, score)
            last.box[1][0] = box[1][0]
            last.box[2][0] = box[2][0]
            last.box[2][1] = box[2][1]
            last.box[3][1] = box[3][1]
            lines[lines.count - 1] = last
        } else {
            lines.append(OCRLine(box: box, text: text, score: score))
        }
    }

    return lines
}

func buildRequest(accuracy: Bool, languageHint: String) -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    request.usesCPUOnly = true
    request.minimumTextHeight = accuracy ? 0.012 : 0.018

    let preferredLanguages = languageHint.contains("ko")
        ? ["ko-KR", "ko", "en-US", "en"]
        : ["en-US", "en"]

    if let supportedLanguages = try? request.supportedRecognitionLanguages() {
        let resolved = preferredLanguages.filter { supportedLanguages.contains($0) }
        if !resolved.isEmpty {
            request.recognitionLanguages = resolved
        }
    }

    return request
}

func main() throws {
    let options = try parseArguments()
    let image = try loadImage(options.imagePath)
    let request = buildRequest(accuracy: options.accuracy, languageHint: options.languageHint)
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let lines = mergeLines(observations, imageHeight: Double(image.height))
    let text = lines.map(\.text).joined(separator: "\n")
    let payload = OCRPayload(
        text: text,
        lines: lines,
        meta: OCRMeta(
            engine: "apple_vision",
            profile: "auto",
            profileSource: "auto",
            accuracy: options.accuracy,
            languageHint: options.languageHint
        )
    )

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = try encoder.encode(payload)
    FileHandle.standardOutput.write(data)
}

do {
    try main()
} catch {
    let message: String
    if let nsError = error as NSError? {
        message = "\(nsError.domain) (\(nsError.code)): \(nsError.localizedDescription)"
    } else {
        message = error.localizedDescription
    }
    if let data = "{\"error\":\"\(message.replacingOccurrences(of: "\"", with: "\\\""))\"}".data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
    exit(1)
}
