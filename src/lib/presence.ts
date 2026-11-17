import type { RealtimeChannel } from '@supabase/supabase-js'
import { config } from './config'
import { supabase } from './supabase'

export interface PresenceUser {
  id: string
  name: string
  inVoice: boolean
  lastSeen: number
}

export interface PresenceBus {
  setInVoice(inVoice: boolean): void
  subscribe(handler: (users: PresenceUser[]) => void): () => void
  close(): void
}

interface KnownUser {
  id: string
  name: string
}

const USERS_KEY = `addbuz:users:${config.roomSlug}`

/** Demo only: every name/phone that has ever signed in on this browser. */
export function rememberUser(user: KnownUser): void {
  try {
    const list = JSON.parse(localStorage.getItem(USERS_KEY) ?? '[]') as KnownUser[]
    const next = [...list.filter((item) => item.id !== user.id), user]
    localStorage.setItem(USERS_KEY, JSON.stringify(next))
  } catch {
    // Private mode without storage - counts just stay at the live total.
  }
}

export function knownUsers(): KnownUser[] {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY) ?? '[]') as KnownUser[]
  } catch {
    return []
  }
}

/** Total registered family members (Supabase profiles, or the local registry in demo). */
export async function totalUsers(): Promise<number> {
  if (!supabase) return knownUsers().length
  const { count, error } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true })
  if (error) throw error
  return count ?? 0
}

interface PresenceMessage {
  type: 'hello' | 'ping' | 'bye'
  user: PresenceUser
}

const STALE_MS = 12_000
const PING_MS = 4_000

/** Demo presence: pings over BroadcastChannel between tabs on this browser. */
function localPresence(me: KnownUser): PresenceBus {
  const channel = new BroadcastChannel(`addbuz:presence:${config.roomSlug}`)
  const handlers = new Set<(users: PresenceUser[]) => void>()
  const peers = new Map<string, PresenceUser>()
  let inVoice = false

  const snapshot = () => {
    const now = Date.now()
    peers.forEach((peer, id) => {
      if (now - peer.lastSeen > STALE_MS) peers.delete(id)
    })
    const list = [...peers.values()].sort((a, b) => a.name.localeCompare(b.name))
    handlers.forEach((handler) => handler(list))
  }

  const send = (type: PresenceMessage['type']) => {
    channel.postMessage({
      type,
      user: { id: me.id, name: me.name, inVoice, lastSeen: Date.now() },
    } satisfies PresenceMessage)
  }

  channel.onmessage = (event: MessageEvent<PresenceMessage>) => {
    const { type, user } = event.data
    if (!user || user.id === me.id) return
    if (type === 'bye') {
      peers.delete(user.id)
      snapshot()
      return
    }
    peers.set(user.id, { ...user, lastSeen: Date.now() })
    snapshot()
    if (type === 'hello') send('ping')
  }

  const timer = window.setInterval(() => {
    send('ping')
    snapshot()
  }, PING_MS)
  send('hello')

  return {
    setInVoice(next) {
      inVoice = next
      send('ping')
    },
    subscribe(handler) {
      handlers.add(handler)
      snapshot()
      return () => handlers.delete(handler)
    },
    close() {
      send('bye')
      window.clearInterval(timer)
      handlers.clear()
      channel.close()
    },
  }
}

/** Production presence: Supabase Realtime Presence, one entry per member. */
function supabasePresence(me: KnownUser): PresenceBus {
  const client = supabase!
  const channel: RealtimeChannel = client.channel(`presence:${config.roomSlug}`, {
    config: { presence: { key: me.id } },
  })
  const handlers = new Set<(users: PresenceUser[]) => void>()
  let inVoice = false

  const emit = () => {
    const state = channel.presenceState() as Record<string, Array<{ name?: string; inVoice?: boolean }>>
    const users: PresenceUser[] = Object.entries(state)
      .flatMap(([id, entries]) =>
        entries.map((entry) => ({
          id,
          name: entry.name ?? 'Member',
          inVoice: Boolean(entry.inVoice),
          lastSeen: Date.now(),
        })),
      )
    handlers.forEach((handler) => handler(users))
  }

  channel
    .on('presence', { event: 'sync' }, emit)
    .on('presence', { event: 'join' }, emit)
    .on('presence', { event: 'leave' }, emit)

  void channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') void channel.track({ name: me.name, inVoice })
  })

  return {
    setInVoice(next) {
      inVoice = next
      void channel.track({ name: me.name, inVoice })
    },
    subscribe(handler) {
      handlers.add(handler)
      emit()
      return () => handlers.delete(handler)
    },
    close() {
      handlers.clear()
      void client.removeChannel(channel)
    },
  }
}

export function createPresenceBus(me: KnownUser): PresenceBus {
  return supabase ? supabasePresence(me) : localPresence(me)
}
