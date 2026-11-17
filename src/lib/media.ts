import type { PeerInfo, SignalMessage } from '../types'
import type { SignalBus } from './signaling'

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

const HEARTBEAT_MS = 4000
const PEER_TIMEOUT_MS = 14000

export interface MediaHooks {
  onPeers(peers: PeerInfo[], streams: Map<string, MediaStream>): void
  onLocalStream(stream: MediaStream | null): void
  onError(message: string): void
  onMutedByHost(): void
  /** 0..1 microphone loudness, sampled ~12 times per second. */
  onAudioLevel?(level: number): void
}

/**
 * Small-group mesh audio + video. Supabase Realtime / BroadcastChannel only
 * carries signaling; the actual media travels peer-to-peer over WebRTC.
 */
export class MediaEngine {
  private peers = new Map<string, PeerInfo>()
  private connections = new Map<string, RTCPeerConnection>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private remoteStreams = new Map<string, MediaStream>()
  private localStream: MediaStream | null = null
  private unsubscribe: () => void
  private timer: number | null = null
  private stopped = false
  private muted = false
  private cameraOff = true
  private audioContext: AudioContext | null = null
  private levelTimer: number | null = null

  constructor(
    private bus: SignalBus,
    private me: PeerInfo,
    private hooks: MediaHooks,
  ) {
    this.unsubscribe = bus.subscribe((message) => {
      void this.handle(message)
    })
  }

  async start(): Promise<void> {
    this.localStream = await this.getMedia()

    // If the device really has a camera, default to showing video right away.
    const videoTracks = this.localStream.getVideoTracks()
    this.cameraOff = videoTracks.length === 0
    videoTracks.forEach((track) => {
      track.enabled = !this.cameraOff
      track.onended = () => {
        this.cameraOff = true
        this.publishState()
      }
    })

    this.hooks.onLocalStream(this.localStream)
    this.startLevelMeter()
    this.bus.publish({ type: 'hello', user: this.self() })
    this.timer = window.setInterval(() => {
      this.bus.publish({ type: 'ping', user: this.self() })
      this.prune()
    }, HEARTBEAT_MS)
  }

  /** Reads the local mic so the user can see that audio is actually flowing. */
  private startLevelMeter(): void {
    if (!this.localStream || !this.hooks.onAudioLevel) return
    try {
      const context = new AudioContext()
      this.audioContext = context
      void context.resume().catch(() => {})
      const source = context.createMediaStreamSource(this.localStream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.6
      source.connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)

      this.levelTimer = window.setInterval(() => {
        if (!this.hooks.onAudioLevel) return
        analyser.getByteTimeDomainData(samples)
        let peak = 0
        for (const value of samples) {
          peak = Math.max(peak, Math.abs(value - 128) / 128)
        }
        const level = this.muted ? 0 : Math.min(1, peak * 2.2)
        this.hooks.onAudioLevel(level)
      }, 80)
    } catch {
      // Browsers without Web Audio still get working calls, just no meter.
      this.stopLevelMeter()
    }
  }

  private stopLevelMeter(): void {
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer)
    this.levelTimer = null
    void this.audioContext?.close().catch(() => {})
    this.audioContext = null
    this.hooks.onAudioLevel?.(0)
  }

  private async getMedia(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      })
    } catch {
      // No camera (or camera denied) - still allow the audio room.
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
    this.publishState()
  }

  setCameraOff(cameraOff: boolean): void {
    const tracks = this.localStream?.getVideoTracks() ?? []
    if (cameraOff && tracks.length === 0) {
      this.hooks.onError('No camera was found on this device.')
      return
    }
    this.cameraOff = cameraOff
    tracks.forEach((track) => {
      track.enabled = !cameraOff
    })
    this.publishState()
  }

  getCameraOff(): boolean {
    return this.cameraOff
  }

  hasCamera(): boolean {
    return (this.localStream?.getVideoTracks().length ?? 0) > 0
  }

  forceMuteAll(): void {
    this.bus.publish({ type: 'force-mute' })
  }

  leave(): void {
    if (this.stopped) return
    this.stopped = true
    this.bus.publish({ type: 'bye', id: this.me.id })
    if (this.timer !== null) window.clearInterval(this.timer)
    this.stopLevelMeter()
    this.unsubscribe()
    this.connections.forEach((pc) => pc.close())
    this.connections.clear()
    this.pendingIce.clear()
    this.remoteStreams.clear()
    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    this.peers.clear()
    this.hooks.onLocalStream(null)
    this.emit()
  }

  private self(): PeerInfo {
    return {
      ...this.me,
      muted: this.muted,
      cameraOff: this.cameraOff,
      lastSeen: Date.now(),
    }
  }

  private publishState(): void {
    this.me = { ...this.me, muted: this.muted, cameraOff: this.cameraOff }
    this.bus.publish({
      type: 'state',
      id: this.me.id,
      muted: this.muted,
      cameraOff: this.cameraOff,
    })
    this.emit()
  }

  private emit(): void {
    this.hooks.onPeers(
      [...this.peers.values()].filter((peer) => peer.id !== this.me.id),
      new Map(this.remoteStreams),
    )
  }

  private prune(): void {
    const now = Date.now()
    let changed = false
    this.peers.forEach((peer, id) => {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        this.removePeer(id)
        changed = true
      }
    })
    if (changed) this.emit()
  }

  private removePeer(id: string): void {
    this.peers.delete(id)
    this.remoteStreams.delete(id)
    this.connections.get(id)?.close()
    this.connections.delete(id)
    this.pendingIce.delete(id)
  }

  private ensureConnection(id: string): RTCPeerConnection {
    const existing = this.connections.get(id)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.localStream?.getTracks().forEach((track) => {
      if (this.localStream) pc.addTrack(track, this.localStream)
    })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.bus.publish({
          type: 'ice',
          from: this.me.id,
          to: id,
          candidate: event.candidate.toJSON(),
        })
      }
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.remoteStreams.set(id, stream)
      this.emit()
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.removePeer(id)
        this.emit()
      }
    }

    this.connections.set(id, pc)
    return pc
  }

  private async flushIce(id: string): Promise<void> {
    const pc = this.connections.get(id)
    const queued = this.pendingIce.get(id) ?? []
    if (!pc) return
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate)
      } catch {
        // Stale candidate - safe to ignore.
      }
    }
    this.pendingIce.delete(id)
  }

  private async offerTo(id: string): Promise<void> {
    try {
      const pc = this.ensureConnection(id)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.bus.publish({ type: 'offer', from: this.me.id, to: id, sdp: offer })
    } catch (error) {
      this.hooks.onError(`Could not connect to a peer: ${String(error)}`)
    }
  }

  private async handle(message: SignalMessage): Promise<void> {
    if (this.stopped) return

    switch (message.type) {
      case 'hello':
      case 'ping': {
        if (message.user.id === this.me.id) return
        const isNew = !this.peers.has(message.user.id)
        this.peers.set(message.user.id, { ...message.user, lastSeen: Date.now() })
        if (isNew) {
          // Deterministic rule: only the larger id sends the offer (no glare).
          if (this.me.id > message.user.id) await this.offerTo(message.user.id)
          if (message.type === 'hello') this.bus.publish({ type: 'ping', user: this.self() })
        }
        this.emit()
        break
      }
      case 'bye': {
        if (this.peers.delete(message.id)) {
          this.removePeer(message.id)
          this.emit()
        }
        break
      }
      case 'state': {
        const peer = this.peers.get(message.id)
        if (peer) {
          this.peers.set(message.id, {
            ...peer,
            muted: message.muted,
            cameraOff: message.cameraOff,
          })
          this.emit()
        }
        break
      }
      case 'force-mute': {
        if (!this.me.isHost && !this.muted) {
          this.setMuted(true)
          this.hooks.onMutedByHost()
        }
        break
      }
      case 'offer': {
        if (message.to !== this.me.id) return
        try {
          const pc = this.ensureConnection(message.from)
          await pc.setRemoteDescription(message.sdp)
          await this.flushIce(message.from)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          this.bus.publish({ type: 'answer', from: this.me.id, to: message.from, sdp: answer })
        } catch (error) {
          this.hooks.onError(`Could not answer a call: ${String(error)}`)
        }
        break
      }
      case 'answer': {
        if (message.to !== this.me.id) return
        try {
          const pc = this.connections.get(message.from)
          if (!pc) return
          await pc.setRemoteDescription(message.sdp)
          await this.flushIce(message.from)
        } catch (error) {
          this.hooks.onError(`Could not finish a call: ${String(error)}`)
        }
        break
      }
      case 'ice': {
        if (message.to !== this.me.id) return
        const pc = this.connections.get(message.from)
        if (pc?.remoteDescription) {
          try {
            await pc.addIceCandidate(message.candidate)
          } catch {
            // Ignore stale candidates.
          }
        } else {
          const list = this.pendingIce.get(message.from) ?? []
          list.push(message.candidate)
          this.pendingIce.set(message.from, list)
        }
        break
      }
    }
  }
}
