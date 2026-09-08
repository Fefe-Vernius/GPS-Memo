# GPS Memo

A Pebble watchapp that shows the phone's raw GPS coordinates and the
current date/time, and lets you save a timestamped coordinate entry by
holding the SELECT button.

## Release Notes

### 1.1.0

- **Notification options.** A memo saved on the watch can now be pushed to an
  external service, configured under "Notifications" on the Settings page:
  - **Gotify** — enter a server address and app token; title and priority are
    optional and default to "GPS Memo" and 5.
  - **Custom curl command** — paste everything you would type after `curl ` to
    send memos anywhere else. Supports `-X`, `-H`, `-d`, `-F` and
    `--data-urlencode`, with `{{message}}`, `{{timestamp}}`, `{{lat}}` and
    `{{lon}}` placeholders.
  - **None** (the default) leaves notifications switched off.
- **Added a "Reset All Data" button** to the Settings page, clearing the saved
  entries and all notification settings at once. "Clear Log" still removes only
  the entries.
- **App icon** for the launcher and the app store listing.
- **Larger on-screen fonts** for the coordinate and status text.
- **Lower power use.** The clock now refreshes once a minute instead of once a
  second, coordinates display to 4 decimals instead of 6, and the phone only
  sends an update when the position actually changes at that resolution.
- **Fixed:** saved entries recorded the time of the last screen refresh rather
  than the moment SELECT was pressed, so timestamps could be up to a minute
  early. The exact press time is now captured, and entries keep full 6-decimal
  coordinates even though the watch displays 4.

### 1.0.0

- Initial release: coordinate display and timestamped memos saved by holding
  SELECT, with a Settings page listing the saved entries.

## What it does

- Displays the current date/time as `YYYYMMDD_Timezone_HHMMSS` (e.g.
  `20260722_CEST_143005`), refreshed once a minute to save power.
- Displays the latest latitude/longitude received from the phone's GPS
  (4 decimal places on screen), via PebbleKit JS
  `navigator.geolocation.watchPosition`.
- Holding SELECT for ~2 seconds captures the exact time of the press and
  sends it to the phone, which appends a line `TIMESTAMP  LAT, LON` to a
  log kept in the phone app's `localStorage`. Saved entries keep the full
  6-decimal coordinates regardless of what the watch displays. The watch
  vibrates and shows "Saved!" briefly to confirm.
- The watch app's Settings page (opened from the Pebble phone app) shows
  the full log in a read-only textarea, one entry per line, and lets you
  configure notifications (see Release Notes above). Buttons: "Save",
  "Send Test", "Clear Log" and "Reset All Data".

## Project layout

- `package.json` — Pebble project manifest (UUID, target platforms, message keys).
- `src/c/gps_memo.c` — watchapp source.
- `src/pkjs/index.js` — phone-side PebbleKit JS: geolocation, AppMessage
  bridge, and the settings/config page (built inline as a `data:` URL,
  no server required).

## Building

This needs the Pebble/Rebble SDK toolchain, which isn't available in
this sandbox, so the code hasn't been compiled here. To build and install:

1. Install the Rebble fork of `pebble-tool` (the original Pebble SDK
   servers are gone; Rebble maintains a compatible replacement):
   https://developer.rebble.io/developer.pebble.com/sdk/install-linux/index.html
   ```
   pip install pebble-tool
   pebble sdk install latest
   ```
2. From this project directory:
   ```
   pebble build
   pebble install --phone <your-phone-ip>   # or --emulator basalt
   ```
3. On your phone, open the Pebble app, find "GPS Memo" under installed
   watchapps, and tap the settings/gear icon to see the saved log.

## Notes / things you may want to adjust later

- GPS accuracy/altitude aren't shown yet — only raw lat/lon, per your spec.
- The log is only stored in the phone app's local storage (not synced
  anywhere). If you want export, backup, or editing, that'd be a good
  next step.
- Timezone abbreviation (`%Z`) relies on the watch's timezone database,
  which is set from the phone; it falls back to a UTC-offset style
  string on watches/phones without a matching zone name.
