var LOG_STORAGE_KEY = 'gpsMemoLog';
var NOTIFY_PROVIDER_KEY = 'notifyProvider';
var GOTIFY_URL_KEY = 'gotifyUrl';
var GOTIFY_TOKEN_KEY = 'gotifyToken';
var GOTIFY_PRIORITY_KEY = 'gotifyPriority';
var GOTIFY_TITLE_KEY = 'gotifyTitle';

var DEFAULT_PRIORITY = '5';
var DEFAULT_TITLE = 'GPS Memo';

var lastLat = null;
var lastLon = null;

var lastSentLat = null;
var lastSentLon = null;
var DISPLAY_COORD_DECIMALS = 4;

var locationOptions = {
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 15000
};

function locationSuccess(pos) {
  lastLat = pos.coords.latitude.toFixed(6);
  lastLon = pos.coords.longitude.toFixed(6);

  var displayLat = pos.coords.latitude.toFixed(DISPLAY_COORD_DECIMALS);
  var displayLon = pos.coords.longitude.toFixed(DISPLAY_COORD_DECIMALS);

  if (displayLat === lastSentLat && displayLon === lastSentLon) {
    return;
  }
  lastSentLat = displayLat;
  lastSentLon = displayLon;

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

function buildLogLine(timestamp) {
  var coordsText = (lastLat !== null && lastLon !== null) ?
    (lastLat + ', ' + lastLon) : 'NO GPS FIX';
  return timestamp + '  ' + coordsText;
}

function appendLogEntry(line) {
  var log = localStorage.getItem(LOG_STORAGE_KEY) || '';
  log += (log.length ? '\n' : '') + line;
  localStorage.setItem(LOG_STORAGE_KEY, log);
}

function lastLogLine() {
  var log = localStorage.getItem(LOG_STORAGE_KEY) || '';
  if (!log) {
    return '';
  }
  var lines = log.split('\n');
  return lines[lines.length - 1];
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Mirrors: curl "<server>/message?token=<token>" \
//   -F "title=..." -F "message=<saved log line>" -F "priority=..."
// Sent as x-www-form-urlencoded rather than multipart, since FormData is not
// dependable in the PebbleKit JS sandbox; Gotify accepts either.
function sendGotifyNotification(message) {
  var server = (localStorage.getItem(GOTIFY_URL_KEY) || '').replace(/\/+$/, '');
  var token = localStorage.getItem(GOTIFY_TOKEN_KEY) || '';

  if (!server || !token) {
    console.log('GPS Memo: Gotify not configured, skipping notification');
    return;
  }

  var title = localStorage.getItem(GOTIFY_TITLE_KEY) || DEFAULT_TITLE;
  var priority = localStorage.getItem(GOTIFY_PRIORITY_KEY) || DEFAULT_PRIORITY;

  var body = 'title=' + encodeURIComponent(title) +
    '&message=' + encodeURIComponent(message) +
    '&priority=' + encodeURIComponent(priority);

  var req = new XMLHttpRequest();
  req.open('POST', server + '/message?token=' + encodeURIComponent(token), true);
  req.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  req.onload = function() {
    if (req.status >= 200 && req.status < 300) {
      console.log('GPS Memo: Gotify notification sent');
    } else {
      console.log('GPS Memo: Gotify returned HTTP ' + req.status);
    }
  };
  req.onerror = function() {
    console.log('GPS Memo: Gotify request failed');
  };
  req.send(body);
}

function buildConfigHtml(log, config) {
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>GPS Memo</title>' +
    '<style>' +
    'body{font-family:sans-serif;margin:16px;background:#fff;color:#111;}' +
    'h2{margin-top:0;}' +
    'h3{margin-bottom:4px;}' +
    'textarea{width:100%;height:34vh;font-family:monospace;font-size:14px;box-sizing:border-box;}' +
    'input,select{width:100%;padding:8px;font-size:15px;box-sizing:border-box;margin-bottom:8px;}' +
    'label{display:block;font-size:14px;margin-bottom:2px;}' +
    'button{margin-top:12px;padding:10px 16px;font-size:16px;margin-right:8px;}' +
    '</style></head><body>' +
    '<h2>GPS Memo</h2>' +

    '<h3>Saved Entries</h3>' +
    '<p>One saved entry per line: timestamp and raw GPS coordinates.</p>' +
    '<textarea id="log" readonly>' + escapeHtml(log) + '</textarea>' +

    '<h3>Notifications</h3>' +
    '<label for="provider">Service</label>' +
    '<select id="provider" onchange="updateProvider()">' +
    '<option value="gotify">Gotify</option>' +
    '</select>' +
    '<div id="gotifyFields">' +
    '<label for="url">Server Address</label>' +
    '<input id="url" type="url" placeholder="https://gotify.example.com" value="' + escapeHtml(config.url) + '">' +
    '<label for="token">App Token</label>' +
    '<input id="token" type="text" placeholder="application token" value="' + escapeHtml(config.token) + '">' +
    '<label for="title">Title</label>' +
    '<input id="title" type="text" placeholder="' + escapeHtml(DEFAULT_TITLE) + '" value="' + escapeHtml(config.title) + '">' +
    '<label for="priority">Priority</label>' +
    '<input id="priority" type="number" min="0" max="10" placeholder="' + escapeHtml(DEFAULT_PRIORITY) + '" value="' + escapeHtml(config.priority) + '">' +
    '</div>' +

    '<div>' +
    '<button onclick="closeConfig(\'save\')">Save</button>' +
    '<button onclick="closeConfig(\'test\')">Send Test</button>' +
    '<button onclick="clearLog()">Clear Log</button>' +
    '</div>' +

    '<script>' +
    'function updateProvider(){' +
    'var provider = document.getElementById("provider").value;' +
    'document.getElementById("gotifyFields").style.display = (provider === "gotify") ? "block" : "none";' +
    '}' +
    'function closeConfig(action){' +
    'var payload = {action: action,' +
    'provider: document.getElementById("provider").value,' +
    'url: document.getElementById("url").value,' +
    'token: document.getElementById("token").value,' +
    'title: document.getElementById("title").value,' +
    'priority: document.getElementById("priority").value};' +
    'document.location = "pebblejs://close#" + encodeURIComponent(JSON.stringify(payload));' +
    '}' +
    'function clearLog(){' +
    'if (confirm("Clear all saved entries?")) { closeConfig("clear"); }' +
    '}' +
    'updateProvider();' +
    '</script>' +
    '</body></html>';
}

Pebble.addEventListener('ready', function() {
  navigator.geolocation.watchPosition(locationSuccess, locationError, locationOptions);
});

Pebble.addEventListener('appmessage', function(e) {
  var payload = e.payload;
  if (payload.SaveEntry) {
    var line = buildLogLine(payload.SaveEntry);
    appendLogEntry(line);
    sendGotifyNotification(line);
    Pebble.sendAppMessage({ 'SaveAck': 1 });
  }
});

Pebble.addEventListener('showConfiguration', function() {
  var log = localStorage.getItem(LOG_STORAGE_KEY) || '';
  var config = {
    provider: localStorage.getItem(NOTIFY_PROVIDER_KEY) || 'gotify',
    url: localStorage.getItem(GOTIFY_URL_KEY) || '',
    token: localStorage.getItem(GOTIFY_TOKEN_KEY) || '',
    title: localStorage.getItem(GOTIFY_TITLE_KEY) || '',
    priority: localStorage.getItem(GOTIFY_PRIORITY_KEY) || ''
  };
  var url = 'data:text/html,' + encodeURIComponent(buildConfigHtml(log, config));
  Pebble.openURL(url);
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response) {
    return;
  }
  try {
    var result = JSON.parse(decodeURIComponent(e.response));

    if (typeof result.provider === 'string') {
      localStorage.setItem(NOTIFY_PROVIDER_KEY, result.provider);
    }
    if (typeof result.url === 'string') {
      localStorage.setItem(GOTIFY_URL_KEY, result.url.trim());
    }
    if (typeof result.token === 'string') {
      localStorage.setItem(GOTIFY_TOKEN_KEY, result.token.trim());
    }
    if (typeof result.title === 'string') {
      localStorage.setItem(GOTIFY_TITLE_KEY, result.title.trim());
    }
    if (typeof result.priority === 'string') {
      localStorage.setItem(GOTIFY_PRIORITY_KEY, result.priority.trim());
    }

    if (result.action === 'clear') {
      localStorage.removeItem(LOG_STORAGE_KEY);
    } else if (result.action === 'test') {
      sendGotifyNotification(lastLogLine() || 'GPS Memo: no saved entries yet');
    }
  } catch (err) {
    console.log('GPS Memo: could not parse config response: ' + err.message);
  }
});
