var LOG_STORAGE_KEY = 'gpsMemoLog';

var lastLat = null;
var lastLon = null;

var locationOptions = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 15000
};

function locationSuccess(pos) {
  lastLat = pos.coords.latitude.toFixed(6);
  lastLon = pos.coords.longitude.toFixed(6);

  Pebble.sendAppMessage({
    'Latitude': lastLat,
    'Longitude': lastLon
  }, function() {
    // ack, nothing to do
  }, function() {
    console.log('GPS Memo: failed to send location to watch');
  });
}

function locationError(err) {
  console.log('GPS Memo: location error (' + err.code + '): ' + err.message);
}

function appendLogEntry(timestamp) {
  var coordsText = (lastLat !== null && lastLon !== null) ?
    (lastLat + ', ' + lastLon) : 'NO GPS FIX';
  var line = timestamp + '  ' + coordsText;

  var log = localStorage.getItem(LOG_STORAGE_KEY) || '';
  log += (log.length ? '\n' : '') + line;
  localStorage.setItem(LOG_STORAGE_KEY, log);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildConfigHtml(log) {
  var escaped = escapeHtml(log);
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>GPS Memo</title>' +
    '<style>' +
    'body{font-family:sans-serif;margin:16px;background:#fff;color:#111;}' +
    'h2{margin-top:0;}' +
    'textarea{width:100%;height:60vh;font-family:monospace;font-size:14px;box-sizing:border-box;}' +
    'button{margin-top:12px;padding:10px 16px;font-size:16px;margin-right:8px;}' +
    '</style></head><body>' +
    '<h2>GPS Memo Log</h2>' +
    '<p>One saved entry per line: timestamp and raw GPS coordinates.</p>' +
    '<textarea id="log" readonly>' + escaped + '</textarea>' +
    '<div>' +
    '<button onclick="closeConfig(false)">Close</button>' +
    '<button onclick="clearLog()">Clear Log</button>' +
    '</div>' +
    '<script>' +
    'function closeConfig(clear){' +
    'document.location = "pebblejs://close#" + encodeURIComponent(JSON.stringify({clear: clear}));' +
    '}' +
    'function clearLog(){' +
    'if (confirm("Clear all saved entries?")) { closeConfig(true); }' +
    '}' +
    '</script>' +
    '</body></html>';
}

Pebble.addEventListener('ready', function() {
  navigator.geolocation.watchPosition(locationSuccess, locationError, locationOptions);
});

Pebble.addEventListener('appmessage', function(e) {
  var payload = e.payload;
  if (payload.SaveEntry) {
    appendLogEntry(payload.SaveEntry);
    Pebble.sendAppMessage({ 'SaveAck': 1 });
  }
});

Pebble.addEventListener('showConfiguration', function() {
  var log = localStorage.getItem(LOG_STORAGE_KEY) || '';
  var url = 'data:text/html,' + encodeURIComponent(buildConfigHtml(log));
  Pebble.openURL(url);
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response) {
    return;
  }
  try {
    var result = JSON.parse(decodeURIComponent(e.response));
    if (result.clear) {
      localStorage.removeItem(LOG_STORAGE_KEY);
    }
  } catch (err) {
    console.log('GPS Memo: could not parse config response: ' + err.message);
  }
});
