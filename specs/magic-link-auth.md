# Spec: Magic-Link Authentication

**Status:** 🟡 Ready to hand off

---

## Objective

Add a minimal authentication layer using **Supabase Auth (magic link)** so that when the app is connected to Supabase, users must sign in before accessing any page. When Supabase is not configured, the app remains fully offline and auth-free — no change from today.

**Key constraint:** The app is a static PWA with zero server components. All auth handling is client-side.

---

## UX Flow

```
User opens app
  ├─ Supabase not configured? → No auth. App works as today.
  └─ Supabase configured?
       ├─ Has valid session? → Dashboard (or whatever route they requested)
       └─ No session → /login page
            ├─ Enter email → "Send magic link"
            ├─ Email sent → "Check your inbox" + link to resend
            ├─ Code expired / error → Show error message
            └─ Click magic link → PKCE exchange → redirected back → session detected → dashboard
```

### Auth model

There is **no sign-up form**, but `shouldCreateUser: true` means the first magic-link sign-in creates the user automatically. Email access is the security gate — anyone who can access the email inbox can sign in. This is sufficient for a 2-user household.

To lock down further (invite-only): set `shouldCreateUser: false` in `AuthContext.tsx` and invite users via Supabase dashboard (Authentication → Users → Invite).

---

## Files

### New files

| File | Purpose |
|---|---|
| `src/context/AuthContext.tsx` | Auth provider, context, `useAuth` hook |
| `src/app/login/page.tsx` | Magic link form |

### Modified files

| File | Change |
|---|---|
| `src/app/layout.tsx` | Wrap children with `<AuthProvider>`, add route guard logic |
| `src/app/settings/page.tsx` | Add "Sign out" button (visible only when Supabase auth is active) |
| `specs/README.md` | Add this spec to the index |

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
  signOut: () => Promise<void>;
}
```

### Behavior

- **On mount:** Calls `supabase.auth.getSession()`. Sets up `onAuthStateChange` listener for automatic session reactivity (handles magic link redirect, token refresh, sign out).
- **Magic link redirect:** When the user clicks the magic link in their email, Supabase redirects to the app with a URL fragment containing the code. `supabase-js`'s `getSession()` call on mount automatically reads and exchanges this PKCE code — no special handling needed beyond calling `getSession()`.
- **Cleanup:** `onAuthStateChange` subscription is unsubscribed on unmount.

### Edge: Supabase not configured

`supabase` client is `null` → `state` is `'disabled'`. The auth guard and login page check this and pass through / show a message accordingly.

---

## Login Page (`/login`)

### States

| State | UI |
|---|---|
| Input | Email field + "Send magic link" button |
| Sending | Button disabled, "Sending..." |
| Success | "Check your email for the magic link." + "Send again" link after a cooldown |
| Error | Red inline error message |
| Already authenticated | Redirect to `/` |

### Layout

- Centered card, minimal branding
- No nav/header (don't want to show protected navigation to unauthenticated users)
- Full viewport height, clean background

### Accessibility

- `<label>` on email input
- `aria-live="polite"` on status messages
- Focus management on success/error

---

## Route Guard (in `layout.tsx`)

### Logic

```
if (authState === 'disabled') → <>{children}</>            // no auth, pass through
if (authState === 'loading')  → <FullPageSpinner />        // checking session
if (authState === 'unauthenticated' && pathname !== '/login') → redirect /login
if (authState === 'authenticated' && pathname === '/login') → redirect /
else → <>{children}</>
```

### Implementation

A simple `<AuthGuard>` client component rendered inside the existing root layout, wrapping `children`. The login page path is excluded from the redirect. Uses `usePathname()` from `next/navigation` to read the current route.

---

## Sign Out (Settings page)

Add a "Sign out" button in Settings, below the import/export section. Only rendered when `authState === 'authenticated'`. On click: calls `signOut()`, redirects to `/login`.

---

## Edge Cases

| Case | Behavior |
|---|---|
| **Supabase env vars missing** | `state = 'disabled'`. No login prompt. App works fully offline as today. |
| **Offline + no session** | Can't fetch session → `getSession()` errors silently. `state = 'unauthenticated'`. User sees login page with a "You appear to be offline" message. Can't sign in until online. |
| **Offline + cached session** | Supabase-js client caches the session in localStorage. `getSession()` returns it. App works. |
| **Session expires mid-use** | `onAuthStateChange` fires `SIGNED_OUT`. `state` flips to `unauthenticated`. Route guard redirects to `/login`. IndexedDB data is untouched. |
| **Magic link expired** | Supabase returns an error. Login page shows "Link expired. Try again." |
| **User refreshes on `/login`** | `getSession()` runs again. Still no session → stays on login. No flash-of-redirect. |
| **Direct navigation to protected route while unauthenticated** | Route guard catches it, redirects to `/login?redirect=/original-path`. After login, redirect back. |
| **Multiple tabs** | Supabase-js broadcasts auth events across tabs via `broadcastChannel`. Signing out in one tab reflects in all. |

---

## Dependencies

None new. `@supabase/supabase-js` is already installed. No `@supabase/auth-ui-react`.

## Config / Env

Already present:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Add to documentation:
- Supabase dashboard: add `http://localhost:3000/**` to Authentication → Redirect URLs for local dev
- For production: add the production URL
- Keep "Allow new user sign-ups" enabled in Supabase Authentication → Settings for `shouldCreateUser: true` to work

## Deferred

- Social login providers (Google, Apple, etc.)
- Password-based auth
- User profile / avatar
- Multi-user data isolation (`user_id` on tables)
