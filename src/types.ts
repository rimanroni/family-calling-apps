export interface AppUser {
  id: string
  name: string
  phone: string
  isHost: boolean
}

export interface PeerInfo {
  id: string
  name: string
  muted: boolean
  cameraOff: boolean
  isHost: boolean
  lastSeen: number
}

/** Signaling only - media goes peer-to-peer over WebRTC. */
export type SignalMessage =
  | { type: 'hello'; user: PeerInfo }
  | { type: 'ping'; user: PeerInfo }
  | { type: 'bye'; id: string }
  | { type: 'offer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: 'state'; id: string; muted: boolean; cameraOff: boolean }
  | { type: 'force-mute' }

export type ChatKind = 'text' | 'image' | 'notice' | 'system'

export interface ActivityEvent {
  id: string
  actor: string
  action: string
  detail: string
  created_at: number
}

export interface ChatMessage {
  id: string
  user_id: string
  name: string
  text: string
  /** base64 data URL, stored inline so deleting the row deletes the image too */
  image: string | null
  kind: ChatKind
  created_at: number
}
