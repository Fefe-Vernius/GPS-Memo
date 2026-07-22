# GPS Memo

A Pebble watchapp that shows the phone's raw GPS coordinates and the
current date/time, and lets you save a timestamped coordinate entry by
holding the SELECT button.

## What it does

- Displays the current date/time as `YYYYMMDD_Timezone_HHMMSS` (e.g.
  `20260722_CEST_143005`), updated every second.
- Displays the latest raw latitude/longitude received from the phone's
  GPS (6 decimal places), via PebbleKit JS `navigator.geolocation.watchPosition`.
- Holding SELECT for ~2 seconds sends the currently displayed timestamp
  to the phone, which appends a line `TIMESTAMP  LAT, LON` to a log kept
  in the phone app's `localStorage`. The watch vibrates and shows
  "Saved!" briefly to confirm.
- The watch app's Settings page (opened from the Pebble phone app) shows
  the full log in a read-only textarea, one entry per line, with a
  "Clear Log" button.

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
