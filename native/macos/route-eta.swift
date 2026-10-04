import Foundation
import MapKit
import Darwin

/// A one-request walking ETA helper. Location consent and freshness are caller-owned.
@main
struct RouteEta {
    private static func finish(_ value: [String: Any]? = nil) -> Never {
        if let value, let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), bytes.count <= 4096 {
            FileHandle.standardOutput.write(bytes)
            FileHandle.standardOutput.write(Data([10]))
        } else {
            FileHandle.standardOutput.write(Data("null\n".utf8))
        }
        exit(0)
    }

    @MainActor
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 4, let originLat = Double(args[0]), let originLon = Double(args[1]),
              let targetLat = Double(args[2]), let targetLon = Double(args[3]),
              [originLat, originLon, targetLat, targetLon].allSatisfy({ $0.isFinite }) else { finish() }
        let origin = CLLocationCoordinate2D(latitude: originLat, longitude: originLon)
        let target = CLLocationCoordinate2D(latitude: targetLat, longitude: targetLon)
        guard CLLocationCoordinate2DIsValid(origin), CLLocationCoordinate2DIsValid(target) else { finish() }
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: origin))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: target))
        request.transportType = .walking
        let directions = MKDirections(request: request)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6.5) {
            directions.cancel()
            finish()
        }
        directions.calculateETA { response, error in
            guard error == nil, let response, response.transportType == .walking,
                  response.expectedTravelTime.isFinite, response.expectedTravelTime >= 0, response.expectedTravelTime <= 86_400,
                  response.distance.isFinite, response.distance >= 0, response.distance <= 500_000 else { finish() }
            finish(["seconds": response.expectedTravelTime, "distanceMeters": response.distance, "transport": "walking"])
        }
        RunLoop.main.run()
    }
}
