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
    weak var model: HannibalModel?

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

    // While the app is open the conversation already shows it: no banner on top.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        []
    }

    // Yes / No from the lock screen, or a tap that opens the app.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let body = response.notification.request.content.body
        guard let id = info["confirmId"] as? String else {
            await MainActor.run { self.model?.showPushed(body) }
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
        default: await MainActor.run { self.model?.showPushedConfirm(id: id, text: body) }   // opened: ask in the app
        }
    }
}
