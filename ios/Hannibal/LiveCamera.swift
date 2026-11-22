// ─────────────────────────────────────────────────────────────────────────
// LIVE CAMERA — during live talk Fred can turn the camera on and just talk:
// "what's wrong with this?", "read this", "which wine goes with this?".
// Each time he finishes a sentence, the latest frame goes with it to
// /api/voice-look, so Hannibal sees what the phone sees at that moment.
// Video only (no camera microphone), so live talk's echo-cancelled audio
// is left alone. Tap the preview to switch between back and front camera.
// ─────────────────────────────────────────────────────────────────────────
import AVFoundation
import SwiftUI
import UIKit

final class LiveCamera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "hannibal.camera")
    private let output = AVCaptureVideoDataOutput()
    private let ci = CIContext()
    private let lock = NSLock()
    private var latest: CGImage?
    private var lastGrab = Date.distantPast
    private(set) var front = false

    override init() {
        super.init()
        session.automaticallyConfiguresApplicationAudioSession = false
        session.sessionPreset = .high
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
    }

    static func askPermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    func start(front: Bool = false) throws {
        try configure(front: front)
        queue.async { if !self.session.isRunning { self.session.startRunning() } }
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
        lock.lock(); latest = nil; lock.unlock()
    }

    func flip() { try? configure(front: !front) }

    private func configure(front: Bool) throws {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: front ? .front : .back) else {
            throw NSError(domain: "Hannibal", code: 1, userInfo: [NSLocalizedDescriptionKey: "No camera found."])
        }
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        session.inputs.forEach { session.removeInput($0) }
        if session.canAddInput(input) { session.addInput(input) }
        if !session.outputs.contains(output), session.canAddOutput(output) { session.addOutput(output) }
        if let c = output.connection(with: .video) {
            if c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }   // portrait
            if front, c.isVideoMirroringSupported { c.isVideoMirrored = true }
        }
        session.commitConfiguration()
        self.front = front
        lock.lock(); latest = nil; lock.unlock()
    }

    // Keep ~4 frames a second; only the newest one matters.
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastGrab) > 0.25, let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastGrab = now
        let image = CIImage(cvPixelBuffer: px)
        guard let cg = ci.createCGImage(image, from: image.extent) else { return }
        lock.lock(); latest = cg; lock.unlock()
    }

    /// The newest frame as a JPEG for Hannibal's eyes, or nil if none yet.
    func snapshotJPEG() -> Data? {
        lock.lock(); let cg = latest; lock.unlock()
        guard let cg else { return nil }
        return UIImage(cgImage: cg).forHannibal()
    }
}

/// The small live preview shown during live talk.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.preview.session = session
        v.preview.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
