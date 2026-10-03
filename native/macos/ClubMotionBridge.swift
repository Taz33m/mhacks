import SwiftUI
import CoreMotion
import Foundation

enum MotionActivity {
    static let title = "LIFELINE · Waist AirPod"
    static let source = "waist-airpod"
    static let instruction = "Mount the reporting bud at the waist, then calibrate both sources on the dashboard."
}

// Copied from Kinesthetic native/ClubMotionBridge.swift, commit
// 1bd0512ecf62a4c756a0331fad8b752509ce43da (it credits Aircade acquisition).
// LIFELINE changes the relay contract and exports gravity + user acceleration.
// KeepAlive.swift is deliberately unchanged from that implementation.
// Native motion requires a supported paired AirPods set; no simulated fallback.
@MainActor final class ClubMotionBridge: ObservableObject {
    @Published var relayHost = UserDefaults.standard.string(forKey: "lifeline.relayHost") ?? "127.0.0.1" {
        didSet { UserDefaults.standard.set(relayHost, forKey: "lifeline.relayHost") }
    }
    @Published var pairToken = UserDefaults.standard.string(forKey: "lifeline.pairToken") ?? "" {
        didSet { UserDefaults.standard.set(pairToken, forKey: "lifeline.pairToken") }
    }
    @Published var expectedBud = UserDefaults.standard.string(forKey: "lifeline.expectedBud") ?? "Either" {
        didSet { UserDefaults.standard.set(expectedBud, forKey: "lifeline.expectedBud") }
    }
    @Published var status = "Looking for paired AirPods…"
    @Published var source = "Waiting"
    @Published var samples = 0
    @Published var dropped = 0
    @Published var running = false
    @Published var monitoring = false
    @Published var relayConnected = false
    @Published var routeHeld = false
    @Published var speed = 0.0
    private var manager: CMHeadphoneMotionManager?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var verifying = false
    private let motionQueue = OperationQueue()
    private var session = UUID().uuidString
    private var lastTime = -1.0
    private var sending = false
    private var lastSampleReceived = 0.0
    private var streamStarted = 0.0
    private var discoveryTimer: Timer?
    // Holds the AirPods as the active audio output; without it macOS hands output
    // back to the speakers when a bud leaves the ear and motion silently stops.
    private let route = AudioRouteKeeper(nameMatch: "AirPods")
    /// Retained Kinesthetic audio-route behavior; the phone owns wearer speech.
    @Published var speakersToo = UserDefaults.standard.object(forKey: "lifeline.speakersToo") as? Bool ?? true {
        didSet { UserDefaults.standard.set(speakersToo, forKey: "lifeline.speakersToo"); route.speakersToo = speakersToo; reclaimRoute() }
    }

    func startAutomatically() {
        monitoring = true
        route.speakersToo = speakersToo
        route.watch { [weak self] in Task { @MainActor in self?.reclaimRoute() } }
        if discoveryTimer == nil {
            discoveryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.checkConnection() }
            }
        }
        checkConnection()
    }

    private func reclaimRoute() {
        guard monitoring else { return }
        if let note = route.claim() { status = note }
        routeHeld = route.holding
    }

    private func checkConnection() {
        guard monitoring else { return }
        // Runs on the existing 2s discovery timer; claim() is idempotent.
        if let note = route.claim() { status = note }
        routeHeld = route.holding
        if running {
            if ProcessInfo.processInfo.systemUptime - lastSampleReceived > 5 {
                status = "AirPod motion paused. Reconnecting…"
                stop(keepStatus: true)
            } else if ProcessInfo.processInfo.systemUptime - streamStarted > 1.5,
                      let task = socket {
                Task { await verifyRelay(task) }
            }
            return
        }
        if CMHeadphoneMotionManager().isDeviceMotionAvailable { start() }
        else { status = "Waiting for paired AirPods with motion tracking…" }
    }

    private func relayURL(_ scheme: String, path: String = "", query: [URLQueryItem] = []) -> URL? {
        var parts = URLComponents()
        let host = relayHost.trimmingCharacters(in: .whitespaces)
        parts.scheme = scheme; parts.host = host.isEmpty ? "127.0.0.1" : host; parts.port = 8877; parts.path = "/" + path
        let token = pairToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let items = query + (token.isEmpty ? [] : [URLQueryItem(name: "token", value: token)])
        parts.queryItems = items.isEmpty ? nil : items
        return parts.url
    }

    private func verifyRelay(_ task: URLSessionWebSocketTask) async {
        guard running, socket === task, !verifying,
              let url = relayURL("http", path: "health") else { return }
        verifying = true
        defer { verifying = false }
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 3
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let health = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let sources = health?["motionSources"] as? [String] ?? []
            guard running, socket === task else { return }
            if sources.contains(MotionActivity.source) && samples > 0 && ProcessInfo.processInfo.systemUptime-lastSampleReceived < 1 {
                relayConnected = true
                status = "Real waist motion is reaching LIFELINE."
            }
            else { status = "AirPod motion detected; reconnecting to LIFELINE…"; stop(keepStatus: true) }
        } catch {
            guard running, socket === task else { return }
            status = "Motion relay unavailable. Check host and token. Retrying…"
            stop(keepStatus: true)
        }
    }

    func start() {
        stop()
        guard !pairToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status = "Paste the development pairing token from the local dashboard first."
            return
        }
        let manager = CMHeadphoneMotionManager()
        guard manager.isDeviceMotionAvailable else {status="AirPod motion is unavailable. Pair a supported set and try again.";return}
        self.manager=manager
        guard let url=relayURL("ws",path:"motion",query:[URLQueryItem(name:"source",value:MotionActivity.source)]) else {status="Relay address is not valid.";return}
        let task=URLSession.shared.webSocketTask(with:url)
        socket=task;task.resume()
        session=UUID().uuidString;lastTime = -1;samples=0;dropped=0;running=true
        lastSampleReceived=ProcessInfo.processInfo.systemUptime
        streamStarted=lastSampleReceived
        status="Waiting for real AirPod motion and the local relay…"
        receiveTask = Task { [weak self] in await self?.receiveMessages(task) }
        motionQueue.maxConcurrentOperationCount=1
        manager.startDeviceMotionUpdates(to:motionQueue) { [weak self] motion,error in
            guard let motion else {
                if let error { Task { @MainActor in self?.status=error.localizedDescription } }
                return
            }
            let q=motion.attitude.quaternion,r=motion.rotationRate
            let g=motion.gravity,a=motion.userAcceleration
            let sensorSource: String
            switch motion.sensorLocation {
            case .headphoneLeft:sensorSource="Left"
            case .headphoneRight:sensorSource="Right"
            default:sensorSource="Unknown"
            }
            let time=motion.timestamp
            let received=ProcessInfo.processInfo.systemUptime
            Task { @MainActor in
                guard let self, self.running, self.socket === task,
                    ProcessInfo.processInfo.systemUptime-received < 0.25,
                    time >= 0, time > self.lastTime, sensorSource != "Unknown",
                    [q.x,q.y,q.z,q.w,r.x,r.y,r.z,g.x,g.y,g.z,a.x,a.y,a.z,time].allSatisfy({$0.isFinite}),
                    (0.5...1.5).contains(sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w)) else {return}
                guard self.expectedBud == "Either" || self.expectedBud == sensorSource else {
                    self.status = "Reporting \(sensorSource) bud differs from the configured waist bud. No samples sent."
                    return
                }
                if self.source != "Waiting" && self.source != sensorSource {
                    self.status = "Reporting bud changed. Reconnecting with a new session; recalibrate."
                    self.stop(keepStatus: true)
                    return
                }
                self.lastTime=time;self.source=sensorSource
                self.lastSampleReceived=ProcessInfo.processInfo.systemUptime
                self.speed=sqrt(r.x*r.x+r.y*r.y+r.z*r.z)
                guard !self.sending else {self.dropped += 1;return}
                let p:[String:Any]=["type":"motion.sample","source":MotionActivity.source,
                    "sensorLocation":sensorSource,"sessionId":self.session,"sequence":self.samples,
                    "sensorTime":time,"quaternion":[q.x,q.y,q.z,q.w],"rotationRate":[r.x,r.y,r.z],
                    "gravity":[g.x,g.y,g.z],"userAcceleration":[a.x,a.y,a.z]]
                guard let data=try? JSONSerialization.data(withJSONObject:p),let text=String(data:data,encoding:.utf8) else{return}
                self.samples+=1;self.sending=true
                do {try await task.send(.string(text))}
                catch {
                    guard self.socket === task else { return }
                    self.status="Relay connection paused. Reconnecting…";self.stop(keepStatus:true)
                }
                if self.socket === task { self.sending=false }
            }
        }
    }
    private func receiveMessages(_ task: URLSessionWebSocketTask) async {
        do {
            while running, socket === task, !Task.isCancelled {
                let message = try await task.receive()
                let receivedMs = ProcessInfo.processInfo.systemUptime * 1000
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: continue
                }
                guard running, socket === task,
                      let ping = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      ping["type"] as? String == "clock.ping", let id = ping["id"] as? String else { continue }
                let pong: [String: Any] = ["type": "clock.pong", "id": id, "sessionId": session,
                    "deviceReceivedMs": receivedMs, "deviceSentMs": ProcessInfo.processInfo.systemUptime * 1000]
                let bytes = try JSONSerialization.data(withJSONObject: pong)
                try await task.send(.data(bytes))
            }
        } catch {
            guard running, socket === task else { return }
            status = "Relay connection ended. Check pairing and retrying…"
            stop(keepStatus: true)
        }
    }
    func stop(keepStatus:Bool=false) {
        running=false;relayConnected=false;source="Waiting";speed=0
        manager?.stopDeviceMotionUpdates();manager=nil
        receiveTask?.cancel();receiveTask=nil
        socket?.cancel(with:.goingAway,reason:nil);socket=nil;sending=false
        if !keepStatus {status="Stopped. Recalibrate on the dashboard after reconnecting."}
    }
    func pause() {
        monitoring = false
        discoveryTimer?.invalidate(); discoveryTimer=nil
        route.release()
        stop()
    }
}

final class ClubAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        sender.activate(ignoringOtherApps: true)
        for window in sender.windows where window.canBecomeMain { window.makeKeyAndOrderFront(nil) }
        return true
    }
}
@main struct LifelineAirPodApp: App {
    @NSApplicationDelegateAdaptor(ClubAppDelegate.self) var appDelegate
    @StateObject private var bridge=ClubMotionBridge()
    var body: some Scene {
        WindowGroup(MotionActivity.title) {
            VStack(alignment:.leading,spacing:18) {
                Text(bridge.relayConnected ? "Waist AirPod connected." : bridge.monitoring ? "Connecting waist AirPod…" : "Waist motion paused.").font(.largeTitle.bold())
                Text("Real AirPods motion → LIFELINE · port 8877").foregroundStyle(.secondary)
                // Labelled, because a filled field loses its placeholder and the two are easy to swap.
                Grid(alignment:.leading,horizontalSpacing:10,verticalSpacing:8) {
                    GridRow {
                        Text("Relay Mac IP").foregroundStyle(.secondary)
                        TextField("127.0.0.1 = this Mac",text:$bridge.relayHost)
                    }
                    GridRow {
                        Text("Pairing token").foregroundStyle(.secondary)
                        SecureField("From the local LIFELINE dashboard",text:$bridge.pairToken)
                    }
                }.textFieldStyle(.roundedBorder).onSubmit { if bridge.monitoring { bridge.start() } }
                Text(bridge.status).fixedSize(horizontal:false,vertical:true)
                Picker("Mounted waist bud", selection: $bridge.expectedBud) {
                    Text("Verify reporting bud").tag("Either")
                    Text("Left").tag("Left"); Text("Right").tag("Right")
                }.disabled(bridge.running)
                Text("Reporting AirPod: \(bridge.source)")
if bridge.routeHeld {Text("Holding the AirPods audio route so motion continues off-ear.").font(.caption).foregroundStyle(.secondary)}
                Toggle("Also play this Mac's sound on its speakers",isOn:$bridge.speakersToo).font(.caption)
                Text(String(format:"Angular speed: %.2f rad/s · %d samples · %d skipped",bridge.speed,bridge.samples,bridge.dropped)).monospacedDigit()
                HStack {
                    Button(bridge.monitoring ? "Pause motion" : "Start motion") {if bridge.monitoring {bridge.pause()} else {bridge.startAutomatically()}}
                    Text(MotionActivity.instruction).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(28).frame(width:510)
        }.windowResizability(.contentSize)
    }
}
