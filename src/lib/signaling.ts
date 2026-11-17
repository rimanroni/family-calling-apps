import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { SignalMessage } from '../types'

export interface SignalBus {
  publish(message: SignalMessage): void
  subscribe(handler: (message: SignalMessage) => void): () => void
  close(): void
}

type Handler = (message: SignalMessage) => void

/**
 * Local demo bus. BroadcastChannel works between browser tabs on the same
 * origin, so you can open 2-3 tabs and actually hear each other for free.
 */
function localBus(slug: string): SignalBus {
  const channel = new BroadcastChannel(`addbuz:${slug}`)
  const handlers = new Set<Handler>()
  channel.onmessage = (event: MessageEvent<SignalMessage>) => {
    handlers.forEach((handler) => handler(event.data))
  }
  return {
    publish: (message) => channel.postMessage(message),
    subscribe: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close: () => {
      handlers.clear()
      channel.close()
    },
  }
}

/** Production bus: Supabase Realtime Broadcast (no extra service needed). */
function supabaseBus(slug: string): SignalBus {
  const client = supabase!
  const channel: RealtimeChannel = client.channel(`room:${slug}`, {
    config: { broadcast: { self: false } },
  })

  const handlers = new Set<Handler>()
  const queue: SignalMessage[] = []
  let ready = false

  channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
    handlers.forEach((handler) => handler(payload as SignalMessage))
  })

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      ready = true
      queue.splice(0).forEach((message) => {
        void channel.send({ type: 'broadcast', event: 'signal', payload: message })
      })
    }
  })

  return {
    publish: (message) => {
      if (ready) {
        void channel.send({ type: 'broadcast', event: 'signal', payload: message })
      } else {
        queue.push(message)
      }
    },
    subscribe: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close: () => {
      handlers.clear()
      void client.removeChannel(channel)
    },
  }
}

export function createSignalBus(slug: string): SignalBus {
  return supabase ? supabaseBus(slug) : localBus(slug)
}
