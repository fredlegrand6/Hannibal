// ─────────────────────────────────────────────────────────────────────────
// SCREENS — first-time setup (paste the link) and the conversation:
// the orb on top, the conversation below, and at the bottom the camera,
// a text box and the mic (hold to talk, slide up to cancel).
// Tap the orb to stop him talking.
// ─────────────────────────────────────────────────────────────────────────
import SwiftUI
import PhotosUI

enum Palette {
    static let bg = Color(red: 0.02, green: 0.027, blue: 0.047)          // #05070c
    static let cyan = Color(red: 0.208, green: 0.816, blue: 1.0)         // #35d0ff
    static let gold = Color(red: 0.95, green: 0.75, blue: 0.3)
    static let card = Color(red: 0.055, green: 0.10, blue: 0.165)
    static let me = Color(red: 0.10, green: 0.23, blue: 0.33)
    static let him = Color(red: 0.09, green: 0.11, blue: 0.15)
}

struct RootView: View {
    @Environment(HannibalModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.connection == nil { SetupView() } else { ChatView() }
        }
        .preferredColorScheme(.dark)
        .onChange(of: scenePhase) { _, phase in
            // The live stream only runs while the app is on screen (iOS pauses it anyway).
            // Live talk keeps going with the screen locked; everything else pauses.
            if phase == .active { model.startEvents() } else if phase == .background {
                model.stopRecording(send: false)
                model.appWentToBackground()
                if !model.live { model.stopEvents() }
            }
        }
    }
}

struct SetupView: View {
    @Environment(HannibalModel.self) private var model
    @State private var link = ""
    @State private var error: String?

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                Spacer()
                Text("Hannibal").font(.system(size: 40, weight: .bold)).foregroundStyle(Palette.cyan)
                Text("Paste the link Hannibal sent you on Telegram for the phone app (the long one with ?k= in it). You only do this once.")
                    .foregroundStyle(.secondary)
                TextField("https://…ts.net:8443/?k=…", text: $link, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .padding(12)
                    .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                HStack {
                    Button("Paste") { link = UIPasteboard.general.string ?? link }
                        .buttonStyle(.bordered)
                    Spacer()
                    Button("Connect") {
                        if model.connect(link: link) { error = nil } else { error = "That doesn't look like Hannibal's link. It starts with https:// and has ?k= in it." }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Palette.cyan)
                    .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let error { Text(error).foregroundStyle(.red).font(.callout) }
                Text("Tailscale needs to be on on this iPhone, same as for the web app.").font(.footnote).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(24)
        }
    }
}

struct ChatView: View {
    @Environment(HannibalModel.self) private var model
    @State private var draft = ""
    @FocusState private var typing: Bool
    @State private var showCamera = false
    @State private var showLibrary = false
    @State private var pickedItem: PhotosPickerItem?

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                header
                orb
                conversation
                inputBar
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in model.sendPhoto(image, caption: draft); draft = "" }
                .ignoresSafeArea()
        }
        .photosPicker(isPresented: $showLibrary, selection: $pickedItem, matching: .images)
        .onChange(of: pickedItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                    model.sendPhoto(img, caption: draft); draft = ""
                }
                pickedItem = nil
            }
        }
        .onAppear {
            model.startEvents()
            AppDelegate.enable()            // notifications for when the app is closed
        }
    }

    private var header: some View {
        HStack {
            Circle().fill(model.online ? Color.green : Color.orange).frame(width: 8, height: 8)
            Text(model.online ? "Hannibal" : "Connecting…").font(.headline)
            Spacer()
            Button { model.toggleCamera() } label: {
                Image(systemName: model.cameraOn ? "video.fill" : "video")
                    .font(.system(size: 19))
            }
            .accessibilityLabel(model.cameraOn ? "Turn the live camera off" : "Live talk with the camera")
            Button { model.toggleLive() } label: {
                Image(systemName: model.live ? "waveform.circle.fill" : "waveform.circle")
                    .font(.system(size: 22))
            }
            .accessibilityLabel(model.live ? "Stop live talk" : "Start live talk")
            Button { model.voiceAlways.toggle() } label: {
                Image(systemName: model.voiceAlways ? "speaker.wave.2.fill" : "speaker.slash")
            }
            .accessibilityLabel(model.voiceAlways ? "Read every answer aloud" : "Only speak when I talk")
            Menu {
                Button("Clear conversation", role: .destructive) { model.clearChat() }
                Button("Change server link") { model.forgetLink() }
            } label: { Image(systemName: "ellipsis.circle") }
        }
        .foregroundStyle(Palette.cyan)
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private var orb: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .bottomTrailing) {
                if model.cameraOn {
                    // Live camera: he sees this when you finish a sentence. Tap to flip.
                    CameraPreview(session: model.camera.session)
                        .clipShape(RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).stroke(model.orbState == "looking" ? Palette.gold : Palette.cyan.opacity(0.6), lineWidth: 2))
                        .padding(.horizontal, 16)
                        .onTapGesture { model.camera.flip() }
                    OrbView(state: model.orbState, level: model.level, pulses: model.pulses)
                        .frame(width: 90, height: 90)
                        .padding(.trailing, 22).padding(.bottom, 6)
                        .allowsHitTesting(false)
                } else {
                    OrbView(state: model.orbState, level: model.level, pulses: model.pulses)
                }
            }
                .frame(height: typing ? 120 : (model.cameraOn ? 330 : 250))
                .contentShape(Rectangle())
                .onTapGesture {
                    // Tap while he talks = stop him; otherwise live talk on/off.
                    if model.speaking { model.stopSpeaking() } else { model.toggleLive() }
                }
                .animation(.easeInOut(duration: 0.25), value: typing)
            Text(model.phase)
                .font(.caption.weight(.semibold))
                .foregroundStyle(model.orbState == "confirm" ? Palette.gold : Palette.cyan.opacity(0.8))
        }
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(model.lines) { line in LineView(line: line).id(line.id) }
                    if model.waiting > 0 && !model.recording {
                        Text("…").foregroundStyle(.secondary).id("thinking")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.lines.count) { _, _ in
                if let id = model.lines.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
            }
            .onAppear { if let id = model.lines.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
        }
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            Menu {
                Button { showCamera = true } label: { Label("Take a photo", systemImage: "camera") }
                Button { showLibrary = true } label: { Label("Choose a photo", systemImage: "photo") }
            } label: {
                Image(systemName: "camera.fill").font(.system(size: 18)).frame(width: 40, height: 40)
                    .background(Palette.card, in: Circle())
            }
            TextField(model.recording ? "Listening… slide up to cancel" : (model.live ? "Live talk on, or type" : "Talk to Hannibal"), text: $draft, axis: .vertical)
                .lineLimit(1...4)
                .focused($typing)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
                .submitLabel(.send)
                .onSubmit(sendDraft)
            if model.live && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button { model.stopLive() } label: {
                    Image(systemName: "stop.fill").font(.system(size: 18, weight: .bold)).foregroundStyle(.black)
                        .frame(width: 44, height: 44).background(Color.red, in: Circle())
                }
                .accessibilityLabel("Stop live talk")
            } else if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MicButton()
            } else {
                Button(action: sendDraft) {
                    Image(systemName: "arrow.up").font(.system(size: 18, weight: .bold)).foregroundStyle(.black)
                        .frame(width: 44, height: 44).background(Palette.cyan, in: Circle())
                }
            }
        }
        .foregroundStyle(Palette.cyan)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func sendDraft() {
        let t = draft
        draft = ""
        model.send(t)
    }
}

struct MicButton: View {
    @Environment(HannibalModel.self) private var model
    @State private var pressing = false
    @State private var cancelling = false

    var body: some View {
        Image(systemName: cancelling ? "xmark" : "mic.fill")
            .font(.system(size: 20, weight: .bold))
            .foregroundStyle(.black)
            .frame(width: 44, height: 44)
            .background(model.recording ? (cancelling ? Color.gray : Color.red) : Palette.cyan, in: Circle())
            .scaleEffect(pressing ? 1.25 : 1)
            .animation(.spring(duration: 0.2), value: pressing)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        if !pressing { pressing = true; model.startRecording() }
                        cancelling = v.translation.height < -70
                    }
                    .onEnded { v in
                        pressing = false
                        let cancel = v.translation.height < -70
                        cancelling = false
                        model.stopRecording(send: !cancel)
                    }
            )
            .accessibilityLabel("Hold to talk")
    }
}

struct LineView: View {
    @Environment(HannibalModel.self) private var model
    let line: Line

    var body: some View {
        switch line.kind {
        case .me:
            HStack { Spacer(minLength: 40); bubble(Palette.me) }
        case .him:
            HStack { bubble(Palette.him); Spacer(minLength: 40) }
        case .note:
            Text(line.text).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity)
        case .error:
            Text(line.text).font(.callout).foregroundStyle(Color.orange)
        case .notify:
            VStack(alignment: .leading, spacing: 10) {
                Text(line.text).textSelection(.enabled)
                if let url = line.url {
                    Button { Nav.open(url) } label: { Label("Start route", systemImage: "car.fill").bold().frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).tint(Palette.cyan).controlSize(.large)
                }
            }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.cyan.opacity(0.35)))
        case .confirm:
            VStack(alignment: .leading, spacing: 10) {
                Text(line.text)
                Text("Shall I go ahead?").fontWeight(.semibold)
                if let outcome = line.outcome {
                    Text(outcome).font(.callout).foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 10) {
                        Button { model.answer(line, yes: true) } label: { Text("Yes").bold().frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).tint(Palette.gold)
                        Button { model.answer(line, yes: false) } label: { Text("No").bold().frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered).tint(.white)
                    }
                    .controlSize(.large)
                    .disabled(line.sending)
                }
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(red: 0.10, green: 0.08, blue: 0.03), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.gold.opacity(0.5)))
        }
    }

    private func bubble(_ color: Color) -> some View {
        Text(line.text).textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(color, in: RoundedRectangle(cornerRadius: 16))
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let p = UIImagePickerController()
        p.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        p.delegate = context.coordinator
        return p
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let img = info[.originalImage] as? UIImage { parent.onImage(img) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
