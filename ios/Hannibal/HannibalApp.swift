// Hannibal on iPhone — native app. Step 1: chat, hold-to-talk, his voice,
// Yes/No, camera and the orb, on the same server as the web phone app.
import SwiftUI

@main
struct HannibalApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = HannibalModel()

    init() { AudioSession.setUp() }

    var body: some Scene {
        WindowGroup {
            RootView().environment(model)
                .onAppear { appDelegate.model = model }
        }
    }
}
