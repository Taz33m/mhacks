import SwiftUI

@main struct LifelinePhoneApp: App {
    @StateObject private var model = CommunicationModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WearerHomeView(model: model)
                .onAppear { model.startForDeveloperLaunchIfRequested() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { model.stopForBackground() }
                }
        }
    }
}

private struct WearerHomeView: View {
    @ObservedObject var model: CommunicationModel
    @State private var lastKnownIncident: PhoneIncident?
    @State private var lastKnownOwnerName: String?
    @State private var connectionDetailsExpanded = false

    private var setupIncomplete: Bool {
        model.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || model.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var displayedIncident: PhoneIncident? {
        model.incident ?? (model.checkinAvailable ? nil : lastKnownIncident)
    }

    // These values only retain presentation context; the model remains authoritative for every action.
    private var presentationIdentity: [String] {
        let incident = model.incident
        return [model.checkinAvailable ? "available" : "unavailable", incident?.id ?? "",
                incident?.phase ?? "", incident?.ownerId ?? "", incident?.outcome ?? "",
                incident?.evidence.summary ?? "", incident?.checkinDeadline.map { String($0) } ?? "",
                incident?.progressDeadline.map { String($0) } ?? ""]
            + model.responders.flatMap { [$0.id, $0.name] }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("LIFELINE").font(.largeTitle.bold())
#if targetEnvironment(simulator)
                Text("Simulator UI · communication companion").font(.caption).foregroundStyle(.orange)
#else
                Text("iPhone · communication companion").font(.subheadline).foregroundStyle(.secondary)
#endif
                Text("Device roles: FREE-WILi sensing and voice, with a waist AirPod for motion. This phone shows incident updates and explicit check-in controls.")
                    .font(.caption).foregroundStyle(.secondary)

                incidentCard

                Button {
                    Task { await model.requestManualHelp() }
                } label: {
                    Label(model.requestingHelp ? "REQUESTING HELP…" : "I NEED HELP", systemImage: "exclamationmark.circle.fill")
                        .font(.title2.bold()).frame(maxWidth: .infinity).padding(.vertical, 6)
                }.buttonStyle(.borderedProminent).controlSize(.large).tint(.red)
                    .disabled(model.requestingHelp || setupIncomplete)
                Text(model.checkinStatus).font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let policy = model.demoPolicyExplanation {
                    Text(policy).font(.caption).foregroundStyle(.orange)
                }

                Divider()
                VStack(alignment: .leading, spacing: 12) {
                    Text("Communication session").font(.headline)
                    Button(model.sessionActive ? "Stop communication" : "Start communication") {
                        if model.sessionActive {
                            model.stop()
                        } else {
                            if setupIncomplete { connectionDetailsExpanded = true }
                            model.start()
                        }
                    }.buttonStyle(.borderedProminent).controlSize(.large)
                    Text("Use the Mac dashboard for sensor calibration.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                DisclosureGroup("Connection and device details", isExpanded: $connectionDetailsExpanded) {
                    VStack(alignment: .leading, spacing: 12) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Relay Mac address (port 8877)").font(.caption)
                            TextField("Mac LAN or Tailscale IP", text: $model.host)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityLabel("Relay Mac address")
                            Text("Development pairing token").font(.caption)
                            SecureField("From the Mac's local dashboard", text: $model.token)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .accessibilityLabel("Development pairing token")
                        }.textFieldStyle(.roundedBorder).disabled(model.sessionActive)
                        if model.relayHost != model.host.trimmingCharacters(in: .whitespacesAndNewlines) {
                            Text("Active developer connection: \(model.relayHost). Saved Wi-Fi address is unchanged.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Text(model.status).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                    }.padding(.top, 12)
                }.font(.subheadline)
                Text("Keep this app foregrounded for current communication updates. Stopping this session does not stop wearable sensing or resolve an incident.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(24)
        }
        .onChange(of: setupIncomplete, initial: true) { _, incomplete in
            if incomplete { connectionDetailsExpanded = true }
        }
        .onChange(of: presentationIdentity, initial: true) { _, _ in
            if model.checkinAvailable {
                lastKnownIncident = model.incident
                lastKnownOwnerName = model.incident?.ownerId == nil ? nil : model.ownerName
            }
        }
    }

    private var incidentCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !model.checkinAvailable {
                Label(displayedIncident == nil ? "Status unavailable" : "Last known status", systemImage: "wifi.exclamationmark")
                    .font(.subheadline.bold()).foregroundStyle(.orange)
                Text(model.sessionActive
                     ? "The phone cannot confirm the latest incident state. Reconnect to get current progress."
                     : "Communication is stopped. Start communication to get the current incident state.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if let incident = displayedIncident {
                let presentation = phasePresentation(incident.phase)
                Label(presentation.title, systemImage: presentation.symbol)
                    .font(.title2.bold()).foregroundStyle(presentation.color)
                    .accessibilityAddTraits(.isHeader)
                Text(presentation.explanation).fixedSize(horizontal: false, vertical: true)

                if incident.ownerId != nil {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(incident.phase == "RESOLVED" ? "Responder who recorded the outcome" : "Assigned responder")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(model.incident == nil ? (lastKnownOwnerName ?? "Assigned responder") : model.ownerName)
                            .font(.headline)
                    }.accessibilityElement(children: .combine)
                } else if incident.phase == "HELP_REQUESTED" {
                    Text("No responder has accepted responsibility yet.").font(.headline)
                }

                if let outcome = incident.outcome, !outcome.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Recorded outcome").font(.caption.bold())
                        Text(outcome).fixedSize(horizontal: false, vertical: true)
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.background, in: RoundedRectangle(cornerRadius: 12))
                }

                if incident.phase == "CONFIRMING", model.checkinAvailable, model.incident?.id == incident.id {
                    Text("Use I NEED HELP to request help. Tap I DON'T NEED HELP below to explicitly cancel this check-in.")
                        .font(.subheadline)
                    Button(model.cancelling ? "CANCELLING…" : "I DON'T NEED HELP") {
                        Task { await model.cancelCurrentCheckin() }
                    }.font(.headline).buttonStyle(.borderedProminent).controlSize(.large).tint(.blue)
                        .disabled(model.cancelling)
                    if let deadline = incident.checkinDeadline {
                        Text("Response deadline: \(Date(timeIntervalSince1970: deadline / 1000), style: .time)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let deadline = incident.progressDeadline {
                    Text("\(model.checkinAvailable ? "Next progress deadline" : "Last reported progress deadline"): \(Date(timeIntervalSince1970: deadline / 1000), style: .time)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(incident.evidence.summary).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Incident \(incident.id)").font(.caption.monospaced()).foregroundStyle(.secondary)
            } else if model.checkinAvailable {
                Label("No active incident", systemImage: "bell")
                    .font(.title2.bold()).accessibilityAddTraits(.isHeader)
                Text("The controller has no active incident to report. You can request help at any time.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
    }

    private func phasePresentation(_ phase: String) -> (title: String, explanation: String, symbol: String, color: Color) {
        switch phase {
        case "DETECTED":
            return ("Possible incident detected", "A possible incident was reported. LIFELINE is opening a check-in.", "exclamationmark.circle", .orange)
        case "CONFIRMING":
            return ("Do you need help?", "A possible fall was detected. Without an explicit cancellation, LIFELINE will request help from approved responders.", "questionmark.circle.fill", .orange)
        case "HELP_REQUESTED":
            return ("Help requested", "LIFELINE is trying to reach approved responders. Sending an alert does not confirm that someone has accepted.", "bell.badge.fill", .red)
        case "ACKNOWLEDGED":
            return ("Responder accepted", "The assigned responder accepted responsibility. Departure has not been confirmed.", "person.crop.circle.badge.checkmark", .blue)
        case "RESPONDER_EN_ROUTE":
            return ("Responder on the way", "The assigned responder reported that they are on their way.", "figure.walk", .blue)
        case "ON_SCENE":
            return ("Responder reported arrival", "The assigned responder reported arrival. An outcome still needs to be recorded.", "person.crop.circle.fill", .blue)
        case "RESOLVED":
            return ("Outcome recorded", "The on-scene responder closed this incident with the outcome below.", "doc.text.fill", .primary)
        case "CANCELLED_FALSE_ALARM":
            return ("Check-in closed", "This check-in was cancelled. Closure is not a medical assessment.", "bell.slash", .primary)
        default:
            return ("Incident update", "An incident was reported. Waiting for a recognized progress update.", "info.circle", .secondary)
        }
    }
}

struct CheckinResponse: Decodable {
    let incident: PhoneIncident?
    let responders: [PhoneResponder]?
    let policy: PhoneCheckinPolicy?
}
struct PhoneCheckinPolicy: Decodable {
    let demoMode: Bool
    let checkinMs: Double
    let configuredCheckinMs: Double
}
struct PhoneResponder: Decodable { let id: String; let name: String }
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

/// Foreground communication companion; wearable sensing and voice are external.
@MainActor final class CommunicationModel: ObservableObject {
    @Published var host = UserDefaults.standard.string(forKey: "lifeline.host") ?? "" {
        didSet { UserDefaults.standard.set(host, forKey: "lifeline.host") }
    }
    @Published var token = UserDefaults.standard.string(forKey: "lifeline.token") ?? "" {
        didSet { UserDefaults.standard.set(token, forKey: "lifeline.token") }
    }
    @Published var sessionActive = false
    @Published var status = "Enter the Mac address and pairing token."
    @Published var incident: PhoneIncident?
    @Published var checkinStatus = "Incident updates are fetched when communication starts."
    @Published var checkinAvailable = false
    @Published var cancelling = false
    @Published var requestingHelp = false
    @Published var responders: [PhoneResponder] = []
    @Published var checkinPolicy: PhoneCheckinPolicy?

    private let controllerSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 4
        configuration.timeoutIntervalForResource = 6
        configuration.waitsForConnectivity = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()
    private var timer: Timer?
    private var sessionEpoch = UUID()
    private var pollingId: UUID?
#if DEBUG
    private var developerLaunchHandled = false
#endif

    var ownerName: String {
        guard let owner = incident?.ownerId else { return "Not assigned" }
        return responders.first(where: { $0.id == owner })?.name ?? owner
    }
    var demoPolicyExplanation: String? {
        guard checkinAvailable, let policy = checkinPolicy, policy.demoMode,
              policy.checkinMs.isFinite, policy.checkinMs > 0,
              policy.configuredCheckinMs.isFinite, policy.configuredCheckinMs > 0 else { return nil }
        let seconds = String(format: "%g", policy.checkinMs / 1000)
        let configuredSeconds = String(format: "%g", policy.configuredCheckinMs / 1000)
        return "Demo timeout accelerated from configurable policy value: \(seconds) seconds (configured window: \(configuredSeconds) seconds). Responses do not extend the active deadline."
    }

    var relayHost: String {
#if DEBUG
        if let override = ProcessInfo.processInfo.environment["LIFELINE_RELAY_HOST"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !override.isEmpty {
            return override
        }
#endif
        return host.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func startForDeveloperLaunchIfRequested() {
#if DEBUG
        guard !developerLaunchHandled else { return }
        developerLaunchHandled = true
        // Retain the existing developer launch flag; it now starts communication only.
        if ProcessInfo.processInfo.environment["LIFELINE_START_MONITORING"] == "1" { start() }
#endif
    }

    private func url(_ path: String) -> URL? {
        var components = URLComponents()
        components.scheme = "http"
        let address = relayHost
        components.host = address.contains(":") && !address.hasPrefix("[") ? "[\(address)]" : address
        components.port = 8877
        components.path = path
        return components.url
    }

    func start() {
        guard !sessionActive else { return }
        guard !relayHost.isEmpty, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              url("/api/checkin") != nil else {
            status = "Enter a valid Mac hostname/IP and development pairing token."
            return
        }
        sessionActive = true
        sessionEpoch = UUID()
        status = "Communication session started. Fetching incident updates."
        checkinStatus = "Connecting to the incident controller."
        UIApplication.shared.isIdleTimerDisabled = true
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.pollCheckin() }
        }
        Task { await pollCheckin() }
    }

    private func authenticatedRequest(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest? {
        guard let endpoint = url(path) else { return nil }
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
        guard sessionActive, pollingId == nil, let request = authenticatedRequest("/api/checkin") else { return }
        let epoch = sessionEpoch
        let id = UUID()
        pollingId = id
        defer { if pollingId == id { pollingId = nil } }
        do {
            let (data, response) = try await controllerSession.data(for: request)
            guard sessionActive, sessionEpoch == epoch else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                incident = nil
                checkinAvailable = false
                let code = (response as? HTTPURLResponse)?.statusCode
                checkinStatus = code == 401 || code == 403
                    ? "Incident updates rejected (HTTP \(code ?? 0)). Verify the pairing token."
                    : "Incident updates unavailable (HTTP \(code ?? 0)). Verify the relay service."
                return
            }
            let checkin: CheckinResponse
            do { checkin = try JSONDecoder().decode(CheckinResponse.self, from: data) }
            catch { throw CheckinResponseError.unreadable }
            incident = checkin.incident
            checkinAvailable = true
            responders = checkin.responders ?? []
            checkinPolicy = checkin.policy
            status = "Communication session connected to the relay on port 8877."
            checkinStatus = "Connected to the incident controller."
        } catch {
            guard sessionActive, sessionEpoch == epoch else { return }
            incident = nil
            checkinAvailable = false
            let reason = error is CheckinResponseError ? "Relay returned unreadable incident state (HTTP 200)." : networkExplanation(error)
            checkinStatus = "Incident updates unavailable. \(reason) Current incident state is unknown."
        }
    }

    func cancelCurrentCheckin() async {
        guard sessionActive, checkinAvailable, let current = incident,
              current.phase == "CONFIRMING", !cancelling,
              let body = try? JSONSerialization.data(withJSONObject: ["type": "cancel", "incidentId": current.id, "checkinId": current.checkinId]),
              let request = authenticatedRequest("/api/commands", method: "POST", body: body) else { return }
        cancelling = true
        checkinStatus = "Explicit cancellation sent. Waiting for controller confirmation."
        let epoch = sessionEpoch
        defer { cancelling = false }
        do {
            let (_, response) = try await controllerSession.data(for: request)
            guard sessionActive, sessionEpoch == epoch else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                checkinStatus = "Cancellation was rejected or this check-in changed. Refreshing."
                await pollCheckin()
                return
            }
            checkinAvailable = false
            checkinStatus = "Cancellation accepted by the controller. Refreshing incident state."
            await pollCheckin()
        } catch {
            guard sessionActive, sessionEpoch == epoch else { return }
            checkinAvailable = false
            checkinStatus = "Cancellation result is unknown. Reconnecting to check the controller."
            await pollCheckin()
        }
    }

    func requestManualHelp() async {
        guard !requestingHelp else { return }
        if !sessionActive { start() }
        guard sessionActive, let body = try? JSONSerialization.data(withJSONObject: [
            "type": "trigger", "kind": "manual", "summary": "Wearer explicitly pressed I NEED HELP on the iPhone communication companion."
        ]), let request = authenticatedRequest("/api/commands", method: "POST", body: body) else { return }
        requestingHelp = true
        checkinStatus = "Manual help request sent. Waiting for controller confirmation."
        let epoch = sessionEpoch
        defer { requestingHelp = false }
        do {
            let (_, response) = try await controllerSession.data(for: request)
            guard sessionActive, sessionEpoch == epoch else { return }
            checkinStatus = (response as? HTTPURLResponse)?.statusCode == 200
                ? "The controller accepted your manual help request. Waiting for responder updates."
                : "Manual help request was rejected. Check connectivity and pairing."
            await pollCheckin()
        } catch {
            guard sessionActive, sessionEpoch == epoch else { return }
            checkinAvailable = false
            checkinStatus = "Manual help result is unknown. Reconnecting to check controller state."
            await pollCheckin()
        }
    }

    // Static messages only: NSError descriptions/userInfo can contain authenticated URLs.
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
            reason = "The relay rejected the request or returned an invalid response. Check pairing and port 8877."
        case .cancelled:
            reason = "The relay request was cancelled."
        default:
            reason = "The relay network request failed."
        }
        return "\(reason) (URL error \(failure.code.rawValue))"
    }

    func stop() {
        sessionActive = false
        sessionEpoch = UUID()
        timer?.invalidate()
        timer = nil
        pollingId = nil
        incident = nil
        checkinAvailable = false
        checkinPolicy = nil
        UIApplication.shared.isIdleTimerDisabled = false
        status = "Communication session stopped. Wearable sensing remains separate."
        checkinStatus = "Communication stopped. Existing incidents remain with the controller."
    }

    func stopForBackground() {
        guard sessionActive else { return }
        stop()
        status = "App moved to the background. Return here and start communication again."
    }
}
