# 0003: Stateless JWT auth with Spring Security's resource server

- Status: Accepted
- Date: 2026-11-02

## Context

The desktop app (Electron) calls the backend API. We need register, login and protected
endpoints, and the authenticated user id must be trustworthy because every query filters by it.

## Decision

- `POST /api/auth/register` stores a BCrypt hash. Emails are normalized to lowercase and are
  unique among active (not soft-deleted) users.
- `POST /api/auth/login` returns a short-lived (default 1 h) **HS256-signed JWT** whose `sub`
  claim is the user id.
- Tokens are verified by **Spring Security's OAuth2 resource server**, which uses the Nimbus JOSE library that Spring
  already depends on. Only HS256 is accepted, and the issuer and expiry are checked.
- The signing key comes from `JWT_SECRET` in `.env`. Startup fails if the key is missing, is not Base64, or is
  shorter than 32 bytes.
- Login returns the same 401 message for an unknown email and a wrong password, and runs
  BCrypt in both cases so response timing does not reveal which emails are registered.

## Alternatives rejected

- **A hand-written JWT filter using jjwt.** This adds another library and custom security code to
  maintain. The resource server already handles parsing, signature checks, expiry and error responses.
- **Server-side sessions with cookies.** These need CSRF protection and session storage, and they fit
  a desktop API client less well. This could be revisited if instant token revocation becomes a requirement.
- **RS256 (asymmetric keys).** This is only useful when other services verify tokens without being able to
  issue them. There is one service today. If that changes, switching only affects the encoder and decoder beans.
- **An external identity provider (Keycloak, Auth0).** It's more infrastructure than a single-user desktop
  companion needs, and it hides the auth flow this project is meant to demonstrate.

## Consequences

- A token cannot be revoked before it expires. Short lifetimes limit the damage. Refresh tokens
  and logout or revocation are deferred to Phase 5 (security).
- Rotating `JWT_SECRET` invalidates every issued token.
