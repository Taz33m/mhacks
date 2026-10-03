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
#if targetEnvironment(simulator)
                    Text("Simulator UI · physical motion and speech unverified").font(.caption).foregroundStyle(.orange)
#else
                    Text("Chest iPhone · real motion").foregroundStyle(.secondary)
#endif
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
                    Text(model.connectionStatus).font(.caption).fixedSize(horizontal: false, vertical: true)
                    Text("Socket completed \(model.samples) frames · skipped \(model.dropped)")
                        .font(.caption.monospacedDigit())
                    Text(model.totalG.map { String(format: "Local acceleration: %.2f g", $0) } ?? "No motion sample available")
                        .font(.caption.monospacedDigit())
                    Text("The dashboard confirms received motion; a completed socket send is not a server acknowledgement.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("I NEED HELP") { Task { await model.requestManualHelp() } }
                        .font(.title2.bold()).buttonStyle(.borderedProminent)
                        .controlSize(.large).tint(.red)
                        .disabled(model.requestingHelp || model.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || model.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Divider()
                    if let incident = model.incident {
                        Text("Incident: \(incident.phase)").font(.headline)
                        Text("\(incident.evidence.summary)")
                        if incident.phase == "CONFIRMING" {
                            Text("Possible fall. Do you need help?").font(.title2.bold())
                            Text("If you don't respond, LIFELINE will request help from approved responders.")
                            Text("You can say ‘I need help.’ Spoken replies never cancel the incident.")
                            Button("I DON'T NEED HELP") { Task { await model.cancelCurrentCheckin() } }
                                .font(.title2.bold()).buttonStyle(.borderedProminent)
                                .controlSize(.large).tint(.green).disabled(model.cancelling)
                            if let deadline = incident.checkinDeadline {
                                Text("Check-in deadline: \(Date(timeIntervalSince1970: deadline / 1000), style: .time)")
                                    .font(.caption)
                            }
                        }
                        if incident.ownerId != nil {
                            Text("Responder: \(model.ownerName)").font(.headline)
                            Text(model.progressExplanation)
                        } else if incident.phase == "HELP_REQUESTED" {
                            Text("Help requested. No responder has accepted responsibility yet.")
                        }
                        if let deadline = incident.progressDeadline {
                            Text("Next response/progress deadline: \(Date(timeIntervalSince1970: deadline / 1000), style: .time)")
                                .font(.caption)
                        }
                        if let outcome = incident.outcome, !outcome.isEmpty {
                            Text("Recorded outcome: \(outcome)")
                        }
                    } else {
                        Text(model.checkinAvailable ? "No active incident" : "Incident state not available").font(.headline)
                    }
                    Text(model.checkinStatus).foregroundStyle(.secondary)
                    CheckinVoiceStatusView(voice: model.voice)
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

struct CheckinVoiceStatusView: View {
    @ObservedObject var voice: CheckinVoiceSession
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(voice.status).font(.caption).foregroundStyle(.secondary)
            if !voice.transcript.isEmpty {
                Text(voice.transcriptIsFinal ? "Final transcript" : "Partial transcript — not submitted").font(.caption.bold())
                Text(voice.transcript)
            }
        }
    }
}

struct CheckinResponse: Decodable {
    let incident: PhoneIncident?
    let audioUrl: String?
    let serverTime: Double?
    let responders: [PhoneResponder]?
}
struct PhoneResponder: Decodable { let id: String; let name: String }
struct SpokenReplyResponse: Decodable { let decision: String }
private enum CheckinResponseError: Error { case unreadable }
struct PhoneIncident: Decodable {
    struct Evidence: Decodable { let summary: String }
    let id: String
    let phase: String
    let checkinId: String
    let checkinDeadline: Double?
    let evidence: Evidence
    let ownerId: String?
    let progressDeadline: Double?
    let outcome: String?
}

/// A native foreground producer. Simulator/non-motion devices send no fabricated samples.
@MainActor final class ChestMotionModel: NSObject, ObservableObject, URLSessionWebSocketDelegate {
    @Published var host = UserDefaults.standard.string(forKey: "lifeline.host") ?? "" {
        didSet { UserDefaults.standard.set(host, forKey: "lifeline.host") }
    }
    @Published var token = UserDefaults.standard.string(forKey: "lifeline.token") ?? "" {
        didSet { UserDefaults.standard.set(token, forKey: "lifeline.token") }
    }
    @Published var monitoring = false
    @Published var status = "Enter the Mac address and pairing token."
    @Published var connectionStatus = "Relay socket not connected."
    @Published var samples = 0
    @Published var dropped = 0
    @Published var totalG: Double?
    @Published var incident: PhoneIncident?
    @Published var checkinStatus = "Check-ins are fetched when monitoring starts."
    @Published var checkinAvailable = false
    @Published var cancelling = false
    @Published var requestingHelp = false
    @Published var responders: [PhoneResponder] = []
    let voice = CheckinVoiceSession()

    private let motion = CMMotionManager()
    private let motionQueue = OperationQueue()
    private var socket: URLSessionWebSocketTask?
    private var socketSession: URLSession?
    private let controllerSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 6
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()
    private var receiveTask: Task<Void, Never>?
    private var timer: Timer?
    private var sessionId = UUID().uuidString
    private var monitoringEpoch = UUID().uuidString
    private var lastSensorTime = -1.0
    private var lastSampleReceived = 0.0
    private var sending = false
    private var sequence = 0
    private var socketOpened = false
    private var connectionStarted = 0.0
    private var socketOpenedAt = 0.0
    private var sendStarted: Double?
    private var pongStarted: Double?
    private var lastClockPing: Double?
    private var retryNotBefore = 0.0
    private var pollingId: UUID?
    private var playedCheckins = Set<String>()
    private var replyTask: Task<Void, Never>?

    override init() {
        super.init()
        voice.onFinalTranscript = { [weak self] identity, transcript in
            guard let self else { return }
            self.replyTask?.cancel()
            self.replyTask = Task { await self.submitSpokenReply(identity, transcript: transcript) }
        }
        voice.onInvalidated = { [weak self] in self?.replyTask?.cancel(); self?.replyTask = nil }
    }

    var ownerName: String {
        guard let owner = incident?.ownerId else { return "Not assigned" }
        return responders.first(where: { $0.id == owner })?.name ?? owner
    }
    var progressExplanation: String {
        switch incident?.phase {
        case "ACKNOWLEDGED": return "Accepted responsibility. Departure has not been confirmed."
        case "RESPONDER_EN_ROUTE": return "The assigned responder confirmed they are on their way."
        case "ON_SCENE": return "The assigned responder confirmed arrival. Waiting for a recorded outcome."
        case "RESOLVED": return "The responder recorded an outcome."
        default: return "Waiting for the controller's next progress update."
        }
    }

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
        samples = 0
        dropped = 0
        retryNotBefore = 0
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 5
        socketSession = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        playedCheckins.removeAll()
        voice.refreshPermissionState()
        Task { await voice.preparePermissions() }
        UIApplication.shared.isIdleTimerDisabled = true
        connect()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.monitoring else { return }
                self.maintainConnection()
                await self.pollCheckin()
            }
        }
        Task { await pollCheckin() }
    }

    private func connect() {
        guard monitoring, socket == nil, ProcessInfo.processInfo.systemUptime >= retryNotBefore,
              let session = socketSession, let endpoint = url("ws", path: "/motion", producer: true) else { return }
        sessionId = UUID().uuidString
        lastSensorTime = -1
        sequence = 0
        connectionStarted = ProcessInfo.processInfo.systemUptime
        socketOpened = false
        lastClockPing = nil
        lastSampleReceived = ProcessInfo.processInfo.systemUptime
        connectionStatus = "Connecting to the relay on port 8877."
        let task = session.webSocketTask(with: endpoint)
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
                guard self.socketOpened, !self.sending else { self.dropped += 1; return }
                let packet: [String: Any] = [
                    "type": "motion.sample", "source": "chest-phone", "sensorLocation": "phone",
                    "sessionId": self.sessionId, "sequence": self.sequence, "sensorTime": time,
                    "quaternion": [q.x,q.y,q.z,q.w], "rotationRate": [r.x,r.y,r.z],
                    "gravity": [g.x,g.y,g.z], "userAcceleration": [a.x,a.y,a.z]
                ]
                guard let bytes = try? JSONSerialization.data(withJSONObject: packet) else { return }
                self.sequence += 1
                self.sending = true
                self.sendStarted = ProcessInfo.processInfo.systemUptime
                do {
                    try await task.send(.data(bytes))
                    guard self.monitoring, self.socket === task else { return }
                    self.samples += 1
                }
                catch {
                    guard self.socket === task else { return }
                    self.connectionFailed(task, reason: self.networkExplanation(error))
                }
                if self.socket === task { self.sending = false; self.sendStarted = nil }
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
                lastClockPing = ProcessInfo.processInfo.systemUptime
                connectionStatus = "Relay socket open. Receiver clock messages received."
                let pong: [String: Any] = ["type": "clock.pong", "id": id, "sessionId": sessionId,
                    "deviceReceivedMs": receivedMs, "deviceSentMs": ProcessInfo.processInfo.systemUptime * 1000]
                pongStarted = ProcessInfo.processInfo.systemUptime
                try await task.send(.data(JSONSerialization.data(withJSONObject: pong)))
                if socket === task { pongStarted = nil }
            }
        } catch {
            guard monitoring, socket === task else { return }
            connectionFailed(task, reason: networkExplanation(error))
        }
    }

    /// Runs before HTTP polling each tick, so a hanging send or poll cannot keep
    /// local motion readings looking like a working relay connection.
    private func maintainConnection() {
        guard monitoring else { return }
        guard let task = socket else { connect(); return }
        let now = ProcessInfo.processInfo.systemUptime
        if !socketOpened && now - connectionStarted >= 5 {
            connectionFailed(task, reason: "Relay handshake timed out after 5 seconds. Check Wi-Fi, Local Network permission, and Mac reachability.")
        } else if let started = sendStarted, now - started >= 3 {
            connectionFailed(task, reason: "Motion send stalled for 3 seconds; no completion was counted.")
        } else if let started = pongStarted, now - started >= 3 {
            connectionFailed(task, reason: "Receiver clock reply stalled for 3 seconds.")
        } else if socketOpened, now - (lastClockPing ?? socketOpenedAt) >= 7 {
            connectionFailed(task, reason: "No receiver clock message for 7 seconds. Relay continuity is unavailable.")
        } else if motion.isDeviceMotionActive, now - lastSampleReceived > 3 {
            status = "Real motion paused. Reconnecting; recalibrate when stable."
            connectionFailed(task, reason: "No new local motion sample for 3 seconds.")
        }
    }

    private func connectionFailed(_ task: URLSessionWebSocketTask, reason: String) {
        guard monitoring, socket === task else { return }
        connectionStatus = reason + " Retrying in 2 seconds. Recalibrate after reconnection."
        retryNotBefore = ProcessInfo.processInfo.systemUptime + 2
        disconnect()
    }

    // Static messages only: NSError descriptions/userInfo can contain the
    // authenticated request URL and must never be shown or logged.
    private func networkExplanation(_ error: Error) -> String {
        guard let failure = error as? URLError else { return "Relay request failed; no connection result is confirmed." }
        let reason: String
        switch failure.code {
        case .notConnectedToInternet:
            reason = "No usable network path. Check Wi-Fi and Settings > LIFELINE > Local Network."
        case .cannotConnectToHost:
            reason = "Cannot connect to the Mac on port 8877. Check its address, listener, and network access."
        case .cannotFindHost, .dnsLookupFailed:
            reason = "Cannot resolve the Mac hostname. Check the relay address."
        case .timedOut:
            reason = "Relay request timed out. Check phone-to-Mac reachability and Local Network permission."
        case .networkConnectionLost:
            reason = "The relay network connection was lost."
        case .appTransportSecurityRequiresSecureConnection:
            reason = "The request was blocked by transport security."
        case .badServerResponse:
            reason = "The relay rejected the connection or returned an invalid response. Check pairing and port 8877."
        case .cancelled:
            reason = "The relay request was cancelled."
        default:
            reason = "The relay network request failed."
        }
        return "\(reason) (URL error \(failure.code.rawValue))"
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        Task { @MainActor [weak self] in
            guard let self, self.monitoring, self.socket === webSocketTask else { return }
            self.socketOpened = true
            self.socketOpenedAt = ProcessInfo.processInfo.systemUptime
            self.connectionStatus = "Relay handshake completed. Waiting for receiver clock messages."
        }
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                                didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { @MainActor [weak self] in
            self?.connectionFailed(webSocketTask, reason: "Relay closed the socket (code \(closeCode.rawValue)).")
        }
    }

    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let webSocket = task as? URLSessionWebSocketTask, let error else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            let reason: String
            if let response = webSocket.response as? HTTPURLResponse, response.statusCode == 403 {
                reason = "Motion connection rejected (HTTP 403). Check pairing or another connected chest app."
            } else { reason = self.networkExplanation(error) }
            self.connectionFailed(webSocket, reason: reason)
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
        guard monitoring, pollingId == nil, let request = authenticatedRequest("/api/checkin") else { return }
        let epoch = monitoringEpoch
        let requestStarted = Date()
        let id = UUID()
        pollingId = id
        defer { if pollingId == id { pollingId = nil } }
        do {
            let (data, response) = try await controllerSession.data(for: request)
            guard monitoring, monitoringEpoch == epoch else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                incident = nil
                checkinAvailable = false
                voice.suspendForConnection(reason: "Check-in connection unavailable. Voice paused; incident safety is unknown.")
                let code = (response as? HTTPURLResponse)?.statusCode
                checkinStatus = code == 401 || code == 403
                    ? "Check-in rejected (HTTP \(code ?? 0)). Verify the pairing token."
                    : "Check-in unavailable (HTTP \(code ?? 0)). Verify the relay service."
                return
            }
            let checkin: CheckinResponse
            do { checkin = try JSONDecoder().decode(CheckinResponse.self, from: data) }
            catch { throw CheckinResponseError.unreadable }
            incident = checkin.incident
            checkinAvailable = true
            responders = checkin.responders ?? []
            if let activeIdentity = voice.identity,
               checkin.incident?.phase != "CONFIRMING" || checkin.incident?.id != activeIdentity.incidentId
                || checkin.incident?.checkinId != activeIdentity.checkinId {
                voice.cancel(reason: "The check-in changed. Voice stopped; controller state remains authoritative.")
            }
            if let activeIdentity = voice.identity, checkin.incident?.phase == "CONFIRMING",
               checkin.incident?.id == activeIdentity.incidentId, checkin.incident?.checkinId == activeIdentity.checkinId {
                voice.resumeAfterConnection(activeIdentity)
            }
            checkinStatus = "Connected to the incident controller."
            if let current = checkin.incident, current.phase == "CONFIRMING",
               !playedCheckins.contains(current.checkinId) {
                playedCheckins.insert(current.checkinId)
                let remoteNow = checkin.serverTime ?? Date().timeIntervalSince1970 * 1000
                let remaining = max(0, ((current.checkinDeadline ?? remoteNow) - remoteNow) / 1000)
                let identity = CheckinIdentity(incidentId: current.id, checkinId: current.checkinId, monitoringEpoch: epoch)
                let audioRequest: URLRequest?
                if let path = checkin.audioUrl, path.hasPrefix("/"), !path.hasPrefix("//") {
                    audioRequest = authenticatedRequest(path)
                } else { audioRequest = nil }
                voice.begin(identity, deadline: requestStarted.addingTimeInterval(remaining), audioRequest: audioRequest)
            }
        } catch {
            guard monitoring, monitoringEpoch == epoch else { return }
            incident = nil
            checkinAvailable = false
            voice.suspendForConnection(reason: "Check-in connection unavailable. Voice paused; the incident remains with the controller.")
            let reason = error is CheckinResponseError ? "Relay returned unreadable incident state (HTTP 200)." : networkExplanation(error)
            checkinStatus = "Check-in unavailable. \(reason) Incident safety is unknown."
        }
    }

    func cancelCurrentCheckin() async {
        guard let current = incident, current.phase == "CONFIRMING", !cancelling,
              let body = try? JSONSerialization.data(withJSONObject: ["type": "cancel", "incidentId": current.id, "checkinId": current.checkinId]),
              let request = authenticatedRequest("/api/commands", method: "POST", body: body) else { return }
        cancelling = true
        voice.cancel(reason: "Explicit cancellation sent. Waiting for controller confirmation.")
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

    private func submitSpokenReply(_ identity: CheckinIdentity, transcript: String) async {
        guard current(identity), !Task.isCancelled,
              let body = try? JSONSerialization.data(withJSONObject: [
                "incidentId": identity.incidentId, "checkinId": identity.checkinId,
                "transcript": transcript, "source": "ios-on-device-speech"
              ]), let request = authenticatedRequest("/api/checkin/reply", method: "POST", body: body) else { return }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard current(identity), !Task.isCancelled else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                voice.submissionUnavailable(identity)
                await pollCheckin()
                return
            }
            let reply = try JSONDecoder().decode(SpokenReplyResponse.self, from: data)
            voice.receivedDecision(reply.decision, expected: identity)
            if !Task.isCancelled { await pollCheckin() }
        } catch {
            guard current(identity), !Task.isCancelled else { return }
            voice.submissionUnavailable(identity)
            await pollCheckin()
        }
    }

    private func current(_ identity: CheckinIdentity) -> Bool {
        monitoring && monitoringEpoch == identity.monitoringEpoch && incident?.phase == "CONFIRMING"
            && incident?.id == identity.incidentId && incident?.checkinId == identity.checkinId && voice.isCurrent(identity)
    }

    func requestManualHelp() async {
        guard !requestingHelp else { return }
        if !monitoring { start() }
        guard monitoring, let body = try? JSONSerialization.data(withJSONObject: [
            "type": "trigger", "kind": "manual", "summary": "Wearer explicitly pressed I NEED HELP on the chest iPhone."
        ]), let request = authenticatedRequest("/api/commands", method: "POST", body: body) else { return }
        requestingHelp = true
        voice.cancel(reason: "Manual help request sent. Waiting for controller confirmation.")
        let epoch = monitoringEpoch
        defer { requestingHelp = false }
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard monitoring, monitoringEpoch == epoch else { return }
            checkinStatus = (response as? HTTPURLResponse)?.statusCode == 200
                ? "The controller accepted your manual help request. Waiting for responder updates."
                : "Manual help request was rejected. Check connectivity and pairing."
            await pollCheckin()
        } catch {
            guard monitoring, monitoringEpoch == epoch else { return }
            checkinStatus = "Manual help result is unknown. Reconnecting to check controller state."
            await pollCheckin()
        }
    }

    private func disconnect() {
        motion.stopDeviceMotionUpdates()
        totalG = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        sending = false
        socketOpened = false
        sendStarted = nil
        pongStarted = nil
    }

    func stop() {
        monitoring = false
        timer?.invalidate()
        timer = nil
        disconnect()
        socketSession?.invalidateAndCancel()
        socketSession = nil
        pollingId = nil
        voice.cancel(reason: "Monitoring stopped. Voice and microphone are off.")
        incident = nil
        checkinAvailable = false
        UIApplication.shared.isIdleTimerDisabled = false
        status = "Stopped. Sensor unavailability does not resolve an incident."
        connectionStatus = "Relay socket stopped."
        checkinStatus = "Monitoring stopped. Existing incidents remain with the controller."
    }

    func stopForBackground() {
        guard monitoring else { return }
        stop()
        status = "App moved to the background. Return here and start again; recalibrate on the dashboard."
    }
}
