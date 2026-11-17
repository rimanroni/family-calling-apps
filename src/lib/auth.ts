import { supabase } from './supabase'
import { config } from './config'
import { rememberUser } from './presence'
import type { AppUser } from '../types'

/**
 * The account is the one thing that is never deleted automatically.
 * Content (messages, photos, notices, activity) expires, and the storage guard
 * can wipe every row, but this local record stays - so the user is never asked
 * to create an account twice.
 *
 * It is stored twice on purpose: if one key is lost or overwritten, the backup
 * still restores the same account.
 */
const USER_KEY = 'addbuz:user'
const BACKUP_KEY = 'addbuz:user:backup'
const ID_PREFIX = 'addbuz:id:'

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return raw.trim()
  if (digits.startsWith('880')) return `+${digits}`
  if (digits.startsWith('0')) return `+88${digits}`
  return `+880${digits}`
}

function makeUser(id: string, name: string, phone: string): AppUser {
  return { id, name, phone, isHost: phone === config.hostPhone }
}

function cacheUser(user: AppUser): void {
  const raw = JSON.stringify(user)
  try {
    localStorage.setItem(USER_KEY, raw)
    localStorage.setItem(BACKUP_KEY, raw)
  } catch {
    // Storage blocked (private mode) - the Supabase session still restores it.
  }
  rememberUser({ id: user.id, name: user.name })
}

/** Reads the cached account from either copy, repairing the main key if needed. */
function readCachedUser(): AppUser | null {
  let main: AppUser | null = null
  try {
    const raw = localStorage.getItem(USER_KEY)
    main = raw ? (JSON.parse(raw) as AppUser) : null
  } catch {
    main = null
  }
  if (main) return main

  try {
    const raw = localStorage.getItem(BACKUP_KEY)
    if (!raw) return null
    const backup = JSON.parse(raw) as AppUser
    localStorage.setItem(USER_KEY, raw)
    return backup
  } catch {
    return null
  }
}

/**
 * No login, no password, no OTP. The account is created once with a name and
 * phone number, then restored automatically on every later visit.
 */
export async function signIn(name: string, rawPhone: string): Promise<AppUser> {
  const trimmedName = name.trim()
  const phone = normalizePhone(rawPhone.trim())
  if (!trimmedName) throw new Error('Please enter your name.')

  let id: string

  if (supabase) {
    const { data, error } = await supabase.auth.signInAnonymously()
    if (error) throw error
    if (!data.user) throw new Error('Could not create a session.')
    id = data.user.id

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ id, name: trimmedName, phone })
    if (profileError) throw profileError
  } else {
    id = localStorage.getItem(ID_PREFIX + phone) ?? crypto.randomUUID()
    localStorage.setItem(ID_PREFIX + phone, id)
  }

  const user = makeUser(id, trimmedName, phone)
  cacheUser(user)
  return user
}

export async function restoreUser(): Promise<AppUser | null> {
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    const sessionUser = data.session?.user
    const cached = readCachedUser()

    if (!sessionUser) return null

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('name, phone')
      .eq('id', sessionUser.id)
      .maybeSingle()

    if (profile) {
      const user = makeUser(sessionUser.id, profile.name, profile.phone)
      cacheUser(user)
      return user
    }

    // The profile row is gone (for example after a manual database wipe) but the
    // cached account is still here: recreate it instead of asking for the name
    // and phone again. Only rows owned by this auth user are allowed by RLS.
    if (cached && cached.id === sessionUser.id) {
      const { error: healError } = await supabase
        .from('profiles')
        .upsert({ id: sessionUser.id, name: cached.name, phone: cached.phone })
      if (!healError) {
        cacheUser(cached)
        return cached
      }
    }

    if (error && error.code !== 'PGRST116') return null
    return null
  }

  const saved = readCachedUser()
  if (!saved) return null
  cacheUser(saved)
  return saved
}
