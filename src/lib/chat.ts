import type { RealtimeChannel } from '@supabase/supabase-js'
import { RETENTION_MS, config } from './config'
import { supabase } from './supabase'
import type { ChatMessage } from '../types'

export interface ChatBus {
  send(message: ChatMessage): Promise<void>
  subscribe(handler: (message: ChatMessage) => void): () => void
  recent(): Promise<ChatMessage[]>
  purgeAll(): Promise<void>
  close(): void
}

export function isQuotaError(error: unknown): boolean {
  const text = String(error).toLowerCase()
  return (
    text.includes('413') ||
    text.includes('payload too large') ||
    text.includes('storage') ||
    text.includes('quota') ||
    text.includes('disk full') ||
    text.includes('insufficient')
  )
}

/** Local demo: messages live in memory + travel between tabs via BroadcastChannel. */
function localBus(): ChatBus {
  const channel = new BroadcastChannel(`addbuz:chat:${config.roomSlug}`)
  const handlers = new Set<(message: ChatMessage) => void>()
  let store: ChatMessage[] = []

  channel.onmessage = (event: MessageEvent<ChatMessage>) => {
    const message = event.data
    store = [...store.filter((item) => item.id !== message.id), message]
    handlers.forEach((handler) => handler(message))
  }

  return {
    async send(message) {
      store = [...store, message]
      channel.postMessage(message)
      // BroadcastChannel does not echo to the sender, so show it locally too.
      handlers.forEach((handler) => handler(message))
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async recent() {
      const cutoff = Date.now() - RETENTION_MS
      store = store.filter((message) => message.created_at > cutoff)
      return [...store].sort((a, b) => a.created_at - b.created_at)
    },
    async purgeAll() {
      store = []
    },
    close() {
      handlers.clear()
      channel.close()
    },
  }
}

function toMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    user_id: String(row.user_id ?? ''),
    name: String(row.name ?? 'Unknown'),
    text: String(row.text ?? ''),
    image: row.image_data ? String(row.image_data) : null,
    kind: (row.kind as ChatMessage['kind']) ?? 'text',
    created_at: Date.parse(String(row.created_at)),
  }
}

/** Production: Supabase table + Realtime INSERT events. Images are inline base64. */
function supabaseBus(): ChatBus {
  const client = supabase!
  const channel: RealtimeChannel = client
    .channel(`chat:${config.roomSlug}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => handlers.forEach((handler) => handler(toMessage(payload.new as Record<string, unknown>))),
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'messages' },
      () => void refresh(),
    )

  const handlers = new Set<(message: ChatMessage) => void>()
  let refresh: () => void = () => {}

  void channel.subscribe()

  return {
    async send(message) {
      const { error } = await client.from('messages').insert({
        id: message.id,
        room_slug: config.roomSlug,
        user_id: message.user_id,
        name: message.name,
        text: message.text,
        image_data: message.image,
        kind: message.kind,
      })
      if (error) throw error
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async recent() {
      const cutoff = new Date(Date.now() - RETENTION_MS).toISOString()
      const { data, error } = await client
        .from('messages')
        .select('*')
        .eq('room_slug', config.roomSlug)
        .gte('created_at', cutoff)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data ?? []).map((row) => toMessage(row as Record<string, unknown>))
    },
    async purgeAll() {
      const { error } = await client
        .from('messages')
        .delete()
        .eq('room_slug', config.roomSlug)
      if (error) throw error
    },
    close() {
      handlers.clear()
      void client.removeChannel(channel)
    },
  }
}

export function createChatBus(): ChatBus {
  return supabase ? supabaseBus() : localBus()
}

export function systemMessage(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    user_id: 'system',
    name: 'system',
    text,
    image: null,
    kind: 'system',
    created_at: Date.now(),
  }
}

export function noticeMessage(name: string, text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    user_id: 'notice',
    name,
    text,
    image: null,
    kind: 'notice',
    created_at: Date.now(),
  }
}
