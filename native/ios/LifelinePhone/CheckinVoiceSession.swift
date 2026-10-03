import Foundation
import AVFoundation
import Speech

struct CheckinIdentity: Equatable {
    let incidentId: String
    let checkinId: String
    let monitoringEpoch: String
}

/// One bounded prompt/listen/reply session. The backend owns every decision.
@MainActor final class CheckinVoiceSession: NSObject, ObservableObject {
    @Published private(set) var status = "Speech is checked when monitoring starts."
    @Published private(set) var transcript = ""
    @Published private(set) var transcriptIsFinal = false
    @Published private(set) var isListening = false

    var onFinalTranscript: ((CheckinIdentity, String) -> Void)?
    var onInvalidated: (() -> Void)?
    private(set) var identity: CheckinIdentity?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private let synthesizer = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var utterance: AVSpeechUtterance?
    private enum SpeechPurpose { case prompt, acknowledgement }
    private var utterancePurpose: SpeechPurpose?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var permissionTask: Task<Bool, Never>?
    private var preparationTask: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    private var attemptTimer: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var deadline = Date.distantPast
    private var attemptId: UUID?
    private var attempts = 0
    private var tapInstalled = false
    private var suspended = false
    private let maximumAttempts = 2
    private let prompt = "I detected a possible fall. Do you need help? You can say I need help, or tap I don't need help to cancel."
    private var sessionPrompt = ""
    private let positiveAcknowledgement = "Glad you're okay. To close this check-in, tap 'I DON'T NEED HELP' on your phone."

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func refreshPermissionState() {
        permissionTask?.cancel()
        permissionTask = nil
    }

    @discardableResult func preparePermissions() async -> Bool {
        if let permissionTask { return await permissionTask.value }
        let task = Task { @MainActor [weak self] in
            guard let self else { return false }
            guard let recognizer = self.recognizer, recognizer.supportsOnDeviceRecognition else {
                if self.identity == nil { self.status = "On-device English speech is unavailable. Use the explicit controls." }
                return false
            }
            let speechAllowed: Bool
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: speechAllowed = true
            case .notDetermined:
                let authorization = await withCheckedContinuation { continuation in
                    SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
                }
                speechAllowed = authorization == .authorized
            default: speechAllowed = false
            }
            guard speechAllowed else {
                if self.identity == nil { self.status = "Speech permission denied. Enable Speech Recognition in Settings or use the controls." }
                return false
            }
            let microphoneAllowed = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard !Task.isCancelled else { return false }
            if self.identity == nil {
                self.status = microphoneAllowed ? "On-device speech ready; microphone stays off until the prompt finishes."
                    : "Microphone permission denied. Enable Microphone in Settings or use the controls."
            }
            return microphoneAllowed
        }
        permissionTask = task
        return await task.value
    }

    func isCurrent(_ expected: CheckinIdentity) -> Bool {
        identity == expected && !suspended && Date() < deadline
    }

    func begin(_ expected: CheckinIdentity, deadline: Date, audioRequest: URLRequest?, demoMode: Bool = false) {
        cancel(reason: "Preparing the current check-in.")
        guard deadline.timeIntervalSinceNow > 0 else { status = "Check-in deadline passed; waiting for controller state."; return }
        identity = expected
        self.deadline = deadline
        sessionPrompt = demoMode ? "I detected a possible fall. Are you okay?" : prompt
        transcript = ""
        transcriptIsFinal = false
        attempts = 0
        status = "Preparing check-in audio. Microphone is off."
        deadlineTask = Task { @MainActor [weak self] in
            let delay = max(0, deadline.timeIntervalSinceNow)
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            guard let self, self.identity == expected else { return }
            self.cancel(reason: "Check-in deadline passed. Voice stopped; the controller determines escalation.")
        }
        preparationTask = Task { @MainActor [weak self] in
            guard let self else { return }
            // Permission dialogs happen during setup where possible, and are
            // bounded by the incident deadline when a check-in is already active.
            let permissionGranted = await self.preparePermissions()
            guard self.isCurrent(expected), !Task.isCancelled else { return }
            do {
                let audio = AVAudioSession.sharedInstance()
                if permissionGranted {
                    try audio.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                    try audio.setActive(true)
                    try audio.overrideOutputAudioPort(.speaker)
                } else {
                    try audio.setCategory(.playback, mode: .spokenAudio)
                    try audio.setActive(true)
                }
                if let audioRequest {
                    let (data, response) = try await URLSession.shared.data(for: audioRequest)
                    guard self.isCurrent(expected), !Task.isCancelled else { return }
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    let player = try AVAudioPlayer(data: data)
                    player.delegate = self
                    player.prepareToPlay()
                    self.player = player
                    if player.play() {
                        self.status = "Playing the ElevenLabs check-in. Microphone is off."
                        return
                    }
                    self.player = nil
                }
            } catch {
                guard self.isCurrent(expected), !Task.isCancelled else { return }
            }
            self.playNativePrompt(expected)
        }
    }

    private func playNativePrompt(_ expected: CheckinIdentity) {
        guard isCurrent(expected) else { return }
        status = "Development fallback: native iPhone prompt. Microphone is off."
        let utterance = AVSpeechUtterance(string: sessionPrompt)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        self.utterance = utterance
        utterancePurpose = .prompt
        synthesizer.speak(utterance)
    }

    private func promptFinished() {
        guard let expected = identity, isCurrent(expected) else { return }
        player = nil
        utterance = nil
        utterancePurpose = nil
        retryTask = Task { @MainActor [weak self] in
            // No audio input tap exists during either prompt. Let speaker tail
            // decay before installing the microphone tap.
            do { try await Task.sleep(nanoseconds: 450_000_000) } catch { return }
            guard let self, self.isCurrent(expected), !self.synthesizer.isSpeaking else { return }
            await self.startListening(expected)
        }
    }

    private func startListening(_ expected: CheckinIdentity) async {
        guard isCurrent(expected), attempts < maximumAttempts, deadline.timeIntervalSinceNow > 1.5 else { return }
        let allowed = await preparePermissions()
        guard isCurrent(expected), !Task.isCancelled else { return }
        guard allowed, let recognizer, recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            status = "On-device speech or permission is unavailable. The incident remains open; use the explicit controls."
            return
        }
        guard player?.isPlaying != true, !synthesizer.isSpeaking else { return }
        attempts += 1
        let captureId = UUID()
        attemptId = captureId
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .confirmation
        recognitionRequest = request
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker])
            try audio.setActive(true)
            if let builtIn = audio.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try audio.setPreferredInput(builtIn)
            }
            try audio.overrideOutputAudioPort(.speaker)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw VoiceFailure.noMicrophone }
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            tapInstalled = true
            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                Task { @MainActor in self?.received(result, error: error, expected: expected, captureId: captureId) }
            }
            engine.prepare()
            try engine.start()
            isListening = true
            status = "Listening on this iPhone (on-device English), attempt \(attempts)/\(maximumAttempts)."
            let window = max(0.1, min(6, deadline.timeIntervalSinceNow - 1.5))
            attemptTimer = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: UInt64(window * 1_000_000_000)) } catch { return }
                guard let self, self.isCurrent(expected), self.attemptId == captureId else { return }
                self.stopCapture(endAudio: true)
                self.status = "Finishing on-device transcription; partial words are not submitted."
                do { try await Task.sleep(nanoseconds: 1_300_000_000) } catch { return }
                guard self.isCurrent(expected), self.attemptId == captureId else { return }
                self.closeAttempt()
                self.retryIfPossible(expected, message: "No final speech result. The incident remains open.")
            }
        } catch {
            closeAttempt()
            retryIfPossible(expected, message: "Microphone capture failed. The incident remains open.")
        }
    }

    private func received(_ result: SFSpeechRecognitionResult?, error: Error?, expected: CheckinIdentity, captureId: UUID) {
        guard isCurrent(expected), attemptId == captureId else { return }
        if let result {
            transcript = result.bestTranscription.formattedString
            transcriptIsFinal = result.isFinal
            if result.isFinal {
                let final = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                closeAttempt()
                guard !final.isEmpty else {
                    retryIfPossible(expected, message: "No final words recognized. The incident remains open.")
                    return
                }
                status = "Sending final on-device transcript to the controller."
                onFinalTranscript?(expected, final)
                return
            }
        }
        if error != nil {
            closeAttempt()
            retryIfPossible(expected, message: "On-device recognition ended without a final result. The incident remains open.")
        }
    }

    func receivedDecision(_ decision: String, expected: CheckinIdentity) {
        guard isCurrent(expected) else { return }
        switch decision {
        case "help_requested": cancel(reason: "The controller requested help. Waiting for responder updates.")
        case "confirmation_required":
            acknowledgePositiveReply(expected)
        default:
            retryIfPossible(expected, message: "The reply was ambiguous. The incident remains open.")
        }
    }

    private func acknowledgePositiveReply(_ expected: CheckinIdentity) {
        guard isCurrent(expected) else { return }
        // Remove the microphone tap and any queued retry before speaking. Keep
        // identity, attempts, and the original deadline timer unchanged.
        stopActivities()
        guard isCurrent(expected) else { return }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playback, mode: .spokenAudio)
            try audio.setActive(true)
        } catch {
            status = "Native acknowledgement unavailable. Tap I DON'T NEED HELP to close this check-in; your spoken reply has not cancelled it."
            return
        }
        guard isCurrent(expected) else {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            return
        }
        status = "Native iPhone acknowledgement. Microphone is off; explicit phone cancellation is still required."
        let utterance = AVSpeechUtterance(string: positiveAcknowledgement)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        self.utterance = utterance
        utterancePurpose = .acknowledgement
        synthesizer.speak(utterance)
    }

    func submissionUnavailable(_ expected: CheckinIdentity) {
        guard isCurrent(expected) else { return }
        status = "Voice submission could not be confirmed. Use the controls; the incident remains open."
    }

    private func retryIfPossible(_ expected: CheckinIdentity, message: String) {
        status = message
        guard isCurrent(expected), attempts < maximumAttempts, deadline.timeIntervalSinceNow > 2 else { return }
        retryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 450_000_000) } catch { return }
            guard let self, self.isCurrent(expected) else { return }
            await self.startListening(expected)
        }
    }

    private func stopCapture(endAudio: Bool) {
        engine.stop()
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        if endAudio { recognitionRequest?.endAudio() }
        isListening = false
    }

    private func closeAttempt() {
        attemptId = nil
        attemptTimer?.cancel()
        attemptTimer = nil
        stopCapture(endAudio: true)
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
    }

    func suspendForConnection(reason: String) {
        guard identity != nil else { status = reason; return }
        suspended = true
        stopActivities()
        status = reason
        onInvalidated?()
    }

    func resumeAfterConnection(_ expected: CheckinIdentity) {
        guard identity == expected, suspended else { return }
        guard Date() < deadline else {
            cancel(reason: "Original check-in deadline passed. Voice stopped; waiting for controller state.")
            return
        }
        suspended = false
        guard attempts < maximumAttempts, deadline.timeIntervalSinceNow > 1.5 else {
            status = "Connection recovered, but the original voice budget is exhausted. Use the explicit controls."
            return
        }
        status = "Connection recovered. Resuming listening without replaying the prompt."
        retryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 450_000_000) } catch { return }
            guard let self, self.isCurrent(expected) else { return }
            await self.startListening(expected)
        }
    }

    func cancel(reason: String) {
        identity = nil
        suspended = false
        deadlineTask?.cancel(); deadlineTask = nil
        stopActivities()
        status = reason
        onInvalidated?()
    }

    private func stopActivities() {
        preparationTask?.cancel(); preparationTask = nil
        retryTask?.cancel(); retryTask = nil
        closeAttempt()
        player?.stop(); player = nil
        utterance = nil
        utterancePurpose = nil
        synthesizer.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private enum VoiceFailure: Error { case noMicrophone }
}

extension CheckinVoiceSession: AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, self.player === player, let expected = self.identity, self.isCurrent(expected) else { return }
            if flag { self.promptFinished() } else { self.player = nil; self.playNativePrompt(expected) }
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, self.player === player, let expected = self.identity, self.isCurrent(expected) else { return }
            self.player = nil
            self.playNativePrompt(expected)
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.utterance === utterance, let expected = self.identity, self.isCurrent(expected) else { return }
            switch self.utterancePurpose {
            case .acknowledgement:
                self.utterance = nil
                self.utterancePurpose = nil
                self.status = "Tap I DON'T NEED HELP to close this check-in. Your spoken reply has not cancelled it."
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            default: self.promptFinished()
            }
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.utterance === utterance else { return }
            switch self.utterancePurpose {
            case .acknowledgement:
                self.cancel(reason: "Native acknowledgement interrupted. Use the explicit controls; no cancellation was confirmed.")
            default: self.cancel(reason: "Prompt was interrupted. Voice stopped; use the explicit controls.")
            }
        }
    }
}
