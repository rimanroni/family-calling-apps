const env = import.meta.env

export const config = {
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '',
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '',
  roomSlug: (env.VITE_ROOM_SLUG as string | undefined)?.trim() || 'addbuz',
  roomName: (env.VITE_ROOM_NAME as string | undefined)?.trim() || 'Family Room',
  hostPhone: (env.VITE_HOST_PHONE as string | undefined)?.trim() || '+8801712345678',
  retentionHours: Number(env.VITE_RETENTION_HOURS ?? 5) || 5,
  activityTtlMinutes: Number(env.VITE_ACTIVITY_TTL_MINUTES ?? 30) || 30,
}

/** True when no Supabase project is connected - the app runs fully locally. */
export const isDemo = !config.supabaseUrl || !config.supabaseAnonKey

export const RETENTION_MS = config.retentionHours * 60 * 60 * 1000
export const ACTIVITY_TTL_MS = config.activityTtlMinutes * 60 * 1000
