# addbuz — private family app

A small, professional family communication app. Everything is in English.

## Features

- **Rooms tab (opens first)** — the default room with **total users**, **active now**, **in voice**,
  and the live member list. Joining or leaving the voice room sends everyone an automatic chat notice.
- **Default room (Family Room)** — everyone lands in the same room. Tap **Join voice** in the chat header
  and every participant can hear and see each other while still texting.
- **Audio + video group calls** — peer-to-peer WebRTC, camera and microphone controls, a live mic level
  meter so you can confirm your voice is being picked up, and host "mute all".
- **Messaging** — text messages and compressed photos. Every message shows the sender's name and a
  colour, like Messenger, so it is always clear who is talking.
- **Join/leave notices** — everyone is notified automatically when someone enters or leaves.
- **Activity record** — who sent a message, shared a photo, joined/left, started a call, muted the mic, etc.
  This record is kept privately for **30 minutes**, then auto-deletes.
- **5-hour content expiry** — messages, photos and notices disappear automatically after 5 hours.
- **Storage guard** — if the free database reaches ~350 MB, all content is cleared, calls end, and one
  system notice explains what happened. The database becomes free again.

No OTP, no SMS, no per-message cost. The account is created **once** with only a name and phone number —
after that the app opens straight into your room on that device, with no login screen, password or code.

## Run locally (free demo)

```bash
cd addbuz
npm install
npm run dev
```

Open `http://localhost:5173`, create your account once with a name and phone number (no password, no OTP,
no validation), then:

- **Rooms** — see the default room, total users, who is active right now, and join the voice room.
- **Chat** — send messages or photos. Tap **Join voice** in the room bar to hear everyone while you
  keep texting. Try opening a second tab with a different number to see live notices and names.
- **Call** — the same default room with a full video grid; join with microphone/camera permission.
- **Activity** — see the record of who did what in the last 30 minutes.

## Connect Supabase (free plan)

1. Create a Supabase project (Free: $0, 500 MB database, 2M Realtime messages/month).
2. Authentication → Providers → enable **Anonymous Sign-Ins**.
3. Run `supabase/schema.sql` in the SQL Editor. It creates tables, RLS policies, Realtime
   publication, the 5-hour cleanup job and the storage guard job.
4. Copy `.env.example` to `.env` and fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. Run `npm run dev` or `npm run build`.

## Retention and storage

| Data | Lifetime |
| --- | --- |
| Text, photos (inline base64), join/leave notices | 5 hours |
| Room membership and events | 5 hours |
| Activity record | 30 minutes |
| Database at ~350 MB | All content purged, calls ended, one system notice |

**Accounts are never deleted.** The cleanup and storage-guard jobs only remove messages, photos, notices,
room membership and activity. `public.profiles` (and `auth.users`) are untouched, so after any wipe or
expiry everyone keeps their account and opens straight into the room. On the client the account is also
cached twice (`addbuz:user` + `addbuz:user:backup`), and a missing Supabase profile row is recreated
automatically from that cached copy instead of showing the create-account screen again.

Photos are stored inline as base64 in `messages.image_data`, so deleting a row deletes the photo too —
no separate Storage bucket can fill up. To change the window, update both `VITE_RETENTION_HOURS` and
`make_interval(hours => 5)` in `supabase/schema.sql`. Activity retention is controlled by
`VITE_ACTIVITY_TTL_MINUTES` (default 30) and `make_interval(mins => 30)` in the same file.

Supabase Free projects are paused after 7 days of inactivity; keep the project active.

## Structure

```
src/App.tsx              screens, chat, call, activity, storage-full handling
src/lib/media.ts         WebRTC audio/video mesh, mute, camera, host mute-all
src/lib/chat.ts          Supabase Realtime / BroadcastChannel chat adapter
src/lib/activity.ts      activity record adapter (30-minute retention)
src/lib/presence.ts      total users + live presence adapter
src/lib/signaling.ts     call signaling adapter
src/lib/auth.ts          one-time account creation (name + phone, no OTP)
supabase/schema.sql      tables, RLS, retention + storage guard jobs
```
