// ─────────────────────────────────────────────────────────────────────────
// PUSH — reminders, the morning brief and Yes/No questions reach the iPhone
// even when the app is closed. The server sends them through Apple (see
// server/apns.js) only while the app isn't open; when it is open they show
// up in the conversation as before.
// Yes on the lock screen needs Face ID (an action can't run unasked);
// No doesn't. Tapping the notification itself opens the app.
// ─────────────────────────────────────────────────────────────────────────
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    /// A notification tap can arrive before the screen (and the model) is up,
    /// e.g. when it cold-launches the app: keep it and show it once attached.
    weak var model: HannibalModel? {
        didSet {
            guard let model, !pending.isEmpty else { return }
            let queued = pending; pending = []
            Task { @MainActor in queued.forEach { $0(model) } }
        }
    }
    private var pending: [@MainActor (HannibalModel) -> Void] = []

    @MainActor private func withModel(_ work: @escaping @MainActor (HannibalModel) -> Void) {
        if let model { work(model) } else { pending.append(work) }
    }

    /// Puts a notification's content into the conversation (deduplicated
    /// against the live stream by text / confirm id).
    @MainActor private func show(_ content: UNNotificationContent) {
        let body = content.body
        if let id = content.userInfo["confirmId"] as? String {
            withModel { $0.showPushedConfirm(id: id, text: body) }
        } else {
            withModel { $0.showPushed(body) }
        }
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let yes = UNNotificationAction(identifier: "YES", title: "Yes, go ahead", options: [.authenticationRequired])
        let no = UNNotificationAction(identifier: "NO", title: "No", options: [.destructive])
        let confirm = UNNotificationCategory(identifier: "CONFIRM", actions: [yes, no], intentIdentifiers: [], options: [])
        center.setNotificationCategories([confirm])
        return true
    }

    /// Asks once for permission, then registers with Apple every launch
    /// (the token can change; the server keeps the newest).
    static func enable() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in self.model?.registerPush(token: hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in self.model?.add(.error, "Notifications couldn't be set up: \(error.localizedDescription)") }
    }

    // App open: put it in the conversation instead of a banner on top. Normally
    // the live stream already has it (deduplicated), but a push can slip in
    // while the stream is reconnecting.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { self.show(notification.request.content) }
        return []
    }

    // Yes / No from the lock screen, or a tap that opens the app.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let body = response.notification.request.content.body
        guard let id = info["confirmId"] as? String else {
            await MainActor.run { self.show(response.notification.request.content) }
            return
        }
        switch response.actionIdentifier {
        case "YES", "NO":
            let yes = response.actionIdentifier == "YES"
            if let model { await model.answerFromPush(id: id, summary: body, yes: yes) }
            else if let conn = ConnectionStore.load() {
                // Answered from the lock screen before the app's screen was up.
                _ = await HannibalAPI(conn: conn).confirm(id: id, yes: yes)
            }
        default: await MainActor.run { self.show(response.notification.request.content) }   // opened: ask in the app
        }
    }
}
