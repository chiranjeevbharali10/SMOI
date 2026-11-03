# Phase 7: notes for review

## Interpretations of the design (please review)

The design file covers the frog, the bubbles and the menu panel. These Phase 7 pieces aren't in
it; each is built only from the design's tokens and existing parts:

1. **The confirm view in the panel.** After a voice command, the panel shows "I heard: …", what
   SMOI will do, and two buttons, in place of its rows. It keeps the panel's header, border,
   radius, shadow and focus outline; the buttons are the panel's 46px rows with a 2px border, the
   primary one in Frog Green. Nothing on the board was changed.
2. **"Talk to SMOI" with voice on** now uses the design's listening state, line ("Go on, I'm all
   ears. Figuratively. I have no ears.") and mood ("listening"), as the board specifies, because the
   microphone really is on. With voice off it keeps the Phase 6B line.
3. **The Tasks, Talk to SMOI and Settings screens** follow the Phase 6B dashboard style (cream
   page, `#FFFAEE` cards, Pixelify Sans headings, Nunito text).
4. **Personality presets** ("Classic SMOI", "Gentle", "Extra sassy", "Just the facts") and the
   lines for reminders, overdue tasks, indexing and saved items are written in
   `desktop/src/shared/personality.ts`. They're new copy in SMOI's voice; please read them.

## What you need to check by hand

The automated tests can't hear or speak, press global shortcuts, or watch the clock. Please check:

1. **Voice on a real microphone.** Start the sidecar (`docker compose --profile voice up -d whisper`,
   `STT_PROVIDER=whisper` in `.env`, restart the backend) and turn on Settings > Voice.
   - Press Ctrl+Alt+J: the frog shows its listening pose with the microphone chip at once, and the
     listening line appears.
   - Say "remind me to stretch in ten minutes": listening ends by itself, the frog thinks, and the
     panel shows what it heard with "Set reminder" and "Cancel". Enter sets it.
   - Press Ctrl+Alt+J and then Esc: listening stops at once; the Windows microphone indicator in the
     taskbar goes away within a second.
   - Press Ctrl+Alt+J and say nothing: after about 8 seconds SMOI says it didn't hear anything.
2. **Microphone privacy.** Turn off "Let desktop apps access your microphone" in Windows settings
   and press the shortcut: SMOI says Windows blocked the microphone and where to allow it.
3. **A taken shortcut.** Set the shortcut to one another app already uses: SMOI says it couldn't
   have it, in a pink bubble and in Settings.
4. **A reminder firing.** Set a reminder two minutes ahead in Tasks; it appears as a pink bubble
   (or a Windows notification, if chosen) within about 15 seconds of its time, with the frog
   surprised.
5. **Offline.** Stop the backend (`docker compose stop backend`), add and complete tasks, then start
   it again: the "saved on this computer" banner clears and the tasks are on the backend.
6. **Quiet hours.** Turn them on around the current time and set an overdue task: no overdue
   bubble until quiet hours end. A high-priority reminder still shows.
7. **Native notifications.** Switch "Show them as" to Windows notifications and set a reminder.

## Not measured

NFR-01.03 (task save time), NFR-01.04 (listening state within 500 ms) and NFR-09.06 (intent
accuracy) were left out of this phase at the owner's request. Their targets stay TBD.
