# 0018: Gmail sync, untrusted email, and confirmed changes to Google

- Status: Accepted
- Date: 2026-11-04

## Context

Phase 8 reads the user's mail, sorts and summarises it, and lets SMOI create calendar events and
Gmail drafts (FR-04, FR-05). Email is written by strangers, so it is the main prompt-injection
risk in SMOI. And `gmail.compose` technically lets Google accept a send, which SMOI must never do
(FR-05.13).

## Decisions

### Sync

1. **First sync is bounded:** `messages.list` with `q="is:unread category:primary newer_than:1d"`
   and `maxResults=50`. Messages from it are stored as already announced, so connecting doesn't
   set off a burst of alerts.
2. **Then `history.list`** from the saved historyId, filtered to unread primary inbox mail (no
   Promotions, Social, Updates or Forums labels). A 404 means the id expired: a bounded full sync
   runs again, and messages already stored are skipped by a unique index on `(user_id, gmail_id)`.
3. **Reading never changes mail.** Only `messages.get` is used; `messages.modify` (which marks as
   read) is not in the code.
4. **Alerts are handed out once, ever.** `UPDATE emails SET announced_at = now() WHERE announced_at
   IS NULL AND category = 'important' RETURNING id, received_at`: the statement that returns an
   alert also records it, so restarts, repeated polls and a second desktop can't repeat it. The
   alert holds no email content; the desktop says only "You've got an important email".

### Untrusted email

5. **The classifier has no tools and two outputs.** The email goes in as delimited data after the
   trusted instructions; the reply is read only as `category` (one of five) and `summary` (capped at
   80 words). Anything else in the reply is ignored, and an unparsable reply leaves the email
   unclassified. Summaries are shown as plain text.
6. **Nothing an email says can act.** There is no path from email content to a Google write: the
   only writes are the propose/confirm actions below, which start from the user's own command or
   click, and the user confirms each. An integration test feeds an email with injected
   instructions and a model that "obeys", and checks Google receives no write and no action row
   exists.

### Changes to Google

7. **Propose, then confirm.** Every event create, change or delete and every draft create or
   update is first stored as a `google_actions` row with what the user needs to decide (before,
   after, and overlapping events for FR-04.05). Only `POST /api/google/actions/{id}/confirm`
   applies it, exactly as shown.
8. **The action id is the idempotency key** (NFR-02.03). A claim statement moves `proposed` to
   `applying` once, so concurrent confirms apply once; an applied action returns its stored result.
   At Google's end: a new event's id is `"smoi" + action id hex` (valid base32hex), so a retry gets
   409 and SMOI reads the existing event back; a new draft carries `Message-ID:
   <smoi-{actionId}@smoi.local>`, and a retry looks it up (`rfc822msgid:`) before creating. Because
   a POST answered with 5xx may have been applied, `GoogleHttp` doesn't retry it; these checks make
   the user's next confirm safe.
9. **Drafts only, enforced in code.** `GmailClient` is the only class that talks to Gmail and has no
   send, delete, trash or modify method. `GmailSafetyTest` fails the build if such a method or API
   path appears in it, or if any other class mentions the Gmail API. Draft headers can't be injected:
   one plain recipient address, a one-line MIME-encoded subject, and a base64 body.
10. **Reminders can point at a draft** (FR-05.10). Before such a reminder fires, the desktop asks
    `POST /api/reminders/{id}/check`; if Gmail says the draft is gone (sent or deleted), the reminder
    is cancelled with `cancelled_reason = 'draft_gone'` and the user is told why. If Google can't be
    asked, the reminder fires as normal.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Gmail push notifications (Pub/Sub) | Needs a public endpoint and a Google Cloud topic; a desktop-driven poll every 2 minutes is simpler and enough. |
| Classify with structured tool calls | Giving the model a tool interface where email is in the prompt is exactly what injection exploits; plain JSON with two fields is enough. |
| Client-supplied Idempotency-Key header | The action id already identifies one confirmed change; a second key would add nothing but a way to get them out of sync. |
| Letting the model choose the event to change | Matching is done in code against the real calendar; with more than one match the user picks. |

## Consequences

- An email that arrives while the desktop is off is picked up on the next sync, via history.
- Summaries can still repeat an injected sentence as text; that is harmless because it can't act.
- Attachments are not indexed yet (FR-06.02 covers email bodies the user picks; see traceability).
