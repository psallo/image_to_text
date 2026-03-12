// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NativeOCRVision",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(name: "native-ocr", targets: ["NativeOCRVision"]),
    ],
    targets: [
        .executableTarget(
            name: "NativeOCRVision",
            path: "swift/Sources"
        ),
    ]
)
