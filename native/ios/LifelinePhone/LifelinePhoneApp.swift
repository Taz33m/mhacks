import SwiftUI
import CoreMotion
import AVFoundation

@main struct LifelinePhoneApp: App {
    @StateObject private var model = ChestMotionModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("LIFELINE").font(.largeTitle.bold())
                    Text("Chest iPhone · real motion").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Relay Mac address (port 8877)").font(.caption)
                        TextField("Mac LAN or Tailscale IP", text: $model.host)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Development pairing token").font(.caption)
                        SecureField("From the Mac's local dashboard", text: $model.token)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }.textFieldStyle(.roundedBorder).disabled(model.monitoring)
                    Button(model.monitoring ? "Stop monitoring" : "Start monitoring") {
                        if model.monitoring { model.stop() } else { model.start() }
                    }.buttonStyle(.borderedProminent).controlSize(.large)
                    Text(model.status).fixedSize(horizontal: false, vertical: true)
                    Text("Sent \(model.samples) samples · skipped \(model.dropped)")
                        .font(.caption.monospacedDigit())
                    Text(String(format: "Total acceleration: %.2f g", model.totalG))
                        .font(.caption.monospacedDigit())
                    Divider()
                    if let incident = model.incident {
                        Text("Incident: \(incident.phase)").font(.headline)
                        Text("\(incident.evidence.summary)")
                        if incident.phase == "CONFIRMING" {
                            Text("Possible fall. Do you need help?").font(.title2.bold())
                            Text("If you don't respond, LIFELINE will request help from approved responders.")
                            Button("I DON'T NEED HELP") { Task { await model.cancelCurrentCheckin() } }
                                .font(.title2.bold()).buttonStyle(.borderedProminent)
                                .controlSize(.large).tint(.green).disabled(model.cancelling)
                            if let deadline = incident.checkinDeadline {
                                Text("Check-in deadline: \(Date(timeIntervalSince1970: deadline / 1000), style: .time)")
                                    .font(.caption)
                            }
                        }
                    } else {
                        Text("No active incident").font(.headline)
                    }
                    Text(model.checkinStatus).foregroundStyle(.secondary)
                    if !model.audioStatus.isEmpty {
                        Text(model.audioStatus).font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Keep this app foregrounded with the phone mounted on your chest. Calibrate both sources on the dashboard after mounting or reconnecting.")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(24)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { model.stopForBackground() }
            }
        }
    }
}

struct CheckinResponse: Decodable {
    let incident: PhoneIncident?
    let audioUrl: String?
}
struct PhoneIncident: Decodable {
    struct Evidence: Decodable { let summary: String }
    let id: String
    let phase: String
    let checkinId: String
    let checkinDeadline: Double?
    let evidence: Evidence
}

/// A native foreground producer. Simulator/non-motion devices send no fabricated samples.
@MainActor final class ChestMotionModel: ObservableObject {
    @Published var host = UserDefaults.standard.string(forKey: "lifeline.host") ?? "" {
        didSet { UserDefaults.standard.set(host, forKey: "lifeline.host") }
    }
    @Published var token = UserDefaults.standard.string(forKey: "lifeline.token") ?? "" {
        didSet { UserDefaults.standard.set(token, forKey: "lifeline.token") }
    }
    @Published var monitoring = false
    @Published var status = "Enter the Mac address and pairing token."
    @Published var samples = 0
    @Published var dropped = 0
    @Published var totalG = 0.0
    @Published var incident: PhoneIncident?
    @Published var checkinStatus = "Check-ins are fetched when monitoring starts."
    @Published var audioStatus = ""
    @Published var cancelling = false

    private let motion = CMMotionManager()
    private let motionQueue = OperationQueue()
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var timer: Timer?
    private var sessionId = UUID().uuidString
    private var monitoringEpoch = UUID().uuidString
    private var lastSensorTime = -1.0
    private var lastSampleReceived = 0.0
    private var sending = false
    private var polling = false
    private var playedCheckins = Set<String>()
    private var audioPlayer: AVAudioPlayer?
    private let speech = AVSpeechSynthesizer()
    private let prompt = "I detected a possible fall. Do you need help? Tap I don't need help to cancel this check-in."

    private func url(_ scheme: String, path: String, producer: Bool = false) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        components.port = 8877
        components.path = path
        if producer {
            components.queryItems = [URLQueryItem(name: "source", value: "chest-phone"),
                                     URLQueryItem(name: "token", value: token.trimmingCharacters(in: .whitespacesAndNewlines))]
        }
        return components.url
    }

    func start() {
        guard !monitoring else { return }
        guard !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              url("http", path: "/health") != nil else {
            status = "Enter a valid Mac hostname/IP and development pairing token."
            return
        }
        monitoring = true
        monitoringEpoch = UUID().uuidString
        UIApplication.shared.isIdleTimerDisabled = true
        connect()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.monitoring else { return }
                if self.socket == nil { self.connect() }
                else if self.motion.isDeviceMotionActive,
                        ProcessInfo.processInfo.systemUptime - self.lastSampleReceived > 3 {
                    self.status = "Real motion paused. Reconnecting; recalibrate when stable."
                    self.disconnect()
                }
                await self.pollCheckin()
            }
        }
        Task { await pollCheckin() }
    }

    private func connect() {
        guard monitoring, let endpoint = url("ws", path: "/motion", producer: true) else { return }
        disconnect()
        sessionId = UUID().uuidString
        lastSensorTime = -1
        samples = 0
        dropped = 0
        lastSampleReceived = ProcessInfo.processInfo.systemUptime
        let task = URLSession.shared.webSocketTask(with: endpoint)
        socket = task
        task.resume()
        receiveTask = Task { [weak self] in await self?.receiveMessages(task) }

        guard motion.isDeviceMotionAvailable else {
            status = "Device motion is unavailable. No sensor samples are being sent. Check-in UI remains available."
            return
        }
        status = "Starting real chest motion. Requested 100 Hz; measure received cadence on the dashboard."
        motion.deviceMotionUpdateInterval = 0.01
        motionQueue.maxConcurrentOperationCount = 1
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: motionQueue) { [weak self] sample, error in
            guard let sample else {
                if error != nil {
                    Task { @MainActor in self?.status = "Core Motion unavailable. Check the motion permission on this phone." }
                }
                return
            }
            let q = sample.attitude.quaternion
            let r = sample.rotationRate
            let g = sample.gravity
            let a = sample.userAcceleration
            let time = sample.timestamp
            let received = ProcessInfo.processInfo.systemUptime
            Task { @MainActor in
                guard let self, self.monitoring, self.socket === task,
                      ProcessInfo.processInfo.systemUptime - received < 0.25,
                      time >= 0, time > self.lastSensorTime,
                      [q.x,q.y,q.z,q.w,r.x,r.y,r.z,g.x,g.y,g.z,a.x,a.y,a.z,time].allSatisfy({ $0.isFinite }),
                      (0.5...1.5).contains(sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w)) else { return }
                self.lastSensorTime = time
                self.lastSampleReceived = ProcessInfo.processInfo.systemUptime
                self.totalG = sqrt(pow(g.x+a.x, 2)+pow(g.y+a.y, 2)+pow(g.z+a.z, 2))
                guard !self.sending else { self.dropped += 1; return }
                let packet: [String: Any] = [
                    "type": "motion.sample", "source": "chest-phone", "sensorLocation": "phone",
                    "sessionId": self.sessionId, "sequence": self.samples, "sensorTime": time,
                    "quaternion": [q.x,q.y,q.z,q.w], "rotationRate": [r.x,r.y,r.z],
                    "gravity": [g.x,g.y,g.z], "userAcceleration": [a.x,a.y,a.z]
                ]
                guard let bytes = try? JSONSerialization.data(withJSONObject: packet) else { return }
                self.samples += 1
                self.sending = true
                do { try await task.send(.data(bytes)) }
                catch {
                    guard self.socket === task else { return }
                    self.status = "Relay connection paused. Check host/token; retrying."
                    self.disconnect()
                }
                if self.socket === task { self.sending = false }
            }
        }
    }

    private func receiveMessages(_ task: URLSessionWebSocketTask) async {
        do {
            while monitoring, socket === task, !Task.isCancelled {
                let message = try await task.receive()
                let receivedMs = ProcessInfo.processInfo.systemUptime * 1000
                let data: Data
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let bytes): data = bytes
                @unknown default: continue
                }
                guard monitoring, socket === task,
                      let ping = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      ping["type"] as? String == "clock.ping", let id = ping["id"] as? String else { continue }
                let pong: [String: Any] = ["type": "clock.pong", "id": id, "sessionId": sessionId,
                    "deviceReceivedMs": receivedMs, "deviceSentMs": ProcessInfo.processInfo.systemUptime * 1000]
                try await task.send(.data(JSONSerialization.data(withJSONObject: pong)))
            }
        } catch {
            guard monitoring, socket === task else { return }
            status = "Relay connection ended. Check the address/token; retrying."
            disconnect()
        }
    }

    private func authenticatedRequest(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest? {
        guard let endpoint = url("http", path: path) else { return nil }
        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 4
        request.httpMethod = method
        request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private func pollCheckin() async {
        guard monitoring, !polling, let request = authenticatedRequest("/api/checkin") else { return }
        let epoch = monitoringEpoch
        polling = true
        defer { polling = false }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard monitoring, monitoringEpoch == epoch else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                incident = nil
                checkinStatus = "Check-in unavailable. Verify pairing token and relay."
                return
            }
            let checkin = try JSONDecoder().decode(CheckinResponse.self, from: data)
            incident = checkin.incident
            if checkin.incident?.phase != "CONFIRMING" { stopAudio() }
            checkinStatus = "Connected to the incident controller."
            if let current = checkin.incident, current.phase == "CONFIRMING",
               !playedCheckins.contains(current.checkinId) {
                playedCheckins.insert(current.checkinId)
                await playCheckin(current.checkinId, path: checkin.audioUrl, epoch: epoch)
            }
        } catch {
            guard monitoring, monitoringEpoch == epoch else { return }
            incident = nil
            checkinStatus = "Check-in connection unavailable; this does not mean the incident is safe."
        }
    }

    func cancelCurrentCheckin() async {
        guard let current = incident, current.phase == "CONFIRMING", !cancelling,
              let body = try? JSONSerialization.data(withJSONObject: ["type": "cancel", "incidentId": current.id, "checkinId": current.checkinId]),
              let request = authenticatedRequest("/api/commands", method: "POST", body: body) else { return }
        cancelling = true
        let epoch = monitoringEpoch
        defer { cancelling = false }
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard monitoring, monitoringEpoch == epoch else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                checkinStatus = "Cancellation was rejected or this check-in changed. Refreshing."
                await pollCheckin()
                return
            }
            stopAudio()
            // Invalidate an in-flight audio fetch immediately after the controller
            // accepts cancellation; the next poll supplies authoritative state.
            incident = nil
            checkinStatus = "Cancellation accepted by the controller."
            await pollCheckin()
        } catch {
            guard monitoring, monitoringEpoch == epoch else { return }
            checkinStatus = "Cancellation result is unknown. Reconnecting to check the controller."
        }
    }

    private func playCheckin(_ checkinId: String, path: String?, epoch: String) async {
        // The chest phone owns wearer speech. Verify its physical audio route
        // while the Mac is holding the waist AirPod; compilation cannot prove it.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { audioStatus = "Phone audio session unavailable." }
        if let path, path.hasPrefix("/"), !path.hasPrefix("//"),
           let request = authenticatedRequest(path) {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard monitoring, monitoringEpoch == epoch, incident?.phase == "CONFIRMING", incident?.checkinId == checkinId else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                let player = try AVAudioPlayer(data: data)
                player.prepareToPlay()
                guard player.play() else { throw URLError(.cannotDecodeContentData) }
                audioPlayer = player
                audioStatus = "Playing the server-provided ElevenLabs check-in."
                return
            } catch {
                // Provider/network failures retain the check-in and visibly use native speech.
            }
        }
        guard monitoring, monitoringEpoch == epoch, incident?.phase == "CONFIRMING", incident?.checkinId == checkinId else { return }
        audioStatus = "Development fallback: native iPhone speech (ElevenLabs audio unavailable)."
        speech.speak(AVSpeechUtterance(string: prompt))
    }

    private func disconnect() {
        motion.stopDeviceMotionUpdates()
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        sending = false
    }

    private func stopAudio() {
        audioPlayer?.stop()
        audioPlayer = nil
        speech.stopSpeaking(at: .immediate)
    }

    func stop() {
        monitoring = false
        timer?.invalidate()
        timer = nil
        disconnect()
        stopAudio()
        incident = nil
        UIApplication.shared.isIdleTimerDisabled = false
        status = "Stopped. Sensor unavailability does not resolve an incident."
        checkinStatus = "Monitoring stopped. Existing incidents remain with the controller."
    }

    func stopForBackground() {
        guard monitoring else { return }
        stop()
        status = "App moved to the background. Return here and start again; recalibrate on the dashboard."
    }
}
