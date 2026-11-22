// Hannibal's HANDS — keyboard, mouse, accessibility and on-screen text (OCR).
//
// A small long-running helper. electron/services/computer-control.js starts it
// and talks to it with one JSON object per line on stdin; every answer is one
// JSON line on stdout ({ id, ... }). Events it sends by itself: {"ev":"esc"}
// (Fred pressed Esc; three quick ones = stop) and {"ev":"ready"}.
//
// Coordinates are macOS GLOBAL POINTS: origin at the top-left of the main
// display, y grows downwards, other displays can sit at negative x or y. That is
// what CGEvent, the accessibility API and Electron's screen module all use, so
// no flipping is needed anywhere except Vision's boxes (handled in node).
//
// Needs Accessibility permission (System Settings → Privacy & Security →
// Accessibility) for the app that starts it (Hannibal's Electron). Without it,
// posting events silently does nothing and AX calls fail: "trusted" says so.
//
//   build:  swiftc -O Hands.swift -o hands   (done once by computer-control.js)

import Foundation
import AppKit
import ApplicationServices
import Vision

// Every event we post carries this tag so the Esc watcher never counts
// Hannibal's own key presses as Fred's.
let HANNIBAL_TAG: Int64 = 0x48414E4E   // "HANN"

let out = FileHandle.standardOutput
let outLock = NSLock()
func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
    outLock.lock(); out.write(data); out.write("\n".data(using: .utf8)!); outLock.unlock()
}

let source = CGEventSource(stateID: .hidSystemState)

func tag(_ e: CGEvent) { e.setIntegerValueField(.eventSourceUserData, value: HANNIBAL_TAG) }

// ── mouse ───────────────────────────────────────────────────────────────────
func moveMouse(_ p: CGPoint) {
    if let e = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left) { tag(e); e.post(tap: .cghidEventTap) }
}

func click(_ p: CGPoint, button: String, count: Int) {
    let (down, up, btn): (CGEventType, CGEventType, CGMouseButton) =
        button == "right" ? (.rightMouseDown, .rightMouseUp, .right)
        : button == "middle" ? (.otherMouseDown, .otherMouseUp, .center)
        : (.leftMouseDown, .leftMouseUp, .left)
    moveMouse(p)
    usleep(40_000)
    for i in 1...max(1, count) {
        guard let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: p, mouseButton: btn),
              let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: p, mouseButton: btn) else { continue }
        d.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        u.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        tag(d); tag(u)
        d.post(tap: .cghidEventTap); usleep(25_000); u.post(tap: .cghidEventTap)
        if i < count { usleep(60_000) }
    }
}

func scroll(dx: Int32, dy: Int32) {
    if let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) { tag(e); e.post(tap: .cghidEventTap) }
}

// ── keyboard ────────────────────────────────────────────────────────────────
func flags(_ mods: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in mods {
        switch m {
        case "cmd": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt": f.insert(.maskAlternate)
        case "ctrl": f.insert(.maskControl)
        case "fn": f.insert(.maskSecondaryFn)
        default: break
        }
    }
    return f
}

func key(code: Int, mods: [String]) {
    let f = flags(mods)
    guard let d = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: true),
          let u = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: false) else { return }
    d.flags = f; u.flags = f
    tag(d); tag(u)
    d.post(tap: .cghidEventTap); usleep(20_000); u.post(tap: .cghidEventTap)
}

func typeText(_ text: String) {
    // Unicode typing in small chunks (apps drop long single events).
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {
        if stopTyping { break }
        let chunk = Array(units[i..<min(i + 16, units.count)])
        guard let d = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let u = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { break }
        chunk.withUnsafeBufferPointer { buf in
            d.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buf.baseAddress)
            u.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: buf.baseAddress)
        }
        d.flags = []; u.flags = []
        tag(d); tag(u)
        d.post(tap: .cghidEventTap); usleep(8_000); u.post(tap: .cghidEventTap)
        usleep(12_000)
        i += 16
    }
}
var stopTyping = false

// ── accessibility ───────────────────────────────────────────────────────────
func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String {
    if let s = attr(el, name) as? String { return s }
    return ""
}
func frame(_ el: AXUIElement) -> [String: Double]? {
    guard let pv = attr(el, kAXPositionAttribute), let sv = attr(el, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return ["x": Double(p.x), "y": Double(p.y), "w": Double(s.width), "h": Double(s.height)]
}
func describe(_ el: AXUIElement, withValue: Bool = true) -> [String: Any] {
    let role = str(el, kAXRoleAttribute)
    let subrole = str(el, kAXSubroleAttribute)
    var d: [String: Any] = [
        "role": role, "subrole": subrole,
        "title": str(el, kAXTitleAttribute),
        "description": str(el, kAXDescriptionAttribute),
        "help": str(el, kAXHelpAttribute),
        "placeholder": str(el, kAXPlaceholderValueAttribute),
    ]
    let secure = subrole == "AXSecureTextField"
    d["secure"] = secure
    if withValue && !secure {
        if let v = attr(el, kAXValueAttribute) as? String { d["value"] = String(v.prefix(4000)) }
    }
    if let f = frame(el) { d["frame"] = f }
    var pid: pid_t = 0
    if AXUIElementGetPid(el, &pid) == .success {
        d["pid"] = Int(pid)
        if let app = NSRunningApplication(processIdentifier: pid) {
            d["app"] = app.localizedName ?? ""
            d["bundle"] = app.bundleIdentifier ?? ""
        }
    }
    return d
}

func elementAt(_ p: CGPoint) -> [String: Any] {
    let sys = AXUIElementCreateSystemWide()
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, Float(p.x), Float(p.y), &el) == .success, let e = el else { return ["found": false] }
    var d = describe(e, withValue: false)
    // A label often sits on the parent (a button's text child): take the nearest named ancestor too.
    var cur: AXUIElement? = e
    var hops = 0
    while let c = cur, hops < 4 {
        let r = str(c, kAXRoleAttribute)
        if ["AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton"].contains(r) {
            d["control"] = describe(c, withValue: false)
            break
        }
        cur = attr(c, kAXParentAttribute).map { $0 as! AXUIElement }
        hops += 1
    }
    d["found"] = true
    return d
}

func frontApp() -> [String: Any] {
    guard let a = NSWorkspace.shared.frontmostApplication else { return [:] }
    return ["app": a.localizedName ?? "", "bundle": a.bundleIdentifier ?? "", "pid": Int(a.processIdentifier)]
}

func focused() -> [String: Any] {
    var d: [String: Any] = frontApp()
    guard let pidv = d["pid"] as? Int else { return d }
    let app = AXUIElementCreateApplication(pid_t(pidv))
    if let f = attr(app, kAXFocusedUIElementAttribute) {
        d["element"] = describe(f as! AXUIElement)
    }
    if let w = attr(app, kAXFocusedWindowAttribute) {
        d["window"] = str(w as! AXUIElement, kAXTitleAttribute)
        if let f = frame(w as! AXUIElement) { d["windowFrame"] = f }
    }
    return d
}

// Electron / Chromium apps only build their web accessibility tree when asked.
func wakeAccessibility(_ pid: pid_t) {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

// Walk one app's windows (breadth first, capped) and return the elements whose
// label or value matches `needle` (case-insensitive), plus — for "dump" — every
// labelled control, so node can inspect a whole window.
func walk(pid: pid_t, needle: String?, roles: Set<String>?, maxNodes: Int, deadline: Date) -> [[String: Any]] {
    wakeAccessibility(pid)
    let app = AXUIElementCreateApplication(pid)
    var queue: [AXUIElement] = []
    if let ws = attr(app, kAXWindowsAttribute) as? [AXUIElement] { queue.append(contentsOf: ws) }
    if let mb = attr(app, kAXMenuBarAttribute) { if needle != nil { queue.append(mb as! AXUIElement) } }
    var found: [[String: Any]] = []
    var seen = 0
    let n = needle?.lowercased()
    while !queue.isEmpty && seen < maxNodes && Date() < deadline {
        let el = queue.removeFirst()
        seen += 1
        let role = str(el, kAXRoleAttribute)
        let labels = [str(el, kAXTitleAttribute), str(el, kAXDescriptionAttribute), str(el, kAXHelpAttribute),
                      str(el, kAXPlaceholderValueAttribute), (role == "AXStaticText" || role == "AXButton" || role == "AXLink") ? ((attr(el, kAXValueAttribute) as? String) ?? "") : ""]
        let roleOk = roles == nil || roles!.contains(role)
        if roleOk {
            if let n = n {
                if labels.contains(where: { !$0.isEmpty && $0.lowercased().contains(n) }) {
                    var d = describe(el)
                    d["depthIndex"] = seen
                    found.append(d)
                }
            } else if labels.contains(where: { !$0.isEmpty }) || role == "AXTextArea" || role == "AXTextField" {
                found.append(describe(el))
            }
        }
        if let kids = attr(el, kAXChildrenAttribute) as? [AXUIElement] { queue.append(contentsOf: kids) }
    }
    return found
}

func setFocus(pid: pid_t, x: Double, y: Double) -> Bool {
    let sys = AXUIElementCreateSystemWide()
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(sys, Float(x), Float(y), &el) == .success, let e = el else { return false }
    return AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
}

func raiseWindow(pid: pid_t, title: String) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    guard let ws = attr(app, kAXWindowsAttribute) as? [AXUIElement] else { return false }
    for w in ws where title.isEmpty || str(w, kAXTitleAttribute).lowercased().contains(title.lowercased()) {
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        NSRunningApplication(processIdentifier: pid)?.activate(options: [])
        return true
    }
    return false
}

// ── OCR (macOS Vision, on-device) ───────────────────────────────────────────
// Boxes come back normalised 0..1 with a TOP-LEFT origin (flipped here).
func ocr(path: String, fast: Bool) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return ["error": "cannot load image"] }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = fast ? .fast : .accurate
    req.usesLanguageCorrection = !fast
    req.recognitionLanguages = ["en-US", "nl-NL", "fr-FR", "es-ES"]
    do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) }
    catch { return ["error": "ocr failed: \(error.localizedDescription)"] }
    var lines: [[String: Any]] = []
    for obs in req.results ?? [] {
        guard let best = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append(["text": best.string, "conf": Double(best.confidence),
                      "x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)])
    }
    return ["lines": lines, "width": cg.width, "height": cg.height]
}

// ── Esc watcher (listen-only event tap) ─────────────────────────────────────
var escTap: CFMachPort?
func startEscWatch() -> Bool {
    if escTap != nil { return true }
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    let cb: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = escTap { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode) == 53
            && event.getIntegerValueField(.eventSourceUserData) != HANNIBAL_TAG
            && event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
            send(["ev": "esc", "t": Date().timeIntervalSince1970 * 1000])
        }
        return Unmanaged.passUnretained(event)
    }
    guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                    eventsOfInterest: mask, callback: cb, userInfo: nil) else { return false }
    escTap = t
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    return true
}

// ── command loop ────────────────────────────────────────────────────────────
func num(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? Double(v as? String ?? "") ?? 0 }

func handle(_ j: [String: Any]) -> [String: Any] {
    let cmd = j["cmd"] as? String ?? ""
    switch cmd {
    case "trusted":
        let prompt = (j["prompt"] as? Bool) ?? false
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
        return ["trusted": AXIsProcessTrustedWithOptions(opts)]
    case "move":
        moveMouse(CGPoint(x: num(j["x"]), y: num(j["y"]))); return ["ok": true]
    case "click":
        click(CGPoint(x: num(j["x"]), y: num(j["y"])), button: j["button"] as? String ?? "left", count: Int(num(j["count"])) )
        return ["ok": true]
    case "mouse":
        return ["ok": true, "x": Double(CGEvent(source: nil)?.location.x ?? 0), "y": Double(CGEvent(source: nil)?.location.y ?? 0)]
    case "scroll":
        scroll(dx: Int32(num(j["dx"])), dy: Int32(num(j["dy"]))); return ["ok": true]
    case "key":
        key(code: Int(num(j["code"])), mods: j["mods"] as? [String] ?? []); return ["ok": true]
    case "type":
        stopTyping = false
        typeText(j["text"] as? String ?? ""); return ["ok": !stopTyping, "stopped": stopTyping]
    case "stopTyping":
        stopTyping = true; return ["ok": true]
    case "axAt":
        return elementAt(CGPoint(x: num(j["x"]), y: num(j["y"])))
    case "focused":
        return focused()
    case "front":
        return frontApp()
    case "find", "dump":
        var pid = pid_t(num(j["pid"]))
        if pid == 0, let p = frontApp()["pid"] as? Int { pid = pid_t(p) }
        let roles = (j["roles"] as? [String]).map { Set($0) }
        let res = walk(pid: pid, needle: cmd == "find" ? (j["text"] as? String ?? "") : nil, roles: roles,
                       maxNodes: Int(num(j["max"]) > 0 ? num(j["max"]) : 6000),
                       deadline: Date().addingTimeInterval(num(j["ms"]) > 0 ? num(j["ms"]) / 1000 : 2.5))
        return ["ok": true, "items": res]
    case "focusAt":
        return ["ok": setFocus(pid: pid_t(num(j["pid"])), x: num(j["x"]), y: num(j["y"]))]
    case "raise":
        return ["ok": raiseWindow(pid: pid_t(num(j["pid"])), title: j["title"] as? String ?? "")]
    case "ocr":
        return ocr(path: j["path"] as? String ?? "", fast: (j["fast"] as? Bool) ?? false)
    case "watchEsc":
        return ["ok": startEscWatch()]
    default:
        return ["error": "unknown cmd \(cmd)"]
    }
}

// stdin reader on a background queue; the main run loop serves the event tap.
// Commands run one at a time in order, except stopTyping, which must cut in.
let work = DispatchQueue(label: "hands.work")
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        let id = j["id"] ?? NSNull()
        if (j["cmd"] as? String) == "stopTyping" { stopTyping = true; send(["id": id, "ok": true]); continue }
        if (j["cmd"] as? String) == "quit" { exit(0) }
        work.async {
            var r = handle(j)
            r["id"] = id
            send(r)
        }
    }
    exit(0)
}
send(["ev": "ready"])
CFRunLoopRun()
