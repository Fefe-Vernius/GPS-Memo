# Food Reminder

A Pebble watchapp for meal and snack reminders. At each reminder's time the
watch opens the app and shows the reminder's message, and your own picture if
it has one, full screen. Upcoming reminders can also be added to the Pebble
timeline as pins.

It is not a background worker and nothing keeps running between reminders. It
uses the Pebble **Wakeup API**: the app asks the OS to launch it at the next
reminder times and then exits.

## Release Notes

### 1.0.0

- Add as many reminders as you need on the Settings page, one at a time with
  **+ Add reminder** (up to 40, the limit of the watch's storage). Each one has
  a time, the days it repeats, a message and an optional image.
- **Your own images.** Pick a photo on your phone. The settings page scales it
  to the watch screen ("Fill screen" crops, "Show whole image" adds black
  bars), dithers it to the Pebble's 64 colours (or black and white on
  Aplite/Diorite) and shows a preview of the result.
- **Full-screen alert.** At the reminder time the watch vibrates once and shows
  the time, the message and the image. Reminders less than two minutes apart
  are shown together: UP/DOWN pages through them, BACK closes the app.
- **Timeline pins** (Settings → Timeline):
  - **Pins only** (default): pins for the next 3 days appear in the timeline.
    Opening a pin offers **Show reminder**, which opens it full screen.
  - **Pins with timeline reminder notification**: also adds the timeline's
    own reminder notification, an extra buzz on top of the app's alert.
  - **Off** removes the upcoming pins this app created.
- The watch menu lists all reminders with the next scheduled one in the header;
  select one to preview it.
- No nagging or snooze yet; the alert vibrates once.

## How it works

- **Scheduling (watch).** Reminders are stored on the watch. The OS allows only
  8 pending wakeups per app, so the app schedules the next 8 reminder times
  whenever it runs, including each reminder launch, so the chain continues. It
  doesn't depend on the phone. If the watch was off at a reminder time, the OS
  shows a "missed" notification instead.
- **Images (phone).** The 4 KB of watch storage can't hold pictures, so they
  stay on the phone. When a reminder with an image opens, the watch asks the
  phone for it: about 24 KB on a Pebble Time, sent in 1.8 KB pieces. If the
  phone isn't connected, the reminder is shown with text only.
- **Timeline (phone → web).** Every time the app runs, the phone side pushes
  pins for the next 3 days to the timeline web API and deletes pins of
  reminders you removed or changed. The settings page shows the result of the
  last update.

## Project layout

- `package.json` — Pebble project manifest (UUID, platforms, message keys).
- `src/c/food_reminder.c` — watchapp: wakeup scheduling, reminder list,
  full-screen alert window, image receiving.
- `src/pkjs/index.js` — phone side: settings page (an inline `data:` URL, no
  server needed), syncing reminders to the watch, image conversion and
  transfer, timeline pins.

## Building

Same as GPS Memo, from this `food-reminder/` directory:

```
pip install pebble-tool
pebble sdk install latest
pebble build
pebble install --phone <your-phone-ip>   # or --emulator basalt
```

Then open the app's settings (gear icon) in the Pebble phone app and add
reminders. Settings can only be opened while the watch is connected, and saving
sends the reminders to the watch immediately.

## Caveats

- **Not yet built with the real SDK.** The Pebble SDK download was not
  reachable from the environment this was written in. The C code was
  type-checked against a stand-in header and the scheduling logic was run on a
  computer. The settings page and phone code were tested in Chromium with a
  simulated Pebble. Expect possible small compile fixes on the first real
  `pebble build`, and try the emulator (`--emulator basalt`) before the watch.
- **Timeline pins need a timeline service.** Pins go to
  `https://timeline-api.rebble.io` by default; it can be changed under Settings
  → Timeline → Advanced. Rebble's timeline may require a Rebble subscription,
  and sideloaded apps may not be given a timeline token. If it doesn't work,
  the error appears under "Last update". The wakeup alerts work either way.
- **Choosing an image depends on the phone app's settings view** supporting
  file pickers. Most current Android/iOS Pebble apps do. If nothing happens
  when tapping "Choose image…", that view doesn't support it.
- Emoji in messages show up on the settings page and in the timeline, but most
  are missing from the watch's fonts.
