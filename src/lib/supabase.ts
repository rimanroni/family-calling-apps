import { createClient } from '@supabase/supabase-js'
import { config, isDemo } from './config'

export const supabase = !isDemo && config.supabaseUrl && config.supabaseAnonKey
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null
