import { useCallback, useEffect, useRef, useState, type ReactNode, type ChangeEvent } from 'react'
import { MediaEngine } from './lib/media'
import { isDemo, config, RETENTION_MS, ACTIVITY_TTL_MS } from './lib/config'
import { restoreUser, signIn } from './lib/auth'
import { createSignalBus } from './lib/signaling'
import { createChatBus, isQuotaError, noticeMessage } from './lib/chat'
import type { ChatBus } from './lib/chat'
import { activity, createActivityBus } from './lib/activity'
import type { ActivityBus } from './lib/activity'
import { createPresenceBus, totalUsers } from './lib/presence'
import type { PresenceBus, PresenceUser } from './lib/presence'
import type { ActivityEvent, AppUser, ChatMessage, PeerInfo } from './types'
import './styles.css'

type Stage = 'loading' | 'login' | 'app'
type Tab = 'rooms' | 'chat' | 'call' | 'activity'

const Icon = {
  wave: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 3v18M7 7v10M17 7v10M3.5 10v4M20.5 10v4" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5" />
    </svg>
  ),
  micOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 3 21 21M9 9v3a3 3 0 0 0 5 2M15 10V5a3 3 0 0 0-5.7-1.3M5 10a7 7 0 0 0 12 4M19 10a7 7 0 0 1-.5 2.6M12 17v4" />
    </svg>
  ),
  cam: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
      <rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3z" />
    </svg>
  ),
  camOff: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round">
      <path d="M3 3 21 21M16 10l6-3v10l-3-1.5M14 6H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </svg>
  ),
  muteAll: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 3 21 21M9 9v3a3 3 0 0 0 5 2M15 10V5a3 3 0 0 0-5.7-1.3M5 10a7 7 0 0 0 12 4M19 10a7 7 0 0 1-.5 2.6M12 17v4" />
    </svg>
  ),
  leave: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M15 16l4-4-4-4M19 12H9" />
    </svg>
  ),
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" />
    </svg>
  ),
  rooms: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  ),
}

const NAME_COLORS = ['#ffb86b', '#7ce7c6', '#c9a7ff', '#ff9db4', '#8fc6ff', '#f2d07c', '#9ee7a0']
function colorFor(id: string): string {
  const sum = [...id].reduce((total, char) => total + char.charCodeAt(0), 0)
  return NAME_COLORS[sum % NAME_COLORS.length]
}

function Avatar({ name, speaking, color }: { name: string; speaking?: boolean; color?: string }) {
  return (
    <div className={`avatar ${speaking ? 'speaking' : ''}`} style={color ? { background: color } : undefined}>
      {name.slice(0, 2).toUpperCase()}
    </div>
  )
}

function WelcomeScreen({ onCreate, busy, error }: {
  onCreate: (name: string, phone: string) => void
  busy: boolean
  error: string
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const ready = name.trim().length > 0 && phone.trim().length > 0
  return (
    <div className="screen-inner welcome">
      <div className="welcome-glow" aria-hidden="true" />
      <div className="brand"><div className="brand-icon">{Icon.wave}</div><span>addbuz</span></div>
      <p className="eyebrow">One-time setup</p>
      <h1 className="headline">Welcome to your<br />family room.</h1>
      <p className="sub">
        Create your account once with your name and phone number. No password, no OTP,
        no verification — you will never be asked again on this device.
      </p>
      <form onSubmit={(event) => { event.preventDefault(); if (ready) onCreate(name, phone) }}>
        <label className="field-label" htmlFor="account-name">Your name</label>
        <input id="account-name" className="input" placeholder="e.g. Rahim Ahmed" value={name}
          onChange={(event) => setName(event.target.value)} autoComplete="name" />
        <label className="field-label" htmlFor="account-phone">Phone number</label>
        <div className="phone-input">
          <span>🇧🇩 +880</span>
          <input id="account-phone" placeholder="1712 345 678" inputMode="tel" value={phone}
            onChange={(event) => setPhone(event.target.value)} autoComplete="tel" />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!ready || busy}>
          {busy ? 'Creating account…' : 'Create account →'}
        </button>
      </form>
      <div className="trust-row">
        <span>No password</span>
        <span>No OTP</span>
        <span>No SMS</span>
      </div>
      <p className="note">You only do this once. After that addbuz opens straight into your room.</p>
    </div>
  )
}

function VideoTile({ stream, name, muted, cameraOff, local, level }: {
  stream: MediaStream | null
  name: string
  muted?: boolean
  cameraOff?: boolean
  local?: boolean
  level?: number
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream
      void ref.current.play().catch(() => {})
    }
  }, [stream])
  const hideVideo = Boolean(cameraOff) || !stream
  return (
    <div className={`tile ${local ? 'local' : ''}`}>
      {/* Always mounted so remote audio keeps playing even when the camera is off. */}
      <video ref={ref} autoPlay playsInline muted={local} />
      {hideVideo && <div className="tile-off"><Avatar name={name} /></div>}
      <span className="tile-name">{name}{muted ? ' · muted' : ''}</span>
      {local && !muted && typeof level === 'number' && (
        <span className="mic-meter" title="Microphone level">
          {Array.from({ length: 5 }, (_, index) => (
            <i key={index} className={level * 5 > index + 0.15 ? 'on' : ''} />
          ))}
        </span>
      )}
    </div>
  )
}

function Control({ label, onClick, active, danger, children }: {
  label: string
  onClick: () => void
  active?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button className={`control ${active ? 'active' : ''} ${danger ? 'danger' : ''}`} onClick={onClick}>
      <span className="control-circle">{children}</span>
      <small>{label}</small>
    </button>
  )
}

function ChatScreen({ messages, user, onSend, onImage, roomActive, roomCount, onJoinRoom, onLeaveRoom }: {
  messages: ChatMessage[]
  user: AppUser
  onSend: (text: string) => void
  onImage: (file: File) => void
  roomActive: boolean
  roomCount: number
  onJoinRoom: () => void
  onLeaveRoom: () => void
}) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length])

  const pickImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onImage(file)
    event.target.value = ''
  }

  return (
    <div className="chat">
      <header className="app-head">
        <div className="brand-icon small-brand">{Icon.wave}</div>
        <div className="head-title"><strong>{config.roomName}</strong><small>Default room · everyone can hear each other</small></div>
        <span className="ttl-badge">{config.retentionHours}h auto-delete</span>
      </header>

      <div className={`room-bar ${roomActive ? 'live' : ''}`}>
        <span className="room-status" />
        <div className="room-copy">
          <strong>{config.roomName}</strong>
          <small>
            {roomActive
              ? `${roomCount} ${roomCount === 1 ? 'person' : 'people'} in the room · voice is on`
              : 'Default room · everyone can join and hear each other'}
          </small>
        </div>
        <button className={roomActive ? 'room-join leave' : 'room-join'} onClick={roomActive ? onLeaveRoom : onJoinRoom}>
          {roomActive ? 'Leave voice' : 'Join voice'}
        </button>
      </div>

      <div className="messages">
        <div className="retention-strip">
          Messages and photos disappear automatically after {config.retentionHours} hours. Activity history is kept privately for {config.activityTtlMinutes} minutes.
        </div>
        {messages.length === 0 && (
          <div className="empty-chat">
            <div className="waiting-icon">{Icon.chat}</div>
            <strong>Start the conversation</strong>
            <p>Everyone gets a notice when someone joins. Messages and photos expire in {config.retentionHours}h.</p>
          </div>
        )}
        {messages.map((message) => {
          if (message.kind === 'system') {
            return <div className="system-line" key={message.id}>{message.text}</div>
          }
          if (message.kind === 'notice') {
            return <div className="notice-line" key={message.id}>{message.name} {message.text}</div>
          }
          const mine = message.user_id === user.id
          return (
            <div className={`bubble-row ${mine ? 'mine' : ''}`} key={message.id}>
              {!mine && <Avatar name={message.name} color="#333a4d" />}
              <div className="bubble">
                <span className="bubble-name" style={{ color: mine ? '#c9b8ff' : colorFor(message.user_id) }}>
                  {mine ? 'You' : message.name}
                </span>
                {message.image && <img src={message.image} alt="shared photo" />}
                {message.text && <p>{message.text}</p>}
                <span className="bubble-time">
                  {new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <button className="attach" onClick={() => fileRef.current?.click()} title="Send a photo">{Icon.image}</button>
        <form className="composer-form" onSubmit={(event) => {
          event.preventDefault()
          if (!text.trim()) return
          onSend(text.trim())
          setText('')
        }}>
          <input placeholder="Write a message…" value={text} onChange={(event) => setText(event.target.value)} />
          <button type="submit" className="send" disabled={!text.trim()}>{Icon.send}</button>
        </form>
      </div>
    </div>
  )
}

function CallScreen({ active, user, peers, streams, localStream, muted, cameraOff, hasCamera, audioLevel,
  onJoin, onLeave, onToggleMic, onToggleCamera, onMuteAll, onNotice }: {
  active: boolean
  user: AppUser
  peers: PeerInfo[]
  streams: Map<string, MediaStream>
  localStream: MediaStream | null
  muted: boolean
  cameraOff: boolean
  hasCamera: boolean
  audioLevel: number
  onJoin: () => void
  onLeave: () => void
  onToggleMic: () => void
  onToggleCamera: () => void
  onMuteAll: () => void
  onNotice: string
}) {
  return (
    <div className="call">
      <header className="app-head">
        <div className="brand-icon small-brand">{Icon.wave}</div>
        <div className="head-title"><strong>{config.roomName} · Call</strong>
          <small><span className="pulse" /> {active ? `${peers.length + 1} in the room` : 'Not connected'}</small></div>
        {user.isHost && <span className="host-badge">HOST</span>}
      </header>

      {!active ? (
        <div className="call-start">
          <div className="waiting-icon">{Icon.cam}</div>
          <strong>Join the default room</strong>
          <p>Everyone in {config.roomName} can hear and see each other. You can keep texting while you are in the room.</p>
          <button className="primary" onClick={onJoin}>Join the room →</button>
        </div>
      ) : (
        <>
          <div className="tiles">
            <VideoTile stream={localStream} name={`${user.name} (you)`} muted={muted}
              cameraOff={cameraOff} local level={audioLevel} />
            {peers.map((peer) => (
              <VideoTile key={peer.id} stream={streams.get(peer.id) ?? null}
                name={peer.name} muted={peer.muted} cameraOff={peer.cameraOff} />
            ))}
          </div>
          <p className={`mic-status ${muted ? 'off' : audioLevel > 0.04 ? 'live' : ''}`}>
            {muted
              ? 'Microphone is muted.'
              : audioLevel > 0.04
                ? 'Microphone is working — your voice is being picked up.'
                : 'Microphone is on. Speak to check the level meter.'}
          </p>
          {peers.length === 0 && <p className="call-hint">Others will appear here once they join. Share this app with your family.</p>}
          {onNotice && <div className="toast">{onNotice}</div>}
          <div className="controls">
            <Control label={muted ? 'Unmute' : 'Mic'} active={muted} onClick={onToggleMic}>
              {muted ? Icon.micOff : Icon.mic}
            </Control>
            <Control label={cameraOff ? 'Camera on' : 'Camera off'} active={cameraOff} onClick={onToggleCamera}>
              {cameraOff ? Icon.camOff : Icon.cam}
            </Control>
            {user.isHost && <Control label="Mute all" onClick={onMuteAll}>{Icon.muteAll}</Control>}
            <Control label="Leave" danger onClick={onLeave}>{Icon.leave}</Control>
          </div>
          {!hasCamera && <p className="restricted">No camera detected on this device — audio only.</p>}
        </>
      )}
    </div>
  )
}

function RoomsScreen({ user, activeUsers, total, callActive, onJoinRoom, onLeaveRoom, onOpenChat }: {
  user: AppUser
  activeUsers: PresenceUser[]
  total: number
  callActive: boolean
  onJoinRoom: () => void
  onLeaveRoom: () => void
  onOpenChat: () => void
}) {
  const everyone = [
    { id: user.id, name: user.name, inVoice: callActive },
    ...activeUsers.filter((item) => item.id !== user.id),
  ]
  const inVoice = everyone.filter((item) => item.inVoice)

  return (
    <div className="rooms">
      <header className="app-head">
        <div className="brand-icon small-brand">{Icon.rooms}</div>
        <div className="head-title"><strong>Rooms</strong><small>Default room, members and live activity</small></div>
      </header>

      <div className="rooms-body">
        <div className="stat-grid">
          <div className="stat-card"><span>Rooms</span><strong>1</strong></div>
          <div className="stat-card"><span>Total users</span><strong>{Math.max(total, everyone.length)}</strong></div>
          <div className="stat-card"><span>Active now</span><strong>{everyone.length}</strong></div>
          <div className="stat-card"><span>In voice</span><strong>{inVoice.length}</strong></div>
        </div>

        <div className={`room-card ${inVoice.length ? 'live' : ''}`}>
          <div className="room-card-head">
            <div className="room-card-icon">{Icon.wave}</div>
            <div className="room-card-copy">
              <strong>{config.roomName}</strong>
              <small>Default room · /{config.roomSlug}</small>
            </div>
            <span className={`room-card-dot ${inVoice.length ? 'on' : ''}`} />
          </div>
          <p className="room-card-text">
            {inVoice.length
              ? `${inVoice.length} ${inVoice.length === 1 ? 'person is' : 'people are'} in the voice room. Join to hear everyone.`
              : 'The voice room is open. Join and everyone inside can hear each other while chatting.'}
          </p>
          <div className="room-card-people">
            {inVoice.map((person) => (
              <span className="person-chip" key={person.id}>
                <Avatar name={person.name} color={colorFor(person.id)} /> {person.name}
              </span>
            ))}
            {inVoice.length === 0 && <span className="person-empty">No one is in voice yet</span>}
          </div>
          <div className="room-card-actions">
            <button className={`room-action ${callActive ? 'leave' : 'join'}`}
              onClick={callActive ? onLeaveRoom : onJoinRoom}>
              {callActive ? 'Leave voice' : 'Join voice'}
            </button>
            <button className="room-action secondary" onClick={onOpenChat}>Open chat</button>
          </div>
        </div>

        <div className="section-title">Active now</div>
        <div className="member-list">
          {everyone.map((person) => (
            <div className="member-row" key={person.id}>
              <Avatar name={person.name} color={colorFor(person.id)} />
              <div className="member-copy">
                <strong>{person.name}{person.id === user.id ? ' (you)' : ''}</strong>
                <small>{person.inVoice ? 'In the voice room' : 'Online · chatting'}</small>
              </div>
              <span className={`member-state ${person.inVoice ? 'voice' : ''}`}>
                {person.inVoice ? 'In voice' : 'Online'}
              </span>
            </div>
          ))}
        </div>
        <p className="rooms-note">Active means the app is open right now. Total users counts everyone who has signed in.</p>
      </div>
    </div>
  )
}

function ActivityScreen({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="activity">
      <header className="app-head">
        <div className="brand-icon small-brand">{Icon.history}</div>
        <div className="head-title"><strong>Activity</strong>
          <small>Private record · auto-deletes after {config.activityTtlMinutes} minutes</small></div>
      </header>
      <div className="activity-list">
        {events.length === 0 ? (
          <div className="empty-chat">
            <div className="waiting-icon">{Icon.history}</div>
            <strong>No recent activity</strong>
            <p>Message sends, photos, joins and calls are listed here for {config.activityTtlMinutes} minutes.</p>
          </div>
        ) : events.map((event) => (
          <div className="activity-row" key={event.id}>
            <div className="activity-dot" />
            <div className="activity-body">
              <strong>{event.actor}</strong> {event.action}
              {event.detail && <p>{event.detail}</p>}
            </div>
            <time>
              {new Date(event.created_at).toLocaleString([], {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            </time>
          </div>
        ))}
      </div>
    </div>
  )
}

async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const max = 720
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const data = canvas.toDataURL('image/jpeg', 0.62)
  bitmap.close()
  return data
}

export default function App() {
  const [stage, setStage] = useState<Stage>('loading')
  const [tab, setTab] = useState<Tab>('rooms')
  const [user, setUser] = useState<AppUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [activeUsers, setActiveUsers] = useState<PresenceUser[]>([])
  const [total, setTotal] = useState(0)
  const [callActive, setCallActive] = useState(false)
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [streams, setStreams] = useState<Map<string, MediaStream>>(new Map())
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [muted, setMuted] = useState(false)
  const [cameraOff, setCameraOff] = useState(false)
  const [hasCamera, setHasCamera] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [notice, setNotice] = useState('')
  const [fatalError, setFatalError] = useState('')

  const chatRef = useRef<ChatBus | null>(null)
  const activityRef = useRef<ActivityBus | null>(null)
  const presenceRef = useRef<PresenceBus | null>(null)
  const mediaRef = useRef<MediaEngine | null>(null)
  const joinSent = useRef(false)

  const record = useCallback((action: string, detail = '') => {
    if (!user) return
    const item = activity(user.name, action, detail)
    setEvents((previous) => [item, ...previous].slice(0, 100))
    void activityRef.current?.record(item).catch(() => {})
  }, [user])

  /** Joining the default room sends everyone a chat notice automatically. */
  const joinRoomVoice = useCallback(() => {
    if (!user || callActive) return
    setCallActive(true)
    record('joined the default room')
    void chatRef.current?.send(noticeMessage(user.name, 'joined the room voice.')).catch(() => {})
  }, [user, callActive, record])

  const leaveRoomVoice = useCallback(() => {
    if (!user || !callActive) return
    setCallActive(false)
    record('left the default room')
    setNotice('You left the room voice.')
    void chatRef.current?.send(noticeMessage(user.name, 'left the room voice.')).catch(() => {})
  }, [user, callActive, record])

  const handleStorageFull = useCallback(async () => {
    try {
      await chatRef.current?.purgeAll()
    } catch {
      // The scheduled database job will clean up as well.
    }
    setMessages([])
    setCallActive(false)
    setNotice('Storage limit reached — call ended and all content cleared.')
    void activityRef.current?.record(activity('System', 'storage limit reached',
      'Call ended and all messages/photos/notices were cleared.')).catch(() => {})
  }, [])

  useEffect(() => {
    void restoreUser().then((restored) => {
      setUser(restored)
      setStage(restored ? 'app' : 'login')
    })
  }, [])

  useEffect(() => {
    if (!user) return
    const bus = createActivityBus()
    activityRef.current = bus
    void bus.recent().then(setEvents).catch(() => {})
    const off = bus.subscribe((item) => setEvents((previous) => [item, ...previous].slice(0, 100)))
    return () => { off(); bus.close(); activityRef.current = null }
  }, [user])

  useEffect(() => {
    if (!user) return
    const bus = createPresenceBus({ id: user.id, name: user.name })
    presenceRef.current = bus
    const off = bus.subscribe(setActiveUsers)
    const refreshTotal = () => {
      void totalUsers().then(setTotal).catch(() => {})
    }
    refreshTotal()
    const timer = window.setInterval(refreshTotal, 60_000)
    return () => {
      off()
      window.clearInterval(timer)
      bus.close()
      presenceRef.current = null
      setActiveUsers([])
    }
  }, [user])

  useEffect(() => {
    presenceRef.current?.setInVoice(callActive)
  }, [callActive, user])

  useEffect(() => {
    if (!user) return
    const bus = createChatBus()
    chatRef.current = bus
    void bus.recent().then(setMessages).catch(() => {})

    const off = bus.subscribe((message) => {
      if (message.kind === 'system' && /storage|full|quota/i.test(message.text)) {
        void handleStorageFull()
        return
      }
      setMessages((previous) => [...previous.filter((item) => item.id !== message.id), message])
    })

    if (!joinSent.current) {
      joinSent.current = true
      record('joined the app')
      void bus.send(noticeMessage(user.name, 'joined the app.')).catch(() => {})
    }

    return () => {
      off()
      if (user) {
        record('left the app')
        void bus.send(noticeMessage(user.name, 'left the app.')).catch(() => {})
      }
      bus.close()
      chatRef.current = null
      joinSent.current = false
    }
  }, [user, handleStorageFull, record])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setMessages((previous) => previous.filter((message) => message.created_at > Date.now() - RETENTION_MS))
      setEvents((previous) => previous.filter((event) => event.created_at > Date.now() - ACTIVITY_TTL_MS))
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!callActive || !user) return
    const bus = createSignalBus(config.roomSlug)
    const engine = new MediaEngine(bus, {
      id: user.id, name: user.name, muted: false, cameraOff: false,
      isHost: user.isHost, lastSeen: Date.now(),
    }, {
      onPeers: (list, map) => { setPeers(list); setStreams(map) },
      onLocalStream: (stream) => {
        setLocalStream(stream)
        const videoTracks = stream?.getVideoTracks() ?? []
        setHasCamera(videoTracks.length > 0)
        if (stream) setCameraOff(videoTracks.length === 0)
        setAudioLevel(0)
      },
      onAudioLevel: (level) => setAudioLevel(level),
      onError: (message) => setNotice(message),
      onMutedByHost: () => {
        setMuted(true)
        setNotice('The host muted your microphone.')
      },
    })
    mediaRef.current = engine

    void engine.start().catch((caught: unknown) => {
      setFatalError(caught instanceof DOMException && caught.name === 'NotAllowedError'
        ? 'Microphone and camera permission are required. Allow access and retry.'
        : `Could not start the call: ${String(caught)}`)
    })

    return () => {
      engine.leave()
      mediaRef.current = null
      setPeers([])
      setStreams(new Map())
      setLocalStream(null)
      setAudioLevel(0)
    }
  }, [callActive, user, record])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const publish = async (message: ChatMessage) => {
    try {
      await chatRef.current?.send(message)
      setMessages((previous) => [...previous.filter((item) => item.id !== message.id), message])
      record('sent a message', message.kind === 'image' ? 'Photo shared' : 'Text message')
    } catch (caught) {
      if (isQuotaError(caught)) {
        await handleStorageFull()
      } else {
        setNotice(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }

  const handleSend = (text: string) => {
    if (!user) return
    void publish({
      id: crypto.randomUUID(), user_id: user.id, name: user.name,
      text, image: null, kind: 'text', created_at: Date.now(),
    })
  }

  const handleImage = async (file: File) => {
    if (!user) return
    if (file.size > 8 * 1024 * 1024) {
      setNotice('Please choose an image smaller than 8 MB.')
      return
    }
    try {
      const image = await compressImage(file)
      await publish({
        id: crypto.randomUUID(), user_id: user.id, name: user.name,
        text: '', image, kind: 'image', created_at: Date.now(),
      })
    } catch {
      setNotice('That image could not be processed.')
    }
  }

  const handleEnter = async (name: string, phone: string) => {
    setError(''); setBusy(true)
    try {
      const signedIn = await signIn(name, phone)
      setUser(signedIn)
      setStage('app')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <div className="phone">
        <div className="status-bar"><span>9:41</span><span>▮▮▮ ᴡɪғɪ ▰</span></div>

        {stage === 'loading' && <div className="screen-inner"><p className="sub">Loading…</p></div>}
        {stage === 'login' && (
          <WelcomeScreen onCreate={(name, phone) => void handleEnter(name, phone)} busy={busy} error={error} />
        )}
        {stage === 'app' && user && (
          <>
            <div className="pane" style={{ display: tab === 'rooms' ? 'flex' : 'none' }}>
              <RoomsScreen user={user} activeUsers={activeUsers} total={total} callActive={callActive}
                onJoinRoom={joinRoomVoice} onLeaveRoom={leaveRoomVoice} onOpenChat={() => setTab('chat')} />
            </div>
            <div className="pane" style={{ display: tab === 'chat' ? 'flex' : 'none' }}>
              <ChatScreen messages={messages} user={user} onSend={handleSend}
                onImage={(file) => void handleImage(file)}
                roomActive={callActive} roomCount={peers.length + 1}
                onJoinRoom={joinRoomVoice} onLeaveRoom={leaveRoomVoice} />
            </div>
            <div className="pane" style={{ display: tab === 'call' ? 'flex' : 'none' }}>
              {fatalError ? (
                <div className="screen-inner room-error">
                  <div className="brand-icon">{Icon.micOff}</div>
                  <h1 className="headline small">Call error</h1>
                  <p className="sub">{fatalError}</p>
                  <button className="primary" onClick={() => { setFatalError(''); setCallActive(false) }}>Retry</button>
                </div>
              ) : (
                <CallScreen
                  active={callActive} user={user} peers={peers} streams={streams}
                  localStream={localStream} muted={muted} cameraOff={cameraOff} hasCamera={hasCamera}
                  audioLevel={audioLevel}
                  onJoin={joinRoomVoice}
                  onLeave={leaveRoomVoice}
                  onToggleMic={() => {
                    const next = !muted
                    mediaRef.current?.setMuted(next)
                    setMuted(next)
                    record(next ? 'muted the microphone' : 'unmuted the microphone')
                  }}
                  onToggleCamera={() => {
                    const next = !cameraOff
                    mediaRef.current?.setCameraOff(next)
                    const actual = mediaRef.current?.getCameraOff() ?? next
                    setCameraOff(actual)
                    if (actual !== cameraOff) {
                      record(actual ? 'turned the camera off' : 'turned the camera on')
                    }
                  }}
                  onMuteAll={() => {
                    mediaRef.current?.forceMuteAll()
                    record('muted all participants')
                    setNotice('All microphones were muted.')
                  }}
                  onNotice={notice}
                />
              )}
            </div>
            <div className="pane" style={{ display: tab === 'activity' ? 'flex' : 'none' }}>
              <ActivityScreen events={events} />
            </div>
            <nav className="bottom-nav">
              <button className={tab === 'rooms' ? 'on' : ''} onClick={() => setTab('rooms')}>
                {Icon.rooms}<small>Rooms</small>
              </button>
              <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
                {Icon.chat}<small>Chat</small>
              </button>
              <button className={tab === 'call' ? 'on' : ''} onClick={() => setTab('call')}>
                {Icon.cam}<small>Call</small>
              </button>
              <button className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>
                {Icon.history}<small>Activity</small>
              </button>
            </nav>
          </>
        )}
      </div>
      <p className="footnote">
        {isDemo ? 'Demo mode · local, free, no backend' : `Supabase connected · ${config.roomSlug}`}
        {' · content expires in '}{config.retentionHours}h{' · activity expires in '}{config.activityTtlMinutes}m
      </p>
    </div>
  )
}
