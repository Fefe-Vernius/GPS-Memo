var LOG_STORAGE_KEY = 'gpsMemoLog';
var NOTIFY_PROVIDER_KEY = 'notifyProvider';
var GOTIFY_URL_KEY = 'gotifyUrl';
var GOTIFY_TOKEN_KEY = 'gotifyToken';
var GOTIFY_PRIORITY_KEY = 'gotifyPriority';
var GOTIFY_TITLE_KEY = 'gotifyTitle';
var CUSTOM_CURL_KEY = 'customCurl';

var DEFAULT_PRIORITY = '5';
var DEFAULT_TITLE = 'GPS Memo';

var lastLat = null;
var lastLon = null;
var lastTimestamp = null;

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

// --- Custom curl command support -------------------------------------------
// There is no curl binary in the PebbleKit JS sandbox, so the argument string
// the user pastes is tokenized and translated into an XMLHttpRequest. The
// commonly used flags are supported; presentation-only flags (-s, -k, -v, ...)
// are accepted and ignored.

function substitutePlaceholders(value, ctx) {
  return value
    .replace(/\{\{message\}\}/g, ctx.message)
    .replace(/\{\{timestamp\}\}/g, ctx.timestamp)
    .replace(/\{\{lat\}\}/g, ctx.lat)
    .replace(/\{\{lon\}\}/g, ctx.lon);
}

// Splits a command line into tokens, honouring quotes, backslash escapes and
// backslash-newline continuations.
function tokenizeCommand(input) {
  var tokens = [];
  var current = '';
  var started = false;
  var quote = null;

  for (var i = 0; i < input.length; i++) {
    var c = input.charAt(i);

    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < input.length) {
        current += input.charAt(++i);
      } else if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && i + 1 < input.length) {
      var next = input.charAt(++i);
      if (next !== '\n') {
        current += next;
        started = true;
      }
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (started || current.length) {
        tokens.push(current);
        current = '';
        started = false;
      }
    } else {
      current += c;
      started = true;
    }
  }

  if (started || current.length) {
    tokens.push(current);
  }
  return tokens;
}

var CURL_FLAGS_WITH_VALUE = [
  '-o', '--output', '--max-time', '--connect-timeout', '-A', '--user-agent',
  '-e', '--referer', '-w', '--write-out', '--retry', '--cacert', '--cert'
];

function parseCurlCommand(commandText, ctx) {
  var tokens = tokenizeCommand(commandText);
  var parsed = { method: null, url: null, headers: [], data: [], form: [] };

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];

    if (i === 0 && token === 'curl') {
      continue;
    }

    if (token === '-X' || token === '--request') {
      parsed.method = tokens[++i];
    } else if (token === '-H' || token === '--header') {
      parsed.headers.push(substitutePlaceholders(tokens[++i] || '', ctx));
    } else if (token === '-d' || token === '--data' || token === '--data-raw' ||
               token === '--data-binary' || token === '--data-ascii') {
      parsed.data.push(substitutePlaceholders(tokens[++i] || '', ctx));
    } else if (token === '--data-urlencode') {
      var raw = substitutePlaceholders(tokens[++i] || '', ctx);
      var split = raw.indexOf('=');
      parsed.data.push(split === -1 ? encodeURIComponent(raw) :
        raw.slice(0, split) + '=' + encodeURIComponent(raw.slice(split + 1)));
    } else if (token === '-F' || token === '--form') {
      parsed.form.push(substitutePlaceholders(tokens[++i] || '', ctx));
    } else if (token === '--url') {
      parsed.url = substitutePlaceholders(tokens[++i] || '', ctx);
    } else if (CURL_FLAGS_WITH_VALUE.indexOf(token) !== -1) {
      i++;
    } else if (token.charAt(0) === '-') {
      // valueless flag (-s, -k, -L, -v, ...) — nothing to do
    } else if (!parsed.url) {
      parsed.url = substitutePlaceholders(token, ctx);
    }
  }

  return parsed;
}

function buildMultipartBody(fields, boundary) {
  var body = '';
  for (var i = 0; i < fields.length; i++) {
    var split = fields[i].indexOf('=');
    var name = split === -1 ? fields[i] : fields[i].slice(0, split);
    var value = split === -1 ? '' : fields[i].slice(split + 1);

    body += '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="' + name + '"\r\n\r\n' +
      value + '\r\n';
  }
  return body + '--' + boundary + '--\r\n';
}

function sendCustomCurl(message) {
  var commandText = localStorage.getItem(CUSTOM_CURL_KEY) || '';

  if (!commandText) {
    console.log('GPS Memo: no custom curl command configured, skipping');
    return;
  }

  var parsed = parseCurlCommand(commandText, {
    message: message,
    timestamp: lastTimestamp || '',
    lat: lastLat === null ? '' : lastLat,
    lon: lastLon === null ? '' : lastLon
  });

  if (!parsed.url) {
    console.log('GPS Memo: custom curl command has no URL');
    return;
  }

  var body = null;
  var contentType = null;

  if (parsed.form.length) {
    var boundary = '----GPSMemo' + Date.now() + Math.floor(Math.random() * 1e6);
    body = buildMultipartBody(parsed.form, boundary);
    contentType = 'multipart/form-data; boundary=' + boundary;
  } else if (parsed.data.length) {
    body = parsed.data.join('&');
    contentType = 'application/x-www-form-urlencoded';
  }

  var method = parsed.method || (body === null ? 'GET' : 'POST');

  var req = new XMLHttpRequest();
  req.open(method, parsed.url, true);

  if (contentType) {
    try {
      req.setRequestHeader('Content-Type', contentType);
    } catch (err) {
      console.log('GPS Memo: could not set Content-Type: ' + err.message);
    }
  }

  for (var i = 0; i < parsed.headers.length; i++) {
    var sep = parsed.headers[i].indexOf(':');
    if (sep === -1) {
      continue;
    }
    try {
      req.setRequestHeader(
        parsed.headers[i].slice(0, sep).trim(),
        parsed.headers[i].slice(sep + 1).trim()
      );
    } catch (err2) {
      console.log('GPS Memo: skipped header: ' + err2.message);
    }
  }

  req.onload = function() {
    if (req.status >= 200 && req.status < 300) {
      console.log('GPS Memo: custom request sent (HTTP ' + req.status + ')');
    } else {
      console.log('GPS Memo: custom request returned HTTP ' + req.status);
    }
  };
  req.onerror = function() {
    console.log('GPS Memo: custom request failed');
  };
  req.send(body);
}

// Settings saved before the service dropdown existed have Gotify details but
// no stored provider; treat those as Gotify so they keep working.
function currentProvider() {
  var stored = localStorage.getItem(NOTIFY_PROVIDER_KEY);
  if (stored) {
    return stored;
  }
  if (localStorage.getItem(GOTIFY_URL_KEY) && localStorage.getItem(GOTIFY_TOKEN_KEY)) {
    return 'gotify';
  }
  return 'none';
}

function sendNotification(message) {
  var provider = currentProvider();

  if (provider === 'gotify') {
    sendGotifyNotification(message);
  } else if (provider === 'curl') {
    sendCustomCurl(message);
  } else {
    console.log('GPS Memo: notifications disabled, nothing sent');
  }
}

function buildConfigHtml(log, config) {
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>GPS Memo</title>' +
    '<style>' +
    'body{font-family:sans-serif;margin:16px;background:#fff;color:#111;}' +
    'h2{margin-top:0;}' +
    'h3{margin-bottom:4px;}' +
    'textarea{width:100%;height:34vh;font-family:monospace;font-size:14px;box-sizing:border-box;}' +
    'textarea.cmd{height:16vh;}' +
    '.hint{font-size:13px;color:#555;margin-top:0;}' +
    'code{background:#eee;padding:1px 3px;}' +
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
    '<option value="none"' + (config.provider === 'none' ? ' selected' : '') + '>None</option>' +
    '<option value="gotify"' + (config.provider === 'gotify' ? ' selected' : '') + '>Gotify</option>' +
    '<option value="curl"' + (config.provider === 'curl' ? ' selected' : '') + '>Custom curl command</option>' +
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

    '<div id="curlFields">' +
    '<label for="curl">Command (everything after <code>curl</code>)</label>' +
    '<textarea id="curl" class="cmd" placeholder="&quot;https://example.com/hook&quot; -F &quot;message={{message}}&quot;">' + escapeHtml(config.curl) + '</textarea>' +
    '<p class="hint">Supports <code>-X -H -d -F --data-urlencode</code>. ' +
    'Placeholders: <code>{{message}}</code> (the saved log line), ' +
    '<code>{{timestamp}}</code>, <code>{{lat}}</code>, <code>{{lon}}</code>.</p>' +
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
    'document.getElementById("curlFields").style.display = (provider === "curl") ? "block" : "none";' +
    '}' +
    'function closeConfig(action){' +
    'var payload = {action: action,' +
    'provider: document.getElementById("provider").value,' +
    'url: document.getElementById("url").value,' +
    'token: document.getElementById("token").value,' +
    'title: document.getElementById("title").value,' +
    'priority: document.getElementById("priority").value,' +
    'curl: document.getElementById("curl").value};' +
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
    lastTimestamp = payload.SaveEntry;
    var line = buildLogLine(payload.SaveEntry);
    appendLogEntry(line);
    sendNotification(line);
    Pebble.sendAppMessage({ 'SaveAck': 1 });
  }
});

Pebble.addEventListener('showConfiguration', function() {
  var log = localStorage.getItem(LOG_STORAGE_KEY) || '';
  var config = {
    provider: currentProvider(),
    url: localStorage.getItem(GOTIFY_URL_KEY) || '',
    token: localStorage.getItem(GOTIFY_TOKEN_KEY) || '',
    title: localStorage.getItem(GOTIFY_TITLE_KEY) || '',
    priority: localStorage.getItem(GOTIFY_PRIORITY_KEY) || '',
    curl: localStorage.getItem(CUSTOM_CURL_KEY) || ''
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
    if (typeof result.curl === 'string') {
      localStorage.setItem(CUSTOM_CURL_KEY, result.curl.trim());
    }

    if (result.action === 'clear') {
      localStorage.removeItem(LOG_STORAGE_KEY);
    } else if (result.action === 'test') {
      sendNotification(lastLogLine() || 'GPS Memo: no saved entries yet');
    }
  } catch (err) {
    console.log('GPS Memo: could not parse config response: ' + err.message);
  }
});
