// ─────────────────────────────────────────────────────────────────────────
// HANNIBAL API — the same server endpoints the web phone app uses
// (server/phone-app.js): /api/say, /api/voice, /api/look, /api/speak,
// /api/confirm, /api/voice-drop and the live /api/events stream.
// Same brain, tools, facts, memory and Yes/No gate as Telegram and the desk.
// ─────────────────────────────────────────────────────────────────────────
import Foundation

struct Reply: Decodable {
    var ok: Bool?
    var reply: String?
    var heard: String?
    var spoken: Bool?
}

/// What the home / lock screen widget shows (/api/glance).
struct Glance: Codable {
    struct Event: Codable, Hashable { var title: String; var ts: Double; var endTs: Double?; var allDay: Bool? }
    struct Reminder: Codable, Hashable { var message: String; var ts: Double }
    var ok: Bool?
    var events: [Event]
    var reminders: [Reminder]
    var waiting: Int?
}

/// A place reminder the phone watches (/api/places).
struct PlaceReminder: Codable, Hashable {
    var id: String
    var message: String
    var place: String
    var on: String          // "arrive" | "leave"
}
private struct PlaceList: Decodable { var reminders: [PlaceReminder] }

struct HannibalEvent: Decodable {
    var type: String
    var id: String?
    var summary: String?
    var text: String?
    var note: String?
    var ok: Bool?
    var url: String?          // notify / navigate: a Google Maps route
    var dest: String?
    var kind: String?         // ask: what the server wants to know ("eta")
    var destination: String?
}

enum APIError: LocalizedError {
    case unauthorized
    case status(Int)
    case badReply

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "The server didn't accept the link. Paste a fresh link from Hannibal on Telegram."
        case .status(let c): return "The server answered with error \(c)."
        case .badReply: return "The server's answer didn't make sense."
        }
    }
}

final class HannibalAPI {
    let conn: Connection
    private let session: URLSession
    private let streamSession: URLSession

    init(conn: Connection) {
        self.conn = conn
        let cfg = URLSessionConfiguration.default
        cfg.httpShouldSetCookies = false
        cfg.httpCookieAcceptPolicy = .never
        cfg.timeoutIntervalForRequest = 150       // a turn with tools can take a while
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg)

        let s = URLSessionConfiguration.default
        s.httpShouldSetCookies = false
        s.httpCookieAcceptPolicy = .never
        s.timeoutIntervalForRequest = 70          // server pings every 25 s; silence longer than this = reconnect
        s.timeoutIntervalForResource = 24 * 3600
        streamSession = URLSession(configuration: s)
    }

    private func request(_ path: String, method: String = "POST", contentType: String? = "application/json", body: Data? = nil, timeout: TimeInterval? = nil) -> URLRequest {
        var r = URLRequest(url: conn.base.appendingPathComponent(path))
        r.httpMethod = method
        r.httpShouldHandleCookies = false
        let key = conn.token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? conn.token
        r.setValue("hannibal_k=\(key)", forHTTPHeaderField: "Cookie")
        if let contentType { r.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let timeout { r.timeoutInterval = timeout }
        r.httpBody = body
        return r
    }

    private func reply(_ req: URLRequest) async throws -> Reply {
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        // 429/500 still carry a readable { reply } from Hannibal.
        if let r = try? JSONDecoder().decode(Reply.self, from: data) { return r }
        throw code >= 200 && code < 300 ? APIError.badReply : APIError.status(code)
    }

    private func jsonBody(_ obj: [String: Any]) -> Data? {
        try? JSONSerialization.data(withJSONObject: obj)
    }

    func say(_ text: String) async throws -> Reply {
        try await reply(request("api/say", body: jsonBody(["text": text])))
    }

    func voice(_ audio: Data, mime: String) async throws -> Reply {
        try await reply(request("api/voice", contentType: mime, body: audio))
    }

    /// Live talk with the camera on: the sentence and the current frame together.
    func voiceLook(_ audio: Data, mime: String, jpeg: Data) async throws -> Reply {
        try await reply(request("api/voice-look", body: jsonBody(["audio": audio.base64EncodedString(), "mime": mime, "image": jpeg.base64EncodedString()])))
    }

    func look(jpegBase64: String, text: String) async throws -> Reply {
        try await reply(request("api/look", body: jsonBody(["image": jpegBase64, "text": text])))
    }

    func speak(_ text: String) async throws -> Data {
        let (data, resp) = try await session.data(for: request("api/speak", body: jsonBody(["text": text]), timeout: 30))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        guard code == 200, !data.isEmpty else { throw APIError.status(code) }
        return data
    }

    enum ConfirmResult { case done, expired, unknown }

    /// .unknown = the answer may or may not have reached the server (network).
    func confirm(id: String, yes: Bool) async -> ConfirmResult {
        guard let result = try? await session.data(for: request("api/confirm", body: jsonBody(["id": id, "yes": yes]), timeout: 20)) else { return .unknown }
        switch (result.1 as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200: return .done
        case 410: return .expired
        default: return .unknown
        }
    }

    func glance() async throws -> Glance {
        let (data, resp) = try await session.data(for: request("api/glance", method: "GET", contentType: nil, timeout: 20))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        guard code == 200 else { throw APIError.status(code) }
        return try JSONDecoder().decode(Glance.self, from: data)
    }

    func places() async throws -> [PlaceReminder] {
        let (data, resp) = try await session.data(for: request("api/places", method: "GET", contentType: nil, timeout: 20))
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        guard code == 200 else { throw APIError.status(code) }
        return try JSONDecoder().decode(PlaceList.self, from: data).reminders
    }

    func placeFired(_ id: String) async -> Bool {
        guard let r = try? await session.data(for: request("api/places/fired", body: jsonBody(["id": id]), timeout: 20)) else { return false }
        return (r.1 as? HTTPURLResponse)?.statusCode == 200
    }

    /// A recorded meeting (m4a file). The server answers at once; the write-up comes later as a message.
    func meeting(file: URL, seconds: TimeInterval, started: Date) async throws -> String {
        var r = request("api/meeting", contentType: "audio/mp4", timeout: 600)
        r.setValue(String(Int(seconds)), forHTTPHeaderField: "X-Meeting-Seconds")
        r.setValue(String(Int(started.timeIntervalSince1970 * 1000)), forHTTPHeaderField: "X-Meeting-Started")
        let (data, resp) = try await session.upload(for: r, fromFile: file)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        guard code == 202 || code == 200 else { throw APIError.status(code) }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["note"] as? String ?? "Got it."
    }

    /// The phone's answer to a server question (drive time…).
    func answer(_ reply: [String: Any]) async {
        _ = try? await session.data(for: request("api/answer", body: jsonBody(reply), timeout: 20))
    }

    func placeFailed(_ id: String, error: String) async {
        _ = try? await session.data(for: request("api/places/failed", body: jsonBody(["id": id, "error": error]), timeout: 20))
    }

    func registerPush(token: String) async {
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        _ = try? await session.data(for: request("api/push-token", body: jsonBody(["token": token, "env": env]), timeout: 20))
    }

    func voiceDrop(stage: String, error: String, recovered: Bool = false) {
        let req = request("api/voice-drop", body: jsonBody(["stage": stage, "error": String(error.prefix(200)), "device": "iPhone app", "recovered": recovered]), timeout: 10)
        Task { _ = try? await session.data(for: req) }
    }

    /// Reads the live event stream until it ends or fails. Reminders, the
    /// morning brief and Yes/No questions arrive here while the app is open.
    func listen(_ onEvent: @escaping @MainActor (HannibalEvent) -> Void) async throws {
        var req = request("api/events", method: "GET", contentType: nil)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("ios", forHTTPHeaderField: "X-Hannibal-Client")   // can open routes / answer drive times
        let (bytes, resp) = try await streamSession.bytes(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 || code == 403 { throw APIError.unauthorized }
        guard code == 200 else { throw APIError.status(code) }
        let decoder = JSONDecoder()
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let d = payload.data(using: .utf8), let ev = try? decoder.decode(HannibalEvent.self, from: d) else { continue }
            await onEvent(ev)
        }
    }
}
