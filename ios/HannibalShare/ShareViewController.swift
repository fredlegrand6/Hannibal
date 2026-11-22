// ─────────────────────────────────────────────────────────────────────────
// SHARE TO HANNIBAL — from any app (Safari, WhatsApp, Mail, Photos...):
// Share › Hannibal, pick what he should do (or type it), Send. Text and
// links go to /api/say, a photo to /api/look: same brain, tools, memory
// and Yes/No gate. His answer shows right in the sheet.
// ─────────────────────────────────────────────────────────────────────────
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(close: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) })
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load(from: extensionContext?.inputItems as? [NSExtensionItem] ?? []) }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    @Published var text = ""             // shared text or page title
    @Published var url: URL?
    @Published var image: UIImage?
    @Published var ask = ""
    @Published var reply: String?
    @Published var sending = false
    @Published var loading = true
    let close: () -> Void
    let conn = ConnectionStore.load()

    init(close: @escaping () -> Void) { self.close = close }

    func load(from items: [NSExtensionItem]) async {
        defer { loading = false }
        for item in items {
            if let t = item.attributedContentText?.string, !t.isEmpty, text.isEmpty { text = t }
            for p in item.attachments ?? [] {
                if image == nil, p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    let item = try? await p.loadItem(forTypeIdentifier: UTType.image.identifier)
                    if let img = item as? UIImage { image = img }
                    else if let d = item as? Data { image = UIImage(data: d) }
                    else if let u = item as? URL, let d = try? Data(contentsOf: u) { image = UIImage(data: d) }
                } else if url == nil, p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let u = try? await p.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL { url = u }
                } else if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let s = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String, !s.isEmpty {
                        if url == nil, let u = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme?.hasPrefix("http") == true { url = u }
                        else if text.isEmpty || text.count < s.count { text = s }
                    }
                }
            }
        }
    }

    var preview: String {
        [url?.absoluteString, text.isEmpty ? nil : text].compactMap { $0 }.joined(separator: "\n")
    }

    func send(_ instruction: String) {
        guard let conn, !sending else { return }
        let what = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        sending = true
        reply = nil
        let api = HannibalAPI(conn: conn)
        var message = (what.isEmpty ? "Have a look at this and tell me what matters." : what)
        message += "\n\n(Shared from my iPhone)"
        if let url { message += "\nLink: \(url.absoluteString)" }
        if !text.isEmpty { message += "\n\(String(text.prefix(6000)))" }
        let jpeg = image?.forHannibal()
        Task {
            defer { sending = false }
            do {
                let r: Reply
                if let jpeg { r = try await api.look(jpegBase64: jpeg.base64EncodedString(), text: message) }
                else { r = try await api.say(message) }
                reply = r.reply ?? "He didn't answer."
            } catch let e as APIError {
                reply = e.errorDescription
            } catch {
                reply = "I can't reach Hannibal. Is Tailscale on on this phone? (\(error.localizedDescription))"
            }
        }
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    @FocusState private var typing: Bool
    private let cyan = Color(red: 0.35, green: 0.85, blue: 1.0)
    private let quick = ["Summarise this", "Remind me about this tomorrow at 9", "Draft a reply", "Remember this", "What do you think?"]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if model.conn == nil {
                        Text("Open the Hannibal app once and paste his link first.").foregroundStyle(.orange)
                    }
                    if let img = model.image {
                        Image(uiImage: img).resizable().scaledToFit().frame(maxHeight: 180)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    if !model.preview.isEmpty {
                        Text(model.preview).font(.footnote).foregroundStyle(.secondary).lineLimit(5)
                            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                    }
                    if let reply = model.reply {
                        Text(reply).font(.body).textSelection(.enabled)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(cyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    } else if model.sending {
                        HStack { ProgressView(); Text("Hannibal is on it…").foregroundStyle(.secondary) }
                    } else {
                        Text("What should he do with it?").font(.headline)
                        ForEach(quick, id: \.self) { q in
                            Button { model.send(q) } label: {
                                Text(q).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10).padding(.horizontal, 12)
                                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                            }
                            .disabled(model.conn == nil || model.loading)
                        }
                        HStack {
                            TextField("Or tell him…", text: $model.ask, axis: .vertical).lineLimit(1...4).focused($typing)
                                .padding(10).background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
                                .submitLabel(.send).onSubmit { model.send(model.ask) }
                            Button { model.send(model.ask) } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 30)) }
                                .disabled(model.conn == nil || model.loading || model.ask.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle("Hannibal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(model.reply == nil ? "Cancel" : "Done") { model.close() } }
            }
            .tint(cyan)
        }
        .preferredColorScheme(.dark)
    }
}
