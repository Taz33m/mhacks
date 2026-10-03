import Foundation
import CoreAudio
import AVFoundation

/// Holds the AirPods as the active audio output so CoreMotion keeps delivering.
///
/// `CMHeadphoneMotionManager` only reports while the AirPods are the system's
/// active output device. Taking a bud out of the ear — or simply letting the link
/// idle — hands output back to the built-in speakers and the motion stream stops
/// with no error: samples just stop arriving. Measured on a stationary desk setup,
/// that produced 8 interruptions in 175 seconds, including gaps of 89s, 11s and
/// 3.8s. Each multi-second reconnect also costs 20-33 degrees of false rotation
/// while Apple's fusion filter re-converges, which is enough to fire a phantom
/// swing or poison a club calibration.
///
/// Two things are needed to read motion with a bud out of the ear. This class is
/// the half that can be automated:
///
///   1. Claim the AirPods as the default output device, re-claiming periodically
///      so a reconnect is recaptured without restarting the app.
///   2. Play a continuous inaudible tone so the route does not idle out when
///      nothing else is making sound.
///
/// The other half is **Automatic Ear Detection**, which must be turned off in
/// System Settings > Bluetooth > AirPods. That setting lives on the device and is
/// not scriptable. With it on and a bud out of the ear, macOS stops publishing the
/// AirPods as an audio device at all, so there is nothing here to claim.
final class AudioRouteKeeper {

    private let nameMatch: String
    private let engine = AVAudioEngine()
    private var toneRunning = false
    private var phase: Double = 0
    private var heldDeviceID: AudioDeviceID = 0
    /// The one tone source. A new one is built per route (its format follows the device), and the old one is
    /// detached first: engine.reset() does not detach nodes, so they used to pile up on the mixer, all advancing
    /// the same phase from the audio thread.
    private var toneNode: AVAudioSourceNode?
    /// What the user had as their output before the AirPods were claimed, to hand back on release.
    private var previousOutput: AudioDeviceID = 0
    private var terminationObserver: NSObjectProtocol?

    /// Amplitude of the holding tone. -80 dBFS: inaudible in practice, but not
    /// digital silence, which some devices treat as idle and disconnect.
    private let amplitude: Double = 0.0001
    private let toneHz: Double = 220

    /// True while this process holds the route and the tone is running.
    private(set) var holding = false

    /// Also play the Mac's own sound on its built-in speakers. Holding the AirPods as the output sends every sound
    /// the Mac makes to them — the coach's voice included, into an AirPod clipped to a club. With this on, the
    /// output held is a combined (multi-output) device: the speakers, with the AirPods added, so the AirPods keep
    /// the audio route motion needs and the room still hears the Mac.
    var speakersToo = true
    static let combinedUID = "org.kinesthetic.airpods-plus-speakers"
    static let combinedName = "Kinesthetic: speakers + earbuds"

    init(nameMatch: String = "AirPods") {
        self.nameMatch = nameMatch
        // Quitting hands the output back too (NSApplication.willTerminateNotification, named so this file stays
        // free of AppKit).
        terminationObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("NSApplicationWillTerminateNotification"), object: nil, queue: .main
        ) { [weak self] _ in self?.release() }
    }

    // ---- CoreAudio device plumbing ------------------------------------------

    private static func systemObject() -> AudioObjectID {
        AudioObjectID(kAudioObjectSystemObject)
    }

    /// Devices that actually have output streams, with their names.
    private static func outputDevices() -> [(id: AudioDeviceID, name: String)] {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(systemObject(), &addr, 0, nil, &size) == noErr,
              size > 0 else { return [] }

        let count = Int(size) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(systemObject(), &addr, 0, nil, &size, &ids) == noErr
        else { return [] }

        var result: [(AudioDeviceID, String)] = []
        for id in ids {
            // Skip input-only devices.
            var streams = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreams,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr,
                  streamSize > 0 else { continue }

            var nameAddr = AudioObjectPropertyAddress(
                mSelector: kAudioObjectPropertyName,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            var cfName: CFString? = nil
            var nameSize = UInt32(MemoryLayout<CFString?>.size)
            guard withUnsafeMutablePointer(to: &cfName, { ptr -> Bool in
                AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, ptr) == noErr
            }), let name = cfName else { continue }

            result.append((id, name as String))
        }
        return result
    }

    private static func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var value: CFString? = nil
        var size = UInt32(MemoryLayout<CFString?>.size)
        let ok = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) == noErr }
        return ok ? value as String? : nil
    }

    private static func transport(_ id: AudioDeviceID) -> UInt32 {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyTransportType, mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value)
        return value
    }

    private static func device(withUID uid: String) -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var cfUID = uid as CFString
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = withUnsafeMutablePointer(to: &cfUID) {
            AudioObjectGetPropertyData(systemObject(), &addr, UInt32(MemoryLayout<CFString>.size), $0, &size, &id)
        }
        return status == noErr && id != 0 ? id : nil
    }

    private static func subDeviceUIDs(_ id: AudioDeviceID) -> [String] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioAggregateDevicePropertyFullSubDeviceList,
                                              mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var list: CFArray? = nil
        var size = UInt32(MemoryLayout<CFArray?>.size)
        let ok = withUnsafeMutablePointer(to: &list) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) == noErr }
        return ok ? (list as? [String] ?? []) : []
    }

    /// The speakers-plus-AirPods output, made once and reused (by its UID) while it holds these AirPods. The
    /// speakers are the main device, so they set the clock; the AirPods are drift-corrected against them.
    private static func combinedDevice(airPods: AudioDeviceID) -> AudioDeviceID? {
        guard let speakers = outputDevices().first(where: { transport($0.id) == kAudioDeviceTransportTypeBuiltIn }),
              let speakersUID = stringProperty(speakers.id, kAudioDevicePropertyDeviceUID),
              let airPodsUID = stringProperty(airPods, kAudioDevicePropertyDeviceUID) else { return nil }
        if let existing = device(withUID: combinedUID) {
            let subs = subDeviceUIDs(existing)
            if subs.contains(speakersUID) && subs.contains(airPodsUID) { return existing }
            AudioHardwareDestroyAggregateDevice(existing)   // made for another pair of AirPods
        }
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: combinedName,
            kAudioAggregateDeviceUIDKey: combinedUID,
            kAudioAggregateDeviceIsStackedKey: 1,          // multi-output: every sub-device plays everything
            kAudioAggregateDeviceIsPrivateKey: 0,          // public, or it could not be the system output
            kAudioAggregateDeviceMainSubDeviceKey: speakersUID,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: speakersUID],
                [kAudioSubDeviceUIDKey: airPodsUID, kAudioSubDeviceDriftCompensationKey: 1],
            ],
        ]
        var id: AudioDeviceID = 0
        return AudioHardwareCreateAggregateDevice(description as CFDictionary, &id) == noErr ? id : nil
    }

    private static func defaultOutputDevice() -> AudioDeviceID {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(systemObject(), &addr, 0, nil, &size, &id)
        return id
    }

    @discardableResult
    private static func setDefaultOutputDevice(_ id: AudioDeviceID) -> Bool {
        var device = id
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        return AudioObjectSetPropertyData(
            systemObject(), &addr, 0, nil,
            UInt32(MemoryLayout<AudioDeviceID>.size), &device) == noErr
    }

    // ---- the holding tone ----------------------------------------------------

    private func startTone() {
        guard !toneRunning else { return }
        let output = engine.outputNode
        let format = output.inputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else { return }

        let rate = format.sampleRate
        let source = AVAudioSourceNode { [weak self] _, _, frameCount, audioBufferList in
            guard let self else { return noErr }
            let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
            let step = 2.0 * Double.pi * self.toneHz / rate
            for frame in 0..<Int(frameCount) {
                let value = Float(sin(self.phase) * self.amplitude)
                self.phase += step
                if self.phase > 2.0 * Double.pi { self.phase -= 2.0 * Double.pi }
                for buffer in buffers {
                    guard let data = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
                    data[frame] = value
                }
            }
            return noErr
        }

        if let old = toneNode { engine.detach(old) }
        toneNode = source
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            toneRunning = true
        } catch {
            toneRunning = false
        }
    }

    private func restartTone() {
        if toneRunning { engine.stop(); toneRunning = false }
        // The engine binds to whatever device was default when it started, so it
        // has to be rebuilt after the route changes.
        engine.reset()
        startTone()
    }

    // ---- public API ----------------------------------------------------------

    /// Claims the route if it is not already held. Idempotent and cheap, so it can
    /// be called from an existing polling timer rather than owning one.
    /// Returns a status line only when something changed, otherwise nil.
    @discardableResult
    func claim() -> String? {
        // The AirPods themselves, never a combined device that includes them.
        guard let target = AudioRouteKeeper.outputDevices()
                .first(where: { $0.name.localizedCaseInsensitiveContains(nameMatch)
                                && AudioRouteKeeper.transport($0.id) != kAudioDeviceTransportTypeAggregate })
        else {
            if holding || heldDeviceID != 0 {
                heldDeviceID = 0
                holding = false
                if toneRunning { engine.stop(); toneRunning = false }
                return "\(nameMatch) left the audio device list. Turn off Automatic Ear "
                     + "Detection in System Settings > Bluetooth > AirPods to keep motion "
                     + "running off-ear."
            }
            return nil
        }

        let isNewDevice = target.id != heldDeviceID
        heldDeviceID = target.id
        let output = speakersToo ? (AudioRouteKeeper.combinedDevice(airPods: target.id) ?? target.id) : target.id
        let outputName = output == target.id ? target.name : "\(target.name) and this Mac's speakers"

        let current = AudioRouteKeeper.defaultOutputDevice()
        if current != output {
            // Remember the user's own choice once, not a device of ours we are replacing.
            if previousOutput == 0 && current != target.id && AudioRouteKeeper.transport(current) != kAudioDeviceTransportTypeAggregate {
                previousOutput = current
            }
            if AudioRouteKeeper.setDefaultOutputDevice(output) {
                restartTone()
                holding = toneRunning
                return "Holding \(outputName) as the audio output so motion continues off-ear."
            }
            holding = false
            return "Could not claim \(target.name) as the audio output."
        }

        if isNewDevice || !toneRunning {
            restartTone()
            holding = toneRunning
            return isNewDevice ? "Holding \(target.name) as the audio output." : nil
        }

        holding = toneRunning
        return nil
    }

    private var watching = false

    /// Calls `onChange` on the main queue the moment macOS changes the default output or the device list, so a
    /// route taken back by the speakers is reclaimed at once instead of on the next 2 s poll.
    func watch(_ onChange: @escaping () -> Void) {
        guard !watching else { return }
        watching = true
        for selector in [kAudioHardwarePropertyDefaultOutputDevice, kAudioHardwarePropertyDevices] {
            var addr = AudioObjectPropertyAddress(
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain)
            AudioObjectAddPropertyListenerBlock(AudioRouteKeeper.systemObject(), &addr, .main) { _, _ in onChange() }
        }
    }

    /// Stops the tone and gives the audio route back to the user: the output they had before, if it is still there.
    /// Called on Pause and when the app quits, so quitting no longer leaves the Mac on the AirPods-and-speakers device.
    func release() {
        if toneRunning { engine.stop(); toneRunning = false }
        if let node = toneNode { engine.detach(node); toneNode = nil }
        if previousOutput != 0, AudioRouteKeeper.outputDevices().contains(where: { $0.id == previousOutput }) {
            _ = AudioRouteKeeper.setDefaultOutputDevice(previousOutput)
        }
        previousOutput = 0
        holding = false
        heldDeviceID = 0
    }
}
