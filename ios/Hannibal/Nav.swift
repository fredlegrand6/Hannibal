// ─────────────────────────────────────────────────────────────────────────
// NAVIGATION — Hannibal + Google Maps (server/nav.js).
//   • "take me to …": the server sends a route; on screen it opens Google
//     Maps right away, otherwise a notification whose tap starts the route.
//   • "how long to …": the server asks the phone, which works out the drive
//     time from where it is with live traffic (Apple Maps routing, free) and
//     answers (/api/answer). Works with the app open, or woken by a silent push.
// ─────────────────────────────────────────────────────────────────────────
import CoreLocation
import MapKit
import UIKit
import UserNotifications

@MainActor
enum Nav {
    /// Open the route now if Hannibal is on screen, else post a tap-to-start notification.
    static func start(url: String, text: String) {
        guard let u = URL(string: url) else { return }
        if UIApplication.shared.applicationState == .active {
            UIApplication.shared.open(u)
        } else {
            let content = UNMutableNotificationContent()
            content.title = "🚗 Hannibal"
            content.body = text
            content.sound = .default
            content.userInfo = ["navigate": url]
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "nav-\(UUID().uuidString)", content: content, trigger: nil))
        }
    }

    /// Opens a Google Maps link (notification tap, "Start route" button).
    static func open(_ url: String) {
        if let u = URL(string: url) { UIApplication.shared.open(u) }
    }

    /// Answers a question from the server (`kind` "eta") and posts it back.
    static func answer(_ q: [String: Any]) async {
        guard let id = q["id"] as? String, let conn = ConnectionStore.load() else { return }
        var reply: [String: Any] = ["id": id]
        switch q["kind"] as? String {
        case "eta":
            let dest = (q["destination"] as? String) ?? ""
            reply.merge(await eta(to: dest)) { $1 }
        case "here":
            reply.merge(await here()) { $1 }
        default:
            reply["ok"] = false
            reply["error"] = "The iPhone app doesn't know that question yet (update the app)."
        }
        await HannibalAPI(conn: conn).answer(reply)
    }

    /// Drive time by car from here, with traffic.
    static func eta(to dest: String) async -> [String: Any] {
        guard !dest.isEmpty else { return ["ok": false, "error": "No destination."] }
        let status = CLLocationManager().authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else {
            if status == .notDetermined, UIApplication.shared.applicationState == .active {
                PlaceWatcher.shared.askAlways()
                return ["ok": false, "error": "The iPhone is asking Fred for location access now. Once he allows it (Always), ask again."]
            }
            return ["ok": false, "error": "Hannibal has no location access on the iPhone (Settings › Hannibal › Location)."]
        }
        guard let item = await find(dest) else {
            return ["ok": false, "error": "The iPhone couldn't find \"\(dest)\" on the map."]
        }
        let req = MKDirections.Request()
        req.source = MKMapItem.forCurrentLocation()
        req.destination = item
        req.transportType = .automobile
        req.departureDate = Date()
        do {
            let r = try await MKDirections(request: req).calculateETA()
            return ["ok": true, "minutes": r.expectedTravelTime / 60, "km": r.distance / 1000, "place": item.name ?? dest]
        } catch {
            return ["ok": false, "error": "No route by car to \(item.name ?? dest): \(error.localizedDescription)"]
        }
    }

    /// Where the phone is now, with the street (photo memory: "remember where I parked").
    static func here() async -> [String: Any] {
        let m = CLLocationManager()
        let status = m.authorizationStatus
        guard status == .authorizedAlways || status == .authorizedWhenInUse else {
            return ["ok": false, "error": "Hannibal has no location access on the iPhone."]
        }
        // A fresh fix if the cached one is old or rough (≤ 8 s).
        var loc = m.location
        if loc == nil || loc!.timestamp.timeIntervalSinceNow < -60 || loc!.horizontalAccuracy > 50 {
            if let fresh = await OneFix().get(timeout: 8) { loc = fresh }
        }
        guard let loc else { return ["ok": false, "error": "The iPhone couldn't get its location."] }
        var out: [String: Any] = ["ok": true, "lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude, "accuracy": loc.horizontalAccuracy]
        if let p = try? await CLGeocoder().reverseGeocodeLocation(loc).first {
            out["address"] = [p.name, p.locality].compactMap { $0 }.joined(separator: ", ")
        }
        return out
    }

    /// A place by name (restaurant, airport) or address, preferring ones near Fred.
    private static func find(_ dest: String) async -> MKMapItem? {
        let here = CLLocationManager().location
        let search = MKLocalSearch.Request()
        search.naturalLanguageQuery = dest
        if let here { search.region = MKCoordinateRegion(center: here.coordinate, latitudinalMeters: 200_000, longitudinalMeters: 200_000) }
        if let hit = try? await MKLocalSearch(request: search).start().mapItems.first { return hit }
        if let mark = try? await CLGeocoder().geocodeAddressString(dest).first {
            return MKMapItem(placemark: MKPlacemark(placemark: mark))
        }
        return nil
    }
}

/// One location fix, with a time limit.
@MainActor
final class OneFix: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var done: CheckedContinuation<CLLocation?, Never>?

    func get(timeout: TimeInterval) async -> CLLocation? {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        return await withCheckedContinuation { c in
            done = c
            manager.requestLocation()
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.finish(nil)
            }
        }
    }

    private func finish(_ loc: CLLocation?) {
        guard let c = done else { return }
        done = nil
        manager.stopUpdatingLocation()
        c.resume(returning: loc)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let loc = locations.last
        Task { @MainActor in self.finish(loc) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
