import { ACTIVITY_TTL_MS, config } from './config'
import { supabase } from './supabase'
import type { ActivityEvent } from '../types'

export interface ActivityBus {
  record(event: ActivityEvent): Promise<void>
  recent(): Promise<ActivityEvent[]>
  subscribe(handler: (event: ActivityEvent) => void): () => void
  close(): void
}

const DEMO_KEY = `addbuz:activity:${config.roomSlug}`

function fromRow(row: Record<string, unknown>): ActivityEvent {
  return {
    id: String(row.id),
    actor: String(row.actor ?? ''),
    action: String(row.action ?? ''),
    detail: String(row.detail ?? ''),
    created_at: Date.parse(String(row.created_at)),
  }
}

/** Demo: kept in localStorage so history survives a reload. */
function localBus(): ActivityBus {
  const channel = new BroadcastChannel(`addbuz:activity:${config.roomSlug}`)
  const handlers = new Set<(event: ActivityEvent) => void>()

  const load = (): ActivityEvent[] => {
    try {
      return JSON.parse(localStorage.getItem(DEMO_KEY) ?? '[]') as ActivityEvent[]
    } catch {
      return []
    }
  }

  const cutoff = () => Date.now() - ACTIVITY_TTL_MS

  channel.onmessage = (event: MessageEvent<ActivityEvent>) => {
    handlers.forEach((handler) => handler(event.data))
  }

  return {
    async record(item) {
      const keep = load().filter((entry) => entry.id !== item.id && entry.created_at > cutoff())
      const next = [...keep, item].slice(-200)
      localStorage.setItem(DEMO_KEY, JSON.stringify(next))
      channel.postMessage(item)
    },
    async recent() {
      const edge = cutoff()
      const kept = load().filter((entry) => entry.created_at > edge)
      localStorage.setItem(DEMO_KEY, JSON.stringify(kept))
      return kept.sort((a, b) => b.created_at - a.created_at).slice(0, 100)
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close() {
      handlers.clear()
      channel.close()
    },
  }
}

function supabaseBus(): ActivityBus {
  const client = supabase!
  const channel = client
    .channel(`activity:${config.roomSlug}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'activity_log' }, (payload) => {
      handlers.forEach((handler) => handler(fromRow(payload.new as Record<string, unknown>)))
    })

  const handlers = new Set<(event: ActivityEvent) => void>()
  void channel.subscribe()

  return {
    async record(item) {
      const { error } = await client.from('activity_log').insert({
        id: item.id,
        room_slug: config.roomSlug,
        actor: item.actor,
        action: item.action,
        detail: item.detail,
      })
      if (error) throw error
    },
    async recent() {
      const edge = new Date(Date.now() - ACTIVITY_TTL_MS).toISOString()
      const { data, error } = await client
        .from('activity_log')
        .select('*')
        .eq('room_slug', config.roomSlug)
        .gte('created_at', edge)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) throw error
      return (data ?? []).map((row) => fromRow(row as Record<string, unknown>))
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close() {
      handlers.clear()
      void client.removeChannel(channel)
    },
  }
}

export function createActivityBus(): ActivityBus {
  return supabase ? supabaseBus() : localBus()
}

export function activity(actor: string, action: string, detail = ''): ActivityEvent {
  return {
    id: crypto.randomUUID(),
    actor,
    action,
    detail,
    created_at: Date.now(),
  }
}
