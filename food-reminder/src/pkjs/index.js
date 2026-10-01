var REMINDERS_KEY = 'reminders';
var IMAGE_KEY_PREFIX = 'image_';
var SYNC_DIRTY_KEY = 'syncDirty';
var WATCH_INFO_KEY = 'watchInfo';
var TIMELINE_MODE_KEY = 'timelineMode';
var TIMELINE_API_KEY = 'timelineApi';
var TIMELINE_STATUS_KEY = 'timelineStatus';
var PUSHED_PINS_KEY = 'pushedPins';

// Must match MAX_REMINDERS / TEXT_LEN in src/c/food_reminder.c.
var MAX_REMINDERS = 40;
var MAX_TEXT_BYTES = 63;
var MAX_TEXT_CHARS = 60;

var DEFAULT_TEXT = 'Time to eat!';

// Must match IMAGE_FORMAT_* in src/c/food_reminder.c.
var IMAGE_FORMAT_8BIT = 0;
var IMAGE_FORMAT_1BIT = 1;

// The watch inbox is 2048 bytes; leave room for the dictionary headers.
var IMAGE_CHUNK_BYTES = 1800;

// Images are stored one character per pixel: the character's index in this
// (URL-safe) alphabet is the Pebble 64-colour value 0bRRGGBB.
var PIXEL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

var DEFAULT_TIMELINE_API = 'https://timeline-api.rebble.io';
var TIMELINE_DAYS_AHEAD = 3;
var TIMELINE_ICON = 'system://images/DINNER_RESERVATION';

// Screen sizes for when the watch has not reported its own yet.
var PLATFORM_SCREENS = {
  aplite: { w: 144, h: 168, color: false },
  basalt: { w: 144, h: 168, color: true },
  chalk: { w: 180, h: 180, color: true, round: true },
  diorite: { w: 144, h: 168, color: false },
  emery: { w: 200, h: 228, color: true }
};

// --- Storage -----------------------------------------------------------------

function readJson(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.log('Food Reminder: bad JSON in ' + key + ': ' + err.message);
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadReminders() {
  return readJson(REMINDERS_KEY, []);
}

function loadImage(id) {
  return readJson(IMAGE_KEY_PREFIX + id, null);
}

function screenInfo() {
  var reported = readJson(WATCH_INFO_KEY, null);
  if (reported) {
    return reported;
  }
  var platform = 'basalt';
  try {
    var info = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
    if (info && info.platform) {
      platform = info.platform;
    }
  } catch (err) {
    console.log('Food Reminder: getActiveWatchInfo failed: ' + err.message);
  }
  return PLATFORM_SCREENS[platform] || PLATFORM_SCREENS.basalt;
}

// Cuts text to what fits the watch's buffer without splitting a UTF-8 sequence.
function truncateUtf8(text, maxBytes) {
  var out = '';
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text.charAt(i);
    var code = text.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      ch += text.charAt(++i);
    }
    var size = unescape(encodeURIComponent(ch)).length;
    if (bytes + size > maxBytes) {
      break;
    }
    out += ch;
    bytes += size;
  }
  return out;
}

// --- AppMessage queue --------------------------------------------------------
// Only one AppMessage may be in flight at a time, so everything goes through
// this queue. Each item can carry a tag (to drop stale image chunks) and an
// onDone callback that runs once the item was acked or finally given up on.

var queue = [];
var sending = false;
var MAX_SEND_TRIES = 3;

function enqueue(message, tag, onDone) {
  queue.push({ message: message, tag: tag || null, onDone: onDone || null, tries: 0 });
  pump();
}

function finishItem(item, ok) {
  queue.shift();
  sending = false;
  if (item.onDone) {
    item.onDone(ok);
  }
  pump();
}

function pump() {
  if (sending || !queue.length) {
    return;
  }
  var item = queue[0];
  sending = true;
  Pebble.sendAppMessage(item.message, function() {
    finishItem(item, true);
  }, function() {
    item.tries++;
    if (item.tries >= MAX_SEND_TRIES) {
      console.log('Food Reminder: giving up on message after ' + item.tries + ' tries');
      finishItem(item, false);
    } else {
      sending = false;
      setTimeout(pump, 300 * item.tries);
    }
  });
}

function dropQueued(tag) {
  // Keep queue[0] while it is in flight; its callbacks still expect it.
  var start = sending ? 1 : 0;
  for (var i = queue.length - 1; i >= start; i--) {
    if (queue[i].tag === tag) {
      queue.splice(i, 1);
    }
  }
}

// --- Sync to the watch -------------------------------------------------------

function syncToWatch() {
  var reminders = loadReminders();
  var failed = false;
  var onDone = function(ok) {
    if (!ok) {
      failed = true;
    }
  };

  dropQueued('sync');

  if (!reminders.length) {
    enqueue({ SyncCount: 0 }, 'sync', onDone);
  }

  for (var i = 0; i < reminders.length; i++) {
    var r = reminders[i];
    enqueue({
      SyncCount: reminders.length,
      SyncIndex: i,
      RemId: r.id,
      RemHour: r.hour,
      RemMinute: r.minute,
      RemDays: r.days,
      RemText: truncateUtf8(r.text || DEFAULT_TEXT, MAX_TEXT_BYTES),
      RemHasImage: r.hasImage ? 1 : 0
    }, 'sync', onDone);
  }

  // Runs after the last sync message, whether it went through or not.
  queue[queue.length - 1].onDone = function(ok) {
    onDone(ok);
    if (failed) {
      console.log('Food Reminder: sync incomplete, will retry on next launch');
    } else {
      localStorage.removeItem(SYNC_DIRTY_KEY);
      console.log('Food Reminder: ' + reminders.length + ' reminder(s) synced');
    }
  };
}

// --- Images to the watch -----------------------------------------------------

var PIXEL_VALUES = {};
for (var p = 0; p < PIXEL_ALPHABET.length; p++) {
  PIXEL_VALUES[PIXEL_ALPHABET.charAt(p)] = p;
}

function isLightPixel(value) {
  var r = (value >> 4) & 3;
  var g = (value >> 2) & 3;
  var b = value & 3;
  return (r * 30 + g * 59 + b * 11) >= 150;
}

// Converts a stored image into the watch's in-memory row layout: one GColor8
// byte per pixel, or 1-bit rows (leftmost pixel in the lowest bit) on
// black-and-white watches.
function imageBytes(image, color) {
  var w = image.w;
  var h = image.h;
  var pixels = image.pixels;
  var bytes = [];
  var x, y;

  if (color) {
    for (var i = 0; i < w * h; i++) {
      bytes.push(0xC0 | (PIXEL_VALUES[pixels.charAt(i)] || 0));
    }
    return bytes;
  }

  var rowBytes = Math.ceil(w / 8);
  for (y = 0; y < h; y++) {
    for (var xb = 0; xb < rowBytes; xb++) {
      var b = 0;
      for (var bit = 0; bit < 8; bit++) {
        x = xb * 8 + bit;
        if (x < w && isLightPixel(PIXEL_VALUES[pixels.charAt(y * w + x)] || 0)) {
          b |= (1 << bit);
        }
      }
      bytes.push(b);
    }
  }
  return bytes;
}

function sendImage(id) {
  dropQueued('image');

  var image = loadImage(id);
  if (!image) {
    enqueue({ ImageId: id, ImageDone: 0 }, 'image');
    return;
  }

  var color = screenInfo().color !== false;
  var bytes = imageBytes(image, color);

  enqueue({
    ImageId: id,
    ImageWidth: image.w,
    ImageHeight: image.h,
    ImageFormat: color ? IMAGE_FORMAT_8BIT : IMAGE_FORMAT_1BIT
  }, 'image');

  for (var offset = 0; offset < bytes.length; offset += IMAGE_CHUNK_BYTES) {
    enqueue({
      ImageId: id,
      ImageOffset: offset,
      ImageData: bytes.slice(offset, offset + IMAGE_CHUNK_BYTES)
    }, 'image');
  }

  enqueue({ ImageId: id, ImageDone: 1 }, 'image');
}

// --- Timeline pins -----------------------------------------------------------
// Pins cover the next TIMELINE_DAYS_AHEAD days and are refreshed every time
// the app runs (each reminder launches it), so the window keeps rolling.
// Pin ids are deterministic, which makes re-pushing them harmless.

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function timelineMode() {
  return localStorage.getItem(TIMELINE_MODE_KEY) || 'pins';
}

function timelineApi() {
  return (localStorage.getItem(TIMELINE_API_KEY) || DEFAULT_TIMELINE_API).replace(/\/+$/, '');
}

function setTimelineStatus(text) {
  console.log('Food Reminder: timeline: ' + text);
  localStorage.setItem(TIMELINE_STATUS_KEY, new Date().toLocaleString() + ' — ' + text);
}

function buildPin(reminder, when, withReminder) {
  var title = reminder.text || DEFAULT_TEXT;
  var time = when.toISOString();
  var pin = {
    id: 'food-' + reminder.id + '-' + when.getFullYear() + pad2(when.getMonth() + 1) +
      pad2(when.getDate()) + pad2(when.getHours()) + pad2(when.getMinutes()),
    time: time,
    layout: {
      type: 'genericPin',
      title: title,
      subtitle: 'Food Reminder',
      tinyIcon: TIMELINE_ICON
    },
    actions: [{
      title: 'Show reminder',
      type: 'openWatchApp',
      launchCode: reminder.id
    }]
  };
  if (withReminder) {
    pin.reminders = [{
      time: time,
      layout: { type: 'genericReminder', title: title, tinyIcon: TIMELINE_ICON }
    }];
  }
  return pin;
}

function desiredPins(reminders, mode, now) {
  var pins = {};
  if (mode === 'off') {
    return pins;
  }
  for (var d = 0; d <= TIMELINE_DAYS_AHEAD; d++) {
    for (var i = 0; i < reminders.length; i++) {
      var r = reminders[i];
      var when = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, r.hour, r.minute);
      if (when <= now || !(r.days & (1 << when.getDay()))) {
        continue;
      }
      var pin = buildPin(r, when, mode === 'pinsAndAlerts');
      pins[pin.id] = pin;
    }
  }
  return pins;
}

function timelineRequest(method, token, pinId, body, callback) {
  var req = new XMLHttpRequest();
  req.open(method, timelineApi() + '/v1/user/pins/' + encodeURIComponent(pinId), true);
  req.setRequestHeader('Content-Type', 'application/json');
  req.setRequestHeader('X-User-Token', token);
  req.onload = function() {
    callback(req.status >= 200 && req.status < 300 ? null : 'HTTP ' + req.status +
      (req.responseText ? ': ' + req.responseText.slice(0, 120) : ''));
  };
  req.onerror = function() {
    callback('network error');
  };
  req.send(body ? JSON.stringify(body) : null);
}

var timelineBusy = false;
var timelineRerun = false;

function finishTimeline(status) {
  timelineBusy = false;
  setTimelineStatus(status);
  if (timelineRerun) {
    timelineRerun = false;
    syncTimeline();
  }
}

function syncTimeline() {
  if (timelineBusy) {
    timelineRerun = true;  // settings changed mid-update; go again afterwards
    return;
  }

  var now = new Date();
  var mode = timelineMode();
  var wanted = desiredPins(loadReminders(), mode, now);
  var pushed = readJson(PUSHED_PINS_KEY, {});
  var jobs = [];
  var id;

  for (id in pushed) {
    if (!pushed.hasOwnProperty(id)) {
      continue;
    }
    if (new Date(pushed[id].time) <= now) {
      delete pushed[id];  // already in the past; the timeline expires it
    } else if (!wanted[id]) {
      jobs.push({ method: 'DELETE', id: id });
    }
  }
  for (id in wanted) {
    if (!wanted.hasOwnProperty(id)) {
      continue;
    }
    var hash = JSON.stringify(wanted[id]);
    if (!pushed[id] || pushed[id].hash !== hash) {
      jobs.push({ method: 'PUT', id: id, pin: wanted[id], hash: hash });
    }
  }
  writeJson(PUSHED_PINS_KEY, pushed);

  if (!jobs.length) {
    if (mode !== 'off') {
      setTimelineStatus('up to date (' + Object.keys(wanted).length + ' upcoming pins)');
    }
    return;
  }

  if (typeof Pebble.getTimelineToken !== 'function') {
    setTimelineStatus('this phone app does not support timeline pins');
    return;
  }

  timelineBusy = true;
  Pebble.getTimelineToken(function(token) {
    var done = 0;
    var errors = [];

    var next = function() {
      if (!jobs.length) {
        writeJson(PUSHED_PINS_KEY, pushed);
        finishTimeline(errors.length ?
          (errors.length + ' pin update(s) failed, last error: ' + errors[errors.length - 1]) :
          ('OK, ' + done + ' pin update(s) sent'));
        return;
      }
      var job = jobs.shift();
      timelineRequest(job.method, token, job.id, job.pin, function(err) {
        if (err) {
          errors.push(err);
        } else {
          done++;
          if (job.method === 'PUT') {
            pushed[job.id] = { time: job.pin.time, hash: job.hash };
          } else {
            delete pushed[job.id];
          }
        }
        next();
      });
    };
    next();
  }, function(err) {
    finishTimeline('could not get a timeline token (' + err + ')');
  });
}

// --- Settings page -----------------------------------------------------------
// The page is a self-contained data: URL. Its script is the settingsPage
// function below, serialised with toString(), so it must not use anything
// from this file's scope.

function settingsPage(data) {
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  var DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var screen = data.screen;
  var cards = [];
  var list = document.getElementById('list');
  var addButton = document.getElementById('add');

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var key in attrs) {
      if (key === 'text') {
        node.textContent = attrs[key];
      } else if (key === 'className') {
        node.className = attrs[key];
      } else {
        node.setAttribute(key, attrs[key]);
      }
    }
    (children || []).forEach(function(child) {
      node.appendChild(child);
    });
    return node;
  }

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function newId() {
    var id;
    do {
      id = 1 + Math.floor(Math.random() * 1073741823);
    } while (cards.some(function(c) { return c.id === id; }));
    return id;
  }

  // Scales the picture onto the watch screen, then reduces it to the Pebble
  // palette (64 colours, or black and white) with Floyd-Steinberg dithering.
  function convertImage(img, fit) {
    var w = screen.w;
    var h = screen.h;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    var scale = fit === 'fit' ?
      Math.min(w / img.width, h / img.height) :
      Math.max(w / img.width, h / img.height);
    var dw = img.width * scale;
    var dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);

    var imageData = ctx.getImageData(0, 0, w, h);
    var px = imageData.data;
    var work = new Float32Array(w * h * 3);
    var i, c;
    for (i = 0; i < w * h; i++) {
      if (screen.color) {
        for (c = 0; c < 3; c++) {
          work[i * 3 + c] = px[i * 4 + c];
        }
      } else {
        var grey = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11;
        work[i * 3] = work[i * 3 + 1] = work[i * 3 + 2] = grey;
      }
    }

    function spread(x, y, err, factor) {
      if (x < 0 || x >= w || y >= h) {
        return;
      }
      var j = (y * w + x) * 3;
      for (var k = 0; k < 3; k++) {
        work[j + k] += err[k] * factor;
      }
    }

    var pixels = '';
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        i = (y * w + x) * 3;
        var levels = [];
        var err = [];
        for (c = 0; c < 3; c++) {
          var v = Math.max(0, Math.min(255, work[i + c]));
          var level = screen.color ? Math.round(v / 85) : (v >= 128 ? 3 : 0);
          levels.push(level);
          err.push(v - level * 85);
        }
        if (!screen.color) {
          levels = [levels[0], levels[0], levels[0]];
        }
        pixels += ALPHABET.charAt((levels[0] << 4) | (levels[1] << 2) | levels[2]);
        for (c = 0; c < 3; c++) {
          px[(y * w + x) * 4 + c] = levels[c] * 85;
        }
        spread(x + 1, y, err, 7 / 16);
        spread(x - 1, y + 1, err, 3 / 16);
        spread(x, y + 1, err, 5 / 16);
        spread(x + 1, y + 1, err, 1 / 16);
      }
    }
    ctx.putImageData(imageData, 0, 0);

    var thumb = document.createElement('canvas');
    thumb.width = Math.round(w / 2);
    thumb.height = Math.round(h / 2);
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);

    return {
      w: w,
      h: h,
      pixels: pixels,
      thumb: thumb.toDataURL('image/jpeg', 0.8),
      preview: canvas.toDataURL('image/png')
    };
  }

  function renderNumbers() {
    cards.forEach(function(card, index) {
      card.title.textContent = 'Reminder ' + (index + 1);
    });
    addButton.disabled = cards.length >= data.maxReminders;
    addButton.textContent = cards.length >= data.maxReminders ?
      'Maximum of ' + data.maxReminders + ' reminders reached' : '+ Add reminder';
    document.getElementById('empty').style.display = cards.length ? 'none' : 'block';
  }

  function addCard(r) {
    var card = {
      id: r.id || newId(),
      image: r.hasImage ? 'keep' : 'none',
      source: null,
      fit: 'fill'
    };

    card.title = el('strong', { text: '' });
    var remove = el('button', { className: 'link danger', type: 'button', text: 'Delete' });

    card.time = el('input', { type: 'time', value: pad(r.hour) + ':' + pad(r.minute), required: 'required' });

    card.dayBoxes = {};
    var days = el('div', { className: 'days' });
    DAY_ORDER.forEach(function(wday) {
      var box = el('input', { type: 'checkbox' });
      box.checked = !!(r.days & (1 << wday));
      card.dayBoxes[wday] = box;
      days.appendChild(el('label', { className: 'day' }, [box, el('span', { text: DAY_NAMES[wday] })]));
    });
    var dayWarning = el('p', { className: 'warn', text: 'Pick at least one day, or this reminder never fires.' });

    card.text = el('input', {
      type: 'text', maxlength: String(data.maxTextChars), placeholder: data.defaultText
    });
    card.text.value = r.text || '';

    var preview = el('img', { className: 'preview', alt: '' });
    var noImage = el('div', { className: 'preview placeholder', text: 'No image' });
    var file = el('input', { type: 'file', accept: 'image/*', className: 'hidden' });
    var choose = el('button', { type: 'button', text: 'Choose image…' });
    var clear = el('button', { type: 'button', className: 'danger', text: 'Remove image' });
    var fit = el('select', {}, [
      el('option', { value: 'fill', text: 'Fill screen (crop)' }),
      el('option', { value: 'fit', text: 'Show whole image' })
    ]);
    var status = el('p', { className: 'hint' });

    function showImageState() {
      var has = card.image !== 'none';
      preview.style.display = has ? 'block' : 'none';
      noImage.style.display = has ? 'none' : 'flex';
      clear.style.display = has ? 'inline-block' : 'none';
      fit.style.display = card.source ? 'block' : 'none';
      if (card.image === 'keep') {
        preview.src = r.thumb || '';
      } else if (card.image && card.image.preview) {
        preview.src = card.image.preview;
      }
    }

    function convert() {
      try {
        card.image = convertImage(card.source, card.fit);
        status.textContent = 'Converted to ' + screen.w + '×' + screen.h +
          (screen.color ? ' in Pebble colours.' : ' in black and white.');
      } catch (err) {
        status.textContent = 'Could not convert this image: ' + err.message;
      }
      showImageState();
    }

    choose.onclick = function() {
      file.click();
    };
    file.onchange = function() {
      if (!file.files || !file.files[0]) {
        return;
      }
      status.textContent = 'Loading…';
      var reader = new FileReader();
      reader.onload = function() {
        var img = new Image();
        img.onload = function() {
          card.source = img;
          convert();
        };
        img.onerror = function() {
          status.textContent = 'That file is not an image this phone can read.';
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file.files[0]);
    };
    fit.onchange = function() {
      card.fit = fit.value;
      convert();
    };
    clear.onclick = function() {
      card.image = 'none';
      card.source = null;
      file.value = '';
      status.textContent = '';
      showImageState();
    };

    function checkDays() {
      var any = DAY_ORDER.some(function(wday) { return card.dayBoxes[wday].checked; });
      dayWarning.style.display = any ? 'none' : 'block';
    }
    DAY_ORDER.forEach(function(wday) {
      card.dayBoxes[wday].onchange = checkDays;
    });

    card.node = el('section', { className: 'card' }, [
      el('div', { className: 'card-head' }, [card.title, remove]),
      el('label', { text: 'Time' }), card.time,
      el('label', { text: 'Days' }), days, dayWarning,
      el('label', { text: 'Message' }), card.text,
      el('label', { text: 'Image (optional, shown full screen)' }),
      el('div', { className: 'image-row' }, [
        preview, noImage,
        el('div', { className: 'image-buttons' }, [choose, clear, fit])
      ]),
      file, status
    ]);

    remove.onclick = function() {
      if (!confirm('Delete ' + card.title.textContent + '?')) {
        return;
      }
      cards.splice(cards.indexOf(card), 1);
      list.removeChild(card.node);
      renderNumbers();
    };

    cards.push(card);
    list.appendChild(card.node);
    showImageState();
    checkDays();
    renderNumbers();
    return card;
  }

  addButton.onclick = function() {
    var next = new Date();
    next.setMinutes(0);
    next.setHours(next.getHours() + 1);
    var card = addCard({ hour: next.getHours(), minute: 0, days: 0x7F, text: '' });
    card.node.scrollIntoView({ behavior: 'smooth' });
    card.text.focus();
  };

  var mode = document.getElementById('timelineMode');
  var api = document.getElementById('timelineApi');
  mode.value = data.timeline.mode;
  api.value = data.timeline.api;
  api.placeholder = data.timeline.defaultApi;
  document.getElementById('timelineStatus').textContent =
    data.timeline.status ? 'Last update: ' + data.timeline.status : '';
  document.getElementById('screen').textContent = screen.w + '×' + screen.h +
    (screen.color ? ', colour' : ', black and white');

  document.getElementById('save').onclick = function() {
    var reminders = cards.map(function(card) {
      var parts = (card.time.value || '00:00').split(':');
      var days = 0;
      DAY_ORDER.forEach(function(wday) {
        if (card.dayBoxes[wday].checked) {
          days |= (1 << wday);
        }
      });
      var image = card.image;
      if (image && typeof image === 'object') {
        image = { w: image.w, h: image.h, pixels: image.pixels, thumb: image.thumb };
      }
      return {
        id: card.id,
        hour: parseInt(parts[0], 10) || 0,
        minute: parseInt(parts[1], 10) || 0,
        days: days,
        text: card.text.value.trim(),
        image: image
      };
    });
    var payload = {
      action: 'save',
      reminders: reminders,
      timeline: { mode: mode.value, api: api.value.trim() }
    };
    document.location = 'pebblejs://close#' + encodeURIComponent(JSON.stringify(payload));
  };
  document.getElementById('cancel').onclick = function() {
    document.location = 'pebblejs://close';
  };

  data.reminders.forEach(addCard);
}

var SETTINGS_CSS =
  ':root{--bg:#f4f1ec;--card:#fff;--text:#1d1b18;--muted:#6b645b;--accent:#e8722a;--danger:#b3261e;--line:#ddd5ca;}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#171513;--card:#24211e;--text:#f2eee8;--muted:#a59d92;--line:#3a3530;}}' +
  '*{box-sizing:border-box;}' +
  'body{font-family:-apple-system,Roboto,sans-serif;margin:0;padding:16px;background:var(--bg);color:var(--text);}' +
  'h1{font-size:22px;margin:0 0 4px;}h2{font-size:17px;margin:24px 0 8px;}' +
  '.hint{font-size:13px;color:var(--muted);margin:4px 0;}' +
  '.warn{font-size:13px;color:var(--danger);margin:4px 0;}' +
  '.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:12px;}' +
  '.card-head{display:flex;justify-content:space-between;align-items:center;}' +
  'label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px;}' +
  'input[type=time],input[type=text],input[type=url],select{width:100%;padding:9px;font-size:16px;' +
  'border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);}' +
  '.days{display:flex;gap:4px;}' +
  '.day{flex:1;margin:0;}.day input{display:none;}' +
  '.day span{display:block;text-align:center;padding:8px 0;border:1px solid var(--line);border-radius:8px;' +
  'font-size:14px;color:var(--text);}' +
  '.day input:checked+span{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}' +
  '.image-row{display:flex;gap:12px;align-items:flex-start;}' +
  '.preview{width:96px;min-width:96px;border-radius:6px;background:#000;image-rendering:pixelated;}' +
  '.placeholder{height:112px;display:flex;align-items:center;justify-content:center;color:#888;font-size:13px;}' +
  '.image-buttons{display:flex;flex-direction:column;gap:8px;flex:1;}' +
  '.image-buttons select{font-size:14px;padding:6px;}' +
  'button{padding:10px 14px;font-size:15px;border-radius:8px;border:1px solid var(--line);' +
  'background:var(--card);color:var(--text);}' +
  'button.link{border:none;background:none;padding:4px;}' +
  'button.danger{color:var(--danger);}' +
  'button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}' +
  'button:disabled{opacity:.5;}' +
  '#add{width:100%;border-style:dashed;}' +
  '.hidden{display:none;}' +
  '.actions{display:flex;gap:8px;margin-top:24px;}.actions button{flex:1;}' +
  'details{margin-top:8px;}summary{font-size:13px;color:var(--muted);}';

function buildSettingsHtml(data) {
  // Keep "</script>" in user text from closing the inline script.
  var json = JSON.stringify(data).replace(/</g, '\\u003c');
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Food Reminder</title><style>' + SETTINGS_CSS + '</style></head><body>' +
    '<h1>Food Reminder</h1>' +
    '<p class="hint">Add a reminder for each meal or snack. Each one wakes the ' +
    'watch app at its time and shows its message and image full screen.</p>' +
    '<h2>Reminders</h2>' +
    '<p id="empty" class="hint">No reminders yet. Add your first one below.</p>' +
    '<div id="list"></div>' +
    '<button id="add" type="button">+ Add reminder</button>' +
    '<h2>Timeline</h2>' +
    '<label for="timelineMode">Timeline pins</label>' +
    '<select id="timelineMode">' +
    '<option value="off">Off</option>' +
    '<option value="pins">Pins only (the app shows the alert)</option>' +
    '<option value="pinsAndAlerts">Pins with timeline reminder notification</option>' +
    '</select>' +
    '<p class="hint">Pins for the next few days appear in the timeline; selecting one ' +
    'offers "Show reminder" to open it full screen. The timeline notification is an ' +
    'extra buzz on top of the app\'s own alert.</p>' +
    '<p id="timelineStatus" class="hint"></p>' +
    '<details><summary>Advanced</summary>' +
    '<label for="timelineApi">Timeline API address</label>' +
    '<input id="timelineApi" type="url">' +
    '</details>' +
    '<p class="hint">Images are converted for your watch screen (<span id="screen"></span>).</p>' +
    '<div class="actions">' +
    '<button id="cancel" type="button">Cancel</button>' +
    '<button id="save" type="button" class="primary">Save</button>' +
    '</div>' +
    '<script>' + settingsPage.toString() + '\nsettingsPage(' + json + ');</script>' +
    '</body></html>';
}

function settingsData() {
  var reminders = loadReminders().map(function(r) {
    var image = r.hasImage ? loadImage(r.id) : null;
    return {
      id: r.id,
      hour: r.hour,
      minute: r.minute,
      days: r.days,
      text: r.text,
      hasImage: !!image,
      thumb: image ? image.thumb : null
    };
  });
  return {
    reminders: reminders,
    screen: screenInfo(),
    maxReminders: MAX_REMINDERS,
    maxTextChars: MAX_TEXT_CHARS,
    defaultText: DEFAULT_TEXT,
    timeline: {
      mode: timelineMode(),
      api: localStorage.getItem(TIMELINE_API_KEY) || '',
      defaultApi: DEFAULT_TIMELINE_API,
      status: localStorage.getItem(TIMELINE_STATUS_KEY) || ''
    }
  };
}

function applySettings(result) {
  var oldReminders = loadReminders();
  var keep = {};
  var reminders = [];

  var incoming = (result.reminders || []).slice(0, MAX_REMINDERS);
  for (var i = 0; i < incoming.length; i++) {
    var r = incoming[i];
    var id = parseInt(r.id, 10);
    if (!(id > 0) || keep[id]) {
      continue;
    }
    keep[id] = true;

    var hasImage = false;
    if (r.image && typeof r.image === 'object' && r.image.pixels) {
      writeJson(IMAGE_KEY_PREFIX + id, r.image);
      hasImage = true;
    } else if (r.image === 'keep' && loadImage(id)) {
      hasImage = true;
    } else {
      localStorage.removeItem(IMAGE_KEY_PREFIX + id);
    }

    reminders.push({
      id: id,
      hour: Math.max(0, Math.min(23, parseInt(r.hour, 10) || 0)),
      minute: Math.max(0, Math.min(59, parseInt(r.minute, 10) || 0)),
      days: (parseInt(r.days, 10) || 0) & 0x7F,
      text: String(r.text || '').slice(0, MAX_TEXT_CHARS),
      hasImage: hasImage
    });
  }

  for (var j = 0; j < oldReminders.length; j++) {
    if (!keep[oldReminders[j].id]) {
      localStorage.removeItem(IMAGE_KEY_PREFIX + oldReminders[j].id);
    }
  }

  reminders.sort(function(a, b) {
    return (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute);
  });
  writeJson(REMINDERS_KEY, reminders);
  localStorage.setItem(SYNC_DIRTY_KEY, '1');

  if (result.timeline) {
    var mode = result.timeline.mode;
    if (mode === 'off' || mode === 'pins' || mode === 'pinsAndAlerts') {
      localStorage.setItem(TIMELINE_MODE_KEY, mode);
    }
    if (typeof result.timeline.api === 'string') {
      localStorage.setItem(TIMELINE_API_KEY, result.timeline.api);
    }
  }
}

// --- Events ------------------------------------------------------------------

Pebble.addEventListener('ready', function() {
  enqueue({ JsReady: 1 });
  if (localStorage.getItem(SYNC_DIRTY_KEY)) {
    syncToWatch();
  }
  syncTimeline();
});

Pebble.addEventListener('appmessage', function(e) {
  var payload = e.payload;
  if (payload.WatchWidth !== undefined) {
    writeJson(WATCH_INFO_KEY, {
      w: payload.WatchWidth,
      h: payload.WatchHeight,
      color: !!payload.WatchColor
    });
  }
  if (payload.ImageRequest !== undefined) {
    sendImage(payload.ImageRequest);
  }
});

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildSettingsHtml(settingsData())));
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e.response) {
    return;
  }
  try {
    var result = JSON.parse(decodeURIComponent(e.response));
    if (result.action !== 'save') {
      return;
    }
    applySettings(result);
    syncToWatch();
    syncTimeline();
  } catch (err) {
    console.log('Food Reminder: could not read settings: ' + err.message);
  }
});

// Exposed for tests run under Node; PebbleKit JS ignores this.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    truncateUtf8: truncateUtf8,
    imageBytes: imageBytes,
    desiredPins: desiredPins,
    applySettings: applySettings,
    buildSettingsHtml: buildSettingsHtml,
    settingsData: settingsData,
    loadReminders: loadReminders
  };
}
