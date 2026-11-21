import AVFoundation
func t(_ name: String, _ f: () throws -> Void) { do { try f(); print("OK  ", name) } catch { print("FAIL", name, error.localizedDescription) } }
print("mic permission:", AVCaptureDevice.authorizationStatus(for: .audio).rawValue, "(3 = allowed, 2 = denied, 0 = never asked)")
t("output only") { let e = AVAudioEngine(); let p = AVAudioPlayerNode(); e.attach(p); e.connect(p, to: e.mainMixerNode, format: nil); try e.start(); e.stop() }
t("input tap, no voice processing") { let e = AVAudioEngine(); let i = e.inputNode; i.installTap(onBus: 0, bufferSize: 1024, format: nil) { _, _ in }; try e.start(); e.stop() }
t("voice processing, nothing else") { let e = AVAudioEngine(); try e.inputNode.setVoiceProcessingEnabled(true); _ = e.mainMixerNode; try e.start(); e.stop() }
t("voice processing + input tap") { let e = AVAudioEngine(); try e.inputNode.setVoiceProcessingEnabled(true); e.inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { _, _ in }; try e.start(); e.stop() }
t("voice processing on output node too") { let e = AVAudioEngine(); try e.outputNode.setVoiceProcessingEnabled(true); try e.inputNode.setVoiceProcessingEnabled(true); e.inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { _, _ in }; try e.start(); e.stop() }
