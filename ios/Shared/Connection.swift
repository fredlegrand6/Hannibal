// ─────────────────────────────────────────────────────────────────────────
// CONNECTION — where Hannibal's server is and the private key for it.
//
// Fred pastes the same link Hannibal sends on Telegram for the web phone app
// (https://<server>.ts.net:8443/?k=<key>). The app keeps it in the iPhone's
// Keychain (never in plain settings) and sends the key the same way the web
// app's cookie does, so the server needs no change for the native app.
// Tailscale must be on on the phone, exactly as for the web app.
// ─────────────────────────────────────────────────────────────────────────
import Foundation
import Security

struct Connection: Equatable {
    let base: URL
    let token: String

    static func parse(_ raw: String) -> Connection? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: s),
              let scheme = comps.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = comps.host, !host.isEmpty,
              let key = comps.queryItems?.first(where: { $0.name == "k" })?.value,
              key.count >= 16 else { return nil }
        var b = URLComponents()
        b.scheme = scheme
        b.host = host
        b.port = comps.port
        guard let base = b.url else { return nil }
        return Connection(base: base, token: key)
    }

    var hostLabel: String { base.host ?? base.absoluteString }
}

enum ConnectionStore {
    private static let service = "hannibal.phone"
    private static let account = "link"
    /// Shared with the share sheet and the widgets (keychain-access-groups).
    static let sharedGroup = "X4GXK2YQW8.com.revalisgroup.hannibal.shared"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func load() -> Connection? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let link = String(data: data, encoding: .utf8) else { return nil }
        return Connection.parse(link)
    }

    @discardableResult
    static func save(_ link: String) -> Bool {
        delete()
        var q = query
        q[kSecAttrAccessGroup as String] = sharedGroup
        q[kSecValueData as String] = Data(link.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }

    /// Links saved before the share sheet existed sit in the app's own
    /// keychain group; move them to the shared one so extensions can read it.
    static func moveToSharedGroup() {
        var check = query
        check[kSecAttrAccessGroup as String] = sharedGroup
        check[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(check as CFDictionary, nil) == errSecItemNotFound, let c = load() else { return }
        var b = URLComponents(url: c.base, resolvingAgainstBaseURL: false)
        b?.queryItems = [URLQueryItem(name: "k", value: c.token)]
        if let link = b?.url?.absoluteString { save(link) }
    }
}
