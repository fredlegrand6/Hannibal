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
