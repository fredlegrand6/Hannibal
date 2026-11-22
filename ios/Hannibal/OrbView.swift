// ─────────────────────────────────────────────────────────────────────────
// ORB — the same living brain as the web phone app (server/phone/orb.js),
// drawn in a small transparent web view so it looks identical.
// ios/Hannibal/orb.js is a copy of server/phone/orb.js; the iOS build check
// fails if the two drift apart. Purely visual: if it can't draw, the app
// works the same.
// ─────────────────────────────────────────────────────────────────────────
import SwiftUI
import WebKit

struct OrbView: UIViewRepresentable {
    var state: String
    var level: Float
    var pulses: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.suppressesIncrementalRendering = true
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false
        web.isUserInteractionEnabled = false
        web.navigationDelegate = context.coordinator
        web.loadHTMLString(Self.html, baseURL: nil)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let c = context.coordinator
        c.web = web
        if c.state != state { c.state = state; c.run("orb.setState('\(state)')") }
        // While talking the mic level drives it; otherwise it moves on its own.
        let rounded = (level * 20).rounded() / 20
        if state == "listening", c.level != rounded { c.level = rounded; c.run("orb.setAmplitude(\(rounded))") }
        if c.pulses != pulses { c.pulses = pulses; c.run("orb.pulse(50)") }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var web: WKWebView?
        var ready = false
        var state = ""
        var level: Float = -1
        var pulses = 0
        private var pending: [String] = []

        func run(_ js: String) {
            guard ready, let web else { pending.append(js); return }
            web.evaluateJavaScript("try{\(js)}catch(e){}", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            web = webView
            let queued = pending
            pending.removeAll()
            queued.forEach(run)
        }
    }

    private static let html: String = {
        let js = Bundle.main.url(forResource: "orb", withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
        <style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
        </head><body><canvas id="orb"></canvas>
        <script>\(js)</script>
        <script>var orb={setState(){},setAmplitude(){},pulse(){}};try{if(window.initOrb)orb=window.initOrb(document.getElementById('orb'))}catch(e){}</script>
        </body></html>
        """
    }()
}
