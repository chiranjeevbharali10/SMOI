# 0017: Google OAuth in the backend, with encrypted refresh tokens

- Status: Accepted
- Date: 2026-11-04

## Context

Phase 8 connects SMOI to the user's Google Calendar and Gmail (FR-04.01, FR-05.01). SMOI needs
long-lived access (a refresh token), which is as sensitive as a password: whoever holds it can
read the user's mail. The owner's constraints: the backend handles OAuth, tokens are encrypted with
AES-GCM using a key from the environment, `invalid_grant` marks the account disconnected and asks
the user to reconnect, and disconnecting revokes the token.

## Decisions

1. **Authorization code flow with PKCE, run by the backend.** `POST /api/google/connect` returns
   Google's consent URL; the desktop opens it in the browser; Google redirects to
   `GET /api/google/callback`. The PKCE code verifier never leaves the backend, so an intercepted
   code is useless. `access_type=offline&prompt=consent` makes Google return a refresh token, also
   on reconnect.
2. **The callback is the one unauthenticated endpoint**, because the browser has no SMOI token.
   The `state` parameter is `"<userId>.<32 random bytes>"`; only its SHA-256 is stored, with the
   verifier, for 10 minutes. The callback uses it up in one `UPDATE ... RETURNING` that also checks
   the user id, so it works once, for that user only, and a replay finds nothing. This keeps the
   "every query filters by user_id" rule without a new exception.
3. **Three scopes, fixed in code** (`GoogleScopes`): `calendar.events`, `gmail.readonly`,
   `gmail.compose` (NFR-03.05). The settings screen explains each. Adding one needs an ADR.
4. **Refresh tokens are encrypted with AES-256-GCM** (`TokenCipher`): a random 12-byte IV per
   encryption, the user id as associated data (a ciphertext copied into another user's row fails to
   decrypt), and the key from `GOOGLE_TOKEN_KEY`. A `key_version` column leaves room for rotation.
   Access tokens live only in memory and are refreshed two minutes before they expire.
5. **`invalid_grant` pauses Google features, nothing else** (FR-05.12). The account is marked
   `reconnect_required`; Calendar and Gmail calls answer `409 {code: "google_reconnect"}` without
   calling Google again; stored emails, drafts and tasks stay. Reconnecting replaces the token and
   keeps the Gmail sync position, so old mail isn't announced again.
6. **Disconnect revokes at Google, then forgets.** The encrypted token is overwritten, not just
   soft-deleted. If Google can't be reached the token is still deleted locally and the user is told
   to remove access in their Google account. Deleting email data is a separate choice in the dialog.
7. **One HTTP path to Google's APIs** (`GoogleHttp`): a 401 refreshes once; 429 and rate-limit 403s
   are retried with exponential backoff, jitter and `Retry-After`; 5xx is retried except on POST,
   where Google may already have acted (see ADR 0018); a "google" circuit breaker covers outages
   (NFR-02.07). Logs carry method, path and status only: never bodies, queries or tokens.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| OAuth in the desktop app (loopback redirect) | Tokens would live on the desktop and the backend would need them anyway for sync; two places to protect instead of one. |
| Spring Security's OAuth2 client | It is built for "log in with Google" sessions, not for storing a third-party refresh token per user; hand-written code here is short and every line can be explained. |
| Storing tokens in plain text, or hashed | Plain text fails NFR-03.03; a hash can't be used to call Google. |
| AES-CBC or a key derived from the JWT secret | CBC without a MAC allows tampering; sharing the JWT key would mean one leak exposes both. |
| A scheduler that syncs every user's Gmail | It would need a query across all users (a new exception to the data-model rule). The desktop asks for a sync while it runs instead. |

## Consequences

- The owner must create a Google Cloud OAuth client and register the redirect URI.
- Losing `GOOGLE_TOKEN_KEY` means every user reconnects (tokens can't be decrypted); this is safe.
- Gmail syncs only while the desktop app is running, which matches how SMOI is used.
