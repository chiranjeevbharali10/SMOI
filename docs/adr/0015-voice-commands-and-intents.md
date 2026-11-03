# 0015: Voice commands: local speech-to-text, allowlisted intents, confirm before acting

- Status: Accepted
- Date: 2026-11-03

## Context

Phase 7 adds voice (FR-03): a global shortcut starts listening, speech becomes text, the text is
classified into one intent, and SMOI acts. CLAUDE.md requires that the LLM only proposes actions
as structured output, that the backend validates them against an allowlist, and that the user
confirms consequential ones. NFR-04.02 and NFR-04.03 require that the microphone is on only after
the user asks, and that the frog shows the listening state the whole time it is.

## Decisions

### Speech-to-text: a local Whisper sidecar, behind an interface

- `SpeechToText` in the backend (`com.smoi.voice`), chosen by `smoi.stt.provider`:
  `whisper` (the sidecar) or `none` (voice off; typing still works). Nothing else names a provider.
- `sidecars/whisper`: FastAPI and faster-whisper with `Systran/faster-whisper-base.en` (pinned
  revision, about 145 MB, CPU, int8). Audio never leaves the machine, and is decoded from memory;
  neither the sidecar nor the backend stores or logs it (only its size is logged).
- The desktop records WebM/Opus with the browser's MediaRecorder; PyAV in the sidecar decodes it,
  so the desktop needs no audio encoder.

Rejected: a cloud speech API (fast, but costs money, needs a key and sends audio off the machine);
speech-to-text in the desktop (a large native model inside Electron, and the backend would lose the
provider interface); the Web Speech API (sends audio to a Google service).

### Intents: the model proposes JSON, the backend allowlists it

- `POST /api/commands/interpret` sends the command to the configured LLM with fixed instructions
  and a few examples. The command goes in the user turn, between delimiters, marked as data;
  delimiter look-alikes in it are broken up.
- `CommandParser` reads the first JSON object in the reply and trusts nothing in it: the intent must
  be one of `create_task`, `create_reminder`, `ask_brain`, `list_events`, `create_event`,
  `draft_email`, `unknown` (the `Intent` enum is the allowlist); every field is type-checked;
  priorities and repeats outside their lists fall back to defaults; anything else becomes
  `unknown`. No intent deletes, sends or changes existing data.
- The model writes local times ("2026-11-04T17:00"); the parser attaches the user's time zone, so the
  model does no time-zone arithmetic. A one-time reminder in the past becomes a plain problem
  message, not a reminder.
- Calendar and email intents are recognised but marked not available, so SMOI says "isn't available
  yet" instead of guessing (Phase 8).

### Nothing happens until the user has seen it

- The endpoint only answers with a proposal; it creates nothing.
- Spoken commands are shown in the menu panel ("I heard: …", what SMOI will do, and Confirm or
  Cancel). Enter confirms, Esc cancels, and closing the panel counts as cancel. Typed commands get the
  same card in "Talk to SMOI".
- The desktop keeps each proposal under a random id; a page can confirm only a proposal SMOI made,
  once, within 10 minutes.
- Confirming creates an ordinary task or reminder through the same store and API as the Tasks
  screen, which validates it again.
- Asking SMOI Brain is read-only, so it runs without a confirmation, but the question is shown
  exactly as understood.

### The microphone

- Only a hidden recorder page, on its own Electron session (`smoi-voice`), may use the microphone,
  and only while a recording has been started. Every other page is denied all permissions.
- Pressing the shortcut sets the listening frog at once (NFR-01.04) and then turns the microphone
  on. Recording stops 1.5 s after speech ends, after 8 s of silence, or at 30 s. Esc or the shortcut
  again stops the tracks immediately and nothing is sent (FR-03.07).
- If Windows refuses the shortcut, SMOI says so in a pink bubble and in Settings, and asks for a
  different one (FR-03.01). Voice is off by default and can be turned off entirely.

## Consequences

- Classification quality depends on the local model (qwen3.5 2B by default). NFR-09.06 (intent
  accuracy) stays TBD; the owner chose not to build the labelled intent set in this phase.
- Esc is taken globally only while SMOI is listening or working out a command.
- `base.en` is English-only; a multilingual model is a configuration change.
- Speech-to-text on CPU takes a few seconds per command; no timing is claimed until measured.
