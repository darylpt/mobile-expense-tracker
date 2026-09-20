# Spec: Authentication & App Lock

**Status:** ✅ Done

> **v0.17.0 changes (Sep 2026):** Added Google OAuth as primary sign-in method
> with magic-link fallback. Added local PIN-based app lock (privacy screen) using
> PBKDF2-hashed PIN stored in localStorage. Login page redesigned with Google
> button as primary CTA. Settings gained an "App Lock" section with enable/disable/change PIN controls.

---

## Objective

Provide authentication via **Supabase Auth** (Google OAuth primary, email magic
link fallback) and a **local PIN-based app lock** for privacy. When Supabase is
not configured, the app remains fully offline and auth-free. The app lock is an
honest privacy lock — it does not encrypt data.

**Key constraint:** The app is a static PWA with zero server components. All auth
and lock handling is client-side.

---

## UX Flow

```
User opens app
  ├─ App lock enabled? → PIN screen (must unlock; works offline too)
  └─ Supabase not configured? → No auth. App works offline.
  └─ Supabase configured?
       ├─ Has valid session? → App lock enabled?
       │    ├─ Yes → PIN screen (must unlock to proceed)
       │    └─ No → Dashboard
       └─ No session → /login page
            ├─ Click "Continue with Google" → OAuth redirect → Supabase → return
            ├─ Enter email → "Send magic link" (invite-only, no signup)
            ├─ Email sent → "Check your inbox" + resend cooldown
            └─ Returning user with session → auto-redirect to dashboard
```

### App lock flow

```
User authenticated + lock enabled
  ├─ Show PIN screen (full-screen overlay)
  ├─ Enter correct PIN → unlock → show app content
  ├─ Enter wrong PIN → error message, retry
  └─ "Sign out instead" → sign out, go to /login

Settings → App Lock
  ├─ Enable → enter PIN → confirm PIN → saved
  ├─ Change PIN → verify old → enter new → confirm → saved
  └─ Disable → verify old → cleared
```

### Invite-only model

There is **no sign-up form**. Users are invited via the Supabase dashboard
(Authentication → Users → Invite). The login page only accepts **existing
users**.

For magic links, `shouldCreateUser: false` prevents self-registration.
For Google OAuth, Supabase does not support `shouldCreateUser` on the client.
To preserve invite-only behavior, **disable "Allow new user sign-ups"** in the
Supabase dashboard (Authentication → Providers → Settings) so that OAuth
sign-ins for unregistered emails are rejected server-side.

---

## Files

### New files

| File | Purpose |
|---|---|
| `src/components/auth/AuthGuard.tsx` | Route guard + lock gate (extracted from AuthContext) |
| `src/components/auth/PinScreen.tsx` | Full-screen numeric PIN entry overlay |

### Modified files

| File | Change |
|---|---|
| `src/context/AuthContext.tsx` | Added `signInWithOAuth`, app lock state (`isLocked`, `hasLock`, `unlock`, `setPin`, `clearPin`, `verifyPin`), PBKDF2 hashing helpers, merged lock+auth init, user identity tracking |
| `src/components/auth/AuthGuard.tsx` | Route guard: enforces lock before disabled passthrough, redirect logic |
| `src/app/login/page.tsx` | Google OAuth button (primary), magic link form (fallback), divider, returning-user copy |
| `src/app/settings/page.tsx` | New "App Lock" section with enable/disable/change PIN controls |
| `specs/README.md` | Added spec entries |
| `specs/project-spec.md` | Updated auth section, routes, version |

---

## AuthContext (`AuthContext.tsx`)

### States

| State | Meaning |
|---|---|
| `disabled` | Supabase env vars not set — no auth, app offline |
| `loading` | Checking session on mount |
| `authenticated` | Valid session exists |
| `unauthenticated` | No session |

### Exposed API

```typescript
interface AuthContextValue {
  state: 'disabled' | 'loading' | 'authenticated' | 'unauthenticated';
  user: User | null;
  signIn: (email: string) => Promise<{ error?: string }>;
  signInWithOAuth: () => Promise<{ error?: string }>;
  signOut: () => Promise<void>;

  // Local app lock
  isLocked: boolean;      // lock enabled + not yet unlocked (works even when auth is disabled)
  hasLock: boolean;        // PIN hash exists in localStorage
  unlock: (pin: string) => Promise<boolean>;
  setPin: (pin: string) => Promise<void>;
  clearPin: () => void;
  verifyPin: (pin: string) => Promise<boolean>;
}
```

### App lock storage

All stored in `localStorage`:

| Key | Value |
|---|---|
| `app-lock-hash` | PBKDF2-derived hash (base64) |
| `app-lock-salt` | 16-byte random salt (base64) |
| `app-lock-enabled` | `"true"` or absent |

**Never stores the PIN in plaintext.** Uses PBKDF2 with 100,000 iterations and
SHA-256 via `crypto.subtle`. Constant-time comparison prevents timing attacks.

### OAuth behavior

- Calls `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${window.location.origin}/login` } })`
- On success, Supabase redirects the browser to the provider
- On return, `onAuthStateChange` picks up the `SIGNED_IN` event
- If the Google provider is not configured in Supabase, the error is displayed
- If the provider returns an error (e.g. access denied), the callback URL contains `?error=` and `?error_description=` query params which are surfaced on the login page
- After OAuth sign-in, if app lock is enabled, the PIN screen is shown

### Magic link behavior (unchanged)

- Calls `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: origin } })`
- Invite-only model — no sign-up form

### Sign-out behavior

- Clears local IndexedDB data (`clearAllLocalData()`)
- Removes `lastUserId` from localStorage
- Calls `supabase.auth.signOut()`
- Resets `isLocked` to `false`

---

## Login Page (`/login`)

### Layout

1. **Title:** "Sign in"
2. **Subtitle:** "Returning users go straight to the dashboard."
3. **Google OAuth button** (primary, full-width, with Google logo)
4. **Divider** ("or")
5. **Email magic link form** (Input + "Send magic link" button)
6. **Error display** (role="alert")

### States

| State | UI |
|---|---|
| Idle | Google button + email form |
| OAuth loading | Google button shows spinner |
| Sending email | Email button disabled, "Sending..." |
| Email sent | "Check your email" + resend with 30s cooldown |
| Error | Red inline error message |
| Already authenticated | Redirect to `/` |

---

## Route Guard (`src/components/auth/AuthGuard.tsx`)

### Logic

```
if (authState === 'loading')  → <FullPageSpinner />           // checking
if (isLocked)                 → <PinScreen />                  // privacy lock (local, works offline too)
if (authState === 'disabled') → <>{children}</>               // no auth (lock enforced above)
if (unauthenticated && !/login) → navigate /login
if (authenticated && /login && !locked) → navigate /
else → <>{children}</>
```

Lock state initializes eagerly when Supabase is absent so a configured PIN
still gates the app offline. Authenticated users get lock state resolved
atomically with session to prevent a fail-open flash. User identity changes
re-engage the lock so a different user cannot inherit an unlocked state.

**Important:** Navigation uses `router.replace()` inside a `useEffect`, not
`redirect()` mid-render. The login page remains accessible when locked (user
can sign out from the PIN screen).

---

## PinScreen (`src/components/auth/PinScreen.tsx`)

Full-screen overlay with:
- Lock icon
- 6 digit indicator circles (fill as digits enter)
- Numeric keypad (0-9 + backspace)
- Keyboard input support (desktop)
- Mode-dependent title: "Set a PIN" / "Confirm your PIN" / "Enter your PIN"
- Error message for wrong PIN or mismatched confirmation
- "Sign out instead" escape hatch
- Auto-submit on 6 digits entered

### Modes

1. **setup** — first-time PIN creation (if AuthGuard detects lock enabled but no PIN set)
2. **setup-confirm** — re-enter to confirm
3. **unlock** — verify against stored hash

---

## App Lock (Settings)

### Section UI

- Status indicator (green dot = enabled, grey = disabled)
- Enable button (when disabled) → inline PIN entry + confirm
- Change PIN button (when enabled) → verify old → enter new → confirm
- Disable button (when enabled) → verify old → clear

### PIN entry in Settings

Uses `<Input type="password" inputMode="numeric">` with digit-only filtering.
Exactly 6 digits (matching PinScreen). No plaintext PIN display.

---

## Edge Cases

| Case | Behavior |
|---|---|
| **Supabase env vars missing** | `state = 'disabled'`. No login prompt. App works offline. Lock still enforced if configured (local localStorage). |
| **Google provider not configured** | OAuth error displayed: "provider is not enabled" |
| **Offline + no session** | `state = 'unauthenticated'`. Login page shown. Can't sign in. |
| **Offline + cached session** | Supabase-js caches session in localStorage. App works. |
| **Session expires mid-use** | `onAuthStateChange` fires `SIGNED_OUT`. Redirect to `/login`. |
| **Magic link expired** | Supabase error shown. User retries. |
| **User on /login with session** | Auto-redirect to `/` (unless locked) |
| **Lock enabled, refresh** | Session persisted → lock check → PIN screen |
| **Lock enabled, wrong PIN** | Error message, clear input, retry |
| **Lock enabled, sign out** | Lock state cleared, redirect to /login |
| **Lock enabled, no PIN set** | Lock screen shows setup mode |
| **Multiple tabs** | Supabase broadcasts auth events via `broadcastChannel` |
| **PIN forgotten** | "Sign out instead" → sign out → lock state cleared → can re-authenticate |

---

## Dependencies

None new. `@supabase/supabase-js` is already installed. Web Crypto API is
available in all modern browsers (no polyfill needed).

## Config / Env

Already present:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Add to Supabase dashboard:
- **Authentication → Providers → Google:** Enable and configure OAuth credentials
- **Authentication → URL Configuration:** Add the OAuth callback URL (e.g. `http://localhost:3000/login`) to Redirect URLs — the app sends Google OAuth callbacks to `${window.location.origin}/login`. Magic-link callbacks use the app origin (e.g. `http://localhost:3000`); add both URLs if you use both sign-in methods.
- **Disable "Allow new user sign-ups"** to enforce invite-only. Magic links pass `shouldCreateUser: false`; OAuth relies on the dashboard setting since `shouldCreateUser` cannot be passed to the provider.
