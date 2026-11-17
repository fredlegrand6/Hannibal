// Hannibal · cheap on-device OCR for the Continuous Awareness struggle layer.
//
// Uses the macOS Vision framework (built-in, no dependency) in .fast mode with
// language correction OFF — this is the cheap text-extraction step that runs on
// every CHANGED frame so the StruggleDetector can do its math on text, not pixels.
// NOTHING leaves the machine. Output is recognized text in reading order
// (top-to-bottom), one observation per line, printed to stdout.
//
//   usage:  ocr-vision <image-path>
//   build:  swiftc -O ocr-vision.swift -o ocr-vision   (done once by awareness.js)

import Foundation
import Vision
import CoreGraphics
import ImageIO

guard CommandLine.arguments.count >= 2 else {
    FileHandle.standardError.write("usage: ocr-vision <image>\n".data(using: .utf8)!)
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("cannot load image: \(url.path)\n".data(using: .utf8)!)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast          // cheap — this is the whole point
request.usesLanguageCorrection = false    // faster, and we only need raw text for hashing/diffing

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
    exit(4)
}

guard let observations = request.results else { exit(0) }

// Vision's coordinate origin is bottom-left, so a higher midY is higher on the
// screen. Sort descending by midY to get natural top-to-bottom reading order —
// which means the LAST characters of the joined text are the bottom of the
// screen (where terminal / compiler output lives). The struggle layer relies on
// that to hash "the bottom ~500 chars".
let lines: [(y: CGFloat, text: String)] = observations.compactMap { obs in
    guard let best = obs.topCandidates(1).first else { return nil }
    return (obs.boundingBox.midY, best.string)
}
let ordered = lines.sorted { $0.y > $1.y }.map { $0.text }
print(ordered.joined(separator: "\n"))
