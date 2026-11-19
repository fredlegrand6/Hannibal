// face-follow — watches one camera and prints where people's faces are.
// Apple Vision does the detection; no extra libraries. One JSON line per
// processed frame on stdout:
//   {"t":1732012345.12,"faces":[{"x":0.41,"y":0.22,"w":0.12,"h":0.18}],"bodies":[...]}
// x/y/w/h are 0..1 of the picture, origin TOP-LEFT. Usage:
//   face-follow [camera-name-part] [fps]       (defaults: OBSBOT 6)
import Foundation
import AVFoundation
import Vision

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
let want = args.count > 1 ? args[1].lowercased() : "obsbot"
let fps = args.count > 2 ? (Double(args[2]) ?? 6) : 6

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let types: [AVCaptureDevice.DeviceType] = [.external, .builtInWideAngleCamera]
let found = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
guard let device = found.first(where: { $0.localizedName.lowercased().contains(want) }) ?? found.first else {
  err("no camera found"); exit(2)
}
err("camera: \(device.localizedName)")

final class Watcher: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var last = 0.0
  let gap: Double
  init(gap: Double) { self.gap = gap }
  func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
    let now = Date().timeIntervalSince1970
    if now - last < gap { return }
    last = now
    guard let px = CMSampleBufferGetImageBuffer(sb) else { return }
    let req = VNDetectFaceRectanglesRequest()
    // Bodies too: when Fred stands up his face leaves the top of the picture
    // first, but his body is still there to aim at.
    let bodyReq = VNDetectHumanRectanglesRequest()
    bodyReq.upperBodyOnly = false
    try? VNImageRequestHandler(cvPixelBuffer: px, options: [:]).perform([req, bodyReq])
    func box(_ b: CGRect) -> String {  // Vision: origin bottom-left → top-left
      String(format: "{\"x\":%.4f,\"y\":%.4f,\"w\":%.4f,\"h\":%.4f}", b.minX, 1 - b.maxY, b.width, b.height)
    }
    let faces = (req.results ?? []).map { box($0.boundingBox) }
    let bodies = (bodyReq.results ?? []).map { box($0.boundingBox) }
    print(String(format: "{\"t\":%.2f,\"faces\":[%@],\"bodies\":[%@]}", now, faces.joined(separator: ","), bodies.joined(separator: ",")))
  }
}

let session = AVCaptureSession()
do { session.addInput(try AVCaptureDeviceInput(device: device)) } catch { err("cannot open camera: \(error)"); exit(3) }
let out = AVCaptureVideoDataOutput()
out.alwaysDiscardsLateVideoFrames = true
let watcher = Watcher(gap: 1.0 / max(1, fps))
out.setSampleBufferDelegate(watcher, queue: DispatchQueue(label: "frames"))
session.addOutput(out)
session.startRunning()
// Stop when the parent goes away (stdin closes).
DispatchQueue.global().async { while readLine() != nil {}; session.stopRunning(); exit(0) }
RunLoop.main.run()
