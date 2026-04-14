// ocr.swift — macOS Vision framework OCR helper
//
// Usage: swift ocr.swift /path/to/image.png
//
// Outputs JSON: { "lines": [{ "text": "...", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 }, ...] }
//
// Coordinates are normalized (0.0 to 1.0). Vision uses a coordinate system with
// origin at bottom-left, but we flip to top-left for easier display matching.

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("Usage: swift ocr.swift <image-path>\n".data(using: .utf8)!)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let url = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: url) else {
    FileHandle.standardError.write("Could not load image at \(imagePath)\n".data(using: .utf8)!)
    exit(1)
}

guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("Could not convert image to CGImage\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
request.usesLanguageCorrection = false  // disable for tabular data — keeps account IDs intact

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("OCR failed: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}

guard let observations = request.results else {
    print("{\"lines\":[]}")
    exit(0)
}

var lines: [[String: Any]] = []

for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let bbox = observation.boundingBox  // bottom-left origin, normalized
    // Flip y so origin is top-left
    let topY = 1.0 - bbox.origin.y - bbox.size.height
    lines.append([
        "text": candidate.string,
        "confidence": candidate.confidence,
        "x": bbox.origin.x,
        "y": topY,
        "w": bbox.size.width,
        "h": bbox.size.height
    ])
}

let result: [String: Any] = [
    "lines": lines,
    "imageWidth": cgImage.width,
    "imageHeight": cgImage.height
]

if let jsonData = try? JSONSerialization.data(withJSONObject: result, options: []),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
} else {
    FileHandle.standardError.write("Failed to encode JSON\n".data(using: .utf8)!)
    exit(1)
}
