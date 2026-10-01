#include <pebble.h>

// Reminders live in persistent storage, which is limited to ~4 KB per app,
// so the list on the watch is capped. The settings page enforces the same cap.
#define MAX_REMINDERS 40
#define TEXT_LEN 64

// The OS allows at most 8 pending wakeups per app. Only the next few
// occurrences are scheduled; every launch schedules the following ones.
#define MAX_WAKEUPS 8
#define MAX_CANDIDATES 16

// Reminders this close together share one wakeup and are shown as pages.
#define MERGE_WINDOW_S 120

#define PERSIST_KEY_COUNT 1
#define PERSIST_KEY_REMINDER_BASE 100

// Must match IMAGE_FORMAT_* in src/pkjs/index.js.
#define IMAGE_FORMAT_8BIT 0
#define IMAGE_FORMAT_1BIT 1

#define IMAGE_RETRY_MS 1000
#define IMAGE_MAX_RETRIES 5

typedef struct {
  uint32_t id;
  uint8_t hour;
  uint8_t minute;
  uint8_t days;       // bit 0 = Sunday ... bit 6 = Saturday (tm_wday)
  uint8_t has_image;
  char text[TEXT_LEN];
} Reminder;

static Reminder s_reminders[MAX_REMINDERS];
static int s_count;

static time_t s_candidates[MAX_CANDIDATES];
static int s_candidate_count;
static time_t s_next_wakeup;

static Window *s_menu_window;
static MenuLayer *s_menu_layer;
static char s_header_buffer[32];

static Window *s_alert_window;
static BitmapLayer *s_bitmap_layer;
static TextLayer *s_time_layer;
static TextLayer *s_text_layer;
static TextLayer *s_page_layer;
static char s_time_buffer[16];
static char s_page_buffer[12];

static int s_alert_items[MAX_REMINDERS];
static int s_alert_count;
static int s_alert_pos;

static GBitmap *s_image;
static uint32_t s_image_id;        // reminder whose image is wanted, 0 = none
static bool s_image_ready;
static int s_image_src_row_bytes;
static int s_image_retries;
static AppTimer *s_image_timer;
static bool s_js_ready;

// --- Storage -----------------------------------------------------------------

static void load_reminders(void) {
  s_count = persist_exists(PERSIST_KEY_COUNT) ? persist_read_int(PERSIST_KEY_COUNT) : 0;
  if (s_count < 0 || s_count > MAX_REMINDERS) {
    s_count = 0;
  }
  for (int i = 0; i < s_count; i++) {
    memset(&s_reminders[i], 0, sizeof(Reminder));
    persist_read_data(PERSIST_KEY_REMINDER_BASE + i, &s_reminders[i], sizeof(Reminder));
    s_reminders[i].text[TEXT_LEN - 1] = '\0';
  }
}

static int find_reminder(uint32_t id) {
  for (int i = 0; i < s_count; i++) {
    if (s_reminders[i].id == id) {
      return i;
    }
  }
  return -1;
}

// --- Formatting --------------------------------------------------------------

static void format_clock(int hour, int minute, char *buf, size_t size) {
  if (clock_is_24h_style()) {
    snprintf(buf, size, "%02d:%02d", hour, minute);
  } else {
    int h12 = hour % 12 == 0 ? 12 : hour % 12;
    snprintf(buf, size, "%d:%02d %s", h12, minute, hour < 12 ? "AM" : "PM");
  }
}

static void format_days(uint8_t days, char *buf, size_t size) {
  static const char *names[7] = { "Su", "Mo", "Tu", "We", "Th", "Fr", "Sa" };
  days &= 0x7F;

  if (days == 0x7F) {
    snprintf(buf, size, "Every day");
  } else if (days == 0x3E) {
    snprintf(buf, size, "Weekdays");
  } else if (days == 0x41) {
    snprintf(buf, size, "Weekends");
  } else if (days == 0) {
    snprintf(buf, size, "No days");
  } else {
    buf[0] = '\0';
    // Monday first; k = 7 wraps to Sunday.
    for (int k = 1; k <= 7; k++) {
      int wday = k % 7;
      if (days & (1 << wday)) {
        if (buf[0]) {
          strncat(buf, " ", size - strlen(buf) - 1);
        }
        strncat(buf, names[wday], size - strlen(buf) - 1);
      }
    }
  }
}

// --- Wakeup scheduling -------------------------------------------------------

static void add_candidate(time_t t) {
  int pos = s_candidate_count;
  for (int i = 0; i < s_candidate_count; i++) {
    if (s_candidates[i] == t) {
      return;
    }
    if (t < s_candidates[i]) {
      pos = i;
      break;
    }
  }
  if (pos >= MAX_CANDIDATES) {
    return;
  }

  int last = s_candidate_count < MAX_CANDIDATES ? s_candidate_count : MAX_CANDIDATES - 1;
  for (int i = last; i > pos; i--) {
    s_candidates[i] = s_candidates[i - 1];
  }
  s_candidates[pos] = t;
  if (s_candidate_count < MAX_CANDIDATES) {
    s_candidate_count++;
  }
}

static void schedule_wakeups(void) {
  wakeup_cancel_all();
  s_candidate_count = 0;
  s_next_wakeup = 0;

  time_t now = time(NULL);
  for (int i = 0; i < s_count; i++) {
    Reminder *r = &s_reminders[i];
    for (int wday = 0; wday < 7; wday++) {
      if (!(r->days & (1 << wday))) {
        continue;
      }
      // WeekDay is SUNDAY = 1 ... SATURDAY = 7.
      time_t t = clock_to_timestamp((WeekDay)(wday + 1), r->hour, r->minute);
      while (t <= now) {
        t += 7 * SECONDS_PER_DAY;
      }
      add_candidate(t);
    }
  }

  int scheduled = 0;
  time_t last = 0;
  for (int i = 0; i < s_candidate_count && scheduled < MAX_WAKEUPS; i++) {
    time_t t = s_candidates[i];
    if (scheduled > 0 && t - last < MERGE_WINDOW_S) {
      continue;  // shown together with the previous wakeup
    }

    // The cookie carries the intended minute, so a wakeup shifted by E_RANGE
    // (another app already has one at that minute) still shows the right items.
    int32_t cookie = (int32_t)(t / 60);
    WakeupId id = wakeup_schedule(t, cookie, true);
    if (id == E_RANGE) {
      id = wakeup_schedule(t + 60, cookie, true);
    }

    if (id >= 0) {
      if (scheduled == 0) {
        s_next_wakeup = t;
      }
      scheduled++;
      last = t;
    } else {
      APP_LOG(APP_LOG_LEVEL_WARNING, "wakeup_schedule failed: %d", (int)id);
    }
  }
}

// --- AppMessage helpers ------------------------------------------------------

static int32_t tuple_int(const Tuple *t) {
  switch (t->length) {
    case 1: return t->type == TUPLE_INT ? t->value->int8 : t->value->uint8;
    case 2: return t->type == TUPLE_INT ? t->value->int16 : t->value->uint16;
    default: return t->type == TUPLE_INT ? t->value->int32 : (int32_t)t->value->uint32;
  }
}

// --- Image transfer ----------------------------------------------------------

static void image_retry_callback(void *data);

static void destroy_image(void) {
  if (s_bitmap_layer) {
    bitmap_layer_set_bitmap(s_bitmap_layer, NULL);
  }
  if (s_image) {
    gbitmap_destroy(s_image);
    s_image = NULL;
  }
  s_image_ready = false;
}

static void schedule_image_retry(void) {
  if (s_image_timer || s_image_retries >= IMAGE_MAX_RETRIES) {
    return;
  }
  s_image_retries++;
  s_image_timer = app_timer_register(IMAGE_RETRY_MS, image_retry_callback, NULL);
}

static void send_image_request(void) {
  if (!s_image_id || s_image_ready || s_image) {
    return;
  }

  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    schedule_image_retry();
    return;
  }
  dict_write_uint32(iter, MESSAGE_KEY_ImageRequest, s_image_id);
  if (app_message_outbox_send() != APP_MSG_OK) {
    schedule_image_retry();
  }
}

static void image_retry_callback(void *data) {
  s_image_timer = NULL;
  send_image_request();
}

static void request_image(uint32_t id) {
  destroy_image();
  s_image_id = id;
  s_image_retries = 0;
  if (s_image_timer) {
    app_timer_cancel(s_image_timer);
    s_image_timer = NULL;
  }
  // Before PebbleKit JS reports ready, the request would be lost; it is sent
  // from the JsReady handler instead.
  if (id && s_js_ready) {
    send_image_request();
  }
}

static void copy_image_chunk(uint32_t offset, const uint8_t *src, uint16_t len) {
  uint8_t *data = gbitmap_get_data(s_image);
  uint16_t stride = gbitmap_get_bytes_per_row(s_image);
  int height = gbitmap_get_bounds(s_image).size.h;
  uint32_t total = (uint32_t)s_image_src_row_bytes * height;

  while (len > 0 && offset < total) {
    int row = offset / s_image_src_row_bytes;
    int col = offset % s_image_src_row_bytes;
    int n = s_image_src_row_bytes - col;
    if (n > len) {
      n = len;
    }
    memcpy(data + row * stride + col, src, n);
    offset += n;
    src += n;
    len -= n;
  }
}

static void alert_update_layout(void);

static void handle_image_message(DictionaryIterator *iter, Tuple *id_tuple) {
  if (!s_image_id || (uint32_t)tuple_int(id_tuple) != s_image_id) {
    return;  // stale transfer for an image no longer on screen
  }

  Tuple *w = dict_find(iter, MESSAGE_KEY_ImageWidth);
  Tuple *h = dict_find(iter, MESSAGE_KEY_ImageHeight);
  Tuple *fmt = dict_find(iter, MESSAGE_KEY_ImageFormat);
  if (w && h && fmt) {
    destroy_image();
    int width = tuple_int(w);
    int height = tuple_int(h);
    bool one_bit = tuple_int(fmt) == IMAGE_FORMAT_1BIT;
    s_image = gbitmap_create_blank(GSize(width, height),
                                   one_bit ? GBitmapFormat1Bit : GBitmapFormat8Bit);
    s_image_src_row_bytes = one_bit ? (width + 7) / 8 : width;
    if (!s_image) {
      APP_LOG(APP_LOG_LEVEL_ERROR, "Not enough memory for %dx%d image", width, height);
    }
  }

  Tuple *offset = dict_find(iter, MESSAGE_KEY_ImageOffset);
  Tuple *data = dict_find(iter, MESSAGE_KEY_ImageData);
  if (offset && data && s_image) {
    copy_image_chunk((uint32_t)tuple_int(offset), data->value->data, data->length);
  }

  Tuple *done = dict_find(iter, MESSAGE_KEY_ImageDone);
  if (done) {
    if (tuple_int(done) && s_image) {
      s_image_ready = true;
      if (s_bitmap_layer) {
        bitmap_layer_set_bitmap(s_bitmap_layer, s_image);
      }
    } else {
      destroy_image();
      s_image_id = 0;  // phone has no image for it; don't ask again
    }
    alert_update_layout();
  }
}

// --- Alert window ------------------------------------------------------------

static void alert_update_layout(void) {
  if (!s_alert_window || !s_text_layer) {
    return;
  }

  Layer *root = window_get_root_layer(s_alert_window);
  GRect bounds = layer_get_bounds(root);
  int16_t inset = PBL_IF_ROUND_ELSE(18, 4);
  GFont font;

  layer_set_hidden(bitmap_layer_get_layer(s_bitmap_layer), !s_image_ready);

  if (s_image_ready) {
    // Full-screen image with the message in a band along the bottom.
    window_set_background_color(s_alert_window, GColorBlack);
    font = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
    GRect box = GRect(inset, 0, bounds.size.w - 2 * inset, bounds.size.h / 2);
    GSize size = graphics_text_layout_get_content_size(
        text_layer_get_text(s_text_layer), font, box,
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter);
    int16_t band = size.h + PBL_IF_ROUND_ELSE(24, 10);

    layer_set_frame(text_layer_get_layer(s_text_layer),
                    GRect(0, bounds.size.h - band, bounds.size.w, band));
    text_layer_set_background_color(s_text_layer, GColorBlack);
    text_layer_set_text_color(s_text_layer, GColorWhite);
    text_layer_set_text_color(s_time_layer, GColorWhite);
    text_layer_set_background_color(s_time_layer, GColorBlack);
    text_layer_set_text_color(s_page_layer, GColorWhite);
  } else {
    window_set_background_color(s_alert_window, PBL_IF_COLOR_ELSE(GColorRajah, GColorWhite));
    font = fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD);
    int16_t top = bounds.size.h / 5;
    layer_set_frame(text_layer_get_layer(s_text_layer),
                    GRect(inset, top, bounds.size.w - 2 * inset, bounds.size.h - top - 24));
    text_layer_set_background_color(s_text_layer, GColorClear);
    text_layer_set_text_color(s_text_layer, GColorBlack);
    text_layer_set_text_color(s_time_layer, GColorBlack);
    text_layer_set_background_color(s_time_layer, GColorClear);
    text_layer_set_text_color(s_page_layer, GColorBlack);
  }
  text_layer_set_font(s_text_layer, font);
}

static void alert_show_current(void) {
  if (s_alert_count == 0) {
    return;
  }
  Reminder *r = &s_reminders[s_alert_items[s_alert_pos]];

  format_clock(r->hour, r->minute, s_time_buffer, sizeof(s_time_buffer));
  text_layer_set_text(s_time_layer, s_time_buffer);
  text_layer_set_text(s_text_layer, r->text);

  if (s_alert_count > 1) {
    snprintf(s_page_buffer, sizeof(s_page_buffer), "%d/%d", s_alert_pos + 1, s_alert_count);
  } else {
    s_page_buffer[0] = '\0';
  }
  text_layer_set_text(s_page_layer, s_page_buffer);

  request_image(r->has_image ? r->id : 0);
  alert_update_layout();
}

static void alert_up_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_alert_pos > 0) {
    s_alert_pos--;
    alert_show_current();
  }
}

static void alert_down_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_alert_pos < s_alert_count - 1) {
    s_alert_pos++;
    alert_show_current();
  }
}

static void alert_click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, alert_up_handler);
  window_single_click_subscribe(BUTTON_ID_DOWN, alert_down_handler);
  window_single_click_subscribe(BUTTON_ID_SELECT, alert_down_handler);
}

static void alert_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_bitmap_layer = bitmap_layer_create(bounds);
  bitmap_layer_set_alignment(s_bitmap_layer, GAlignCenter);
  layer_add_child(root, bitmap_layer_get_layer(s_bitmap_layer));

  int16_t top = PBL_IF_ROUND_ELSE(10, 0);
  s_time_layer = text_layer_create(GRect(0, top, bounds.size.w, 24));
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_time_layer));

  s_text_layer = text_layer_create(bounds);
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeTrailingEllipsis);
  layer_add_child(root, text_layer_get_layer(s_text_layer));

  int16_t page_x = PBL_IF_ROUND_ELSE(bounds.size.w / 2 + 30, bounds.size.w - 40);
  s_page_layer = text_layer_create(GRect(page_x, top, 36, 24));
  text_layer_set_background_color(s_page_layer, GColorClear);
  text_layer_set_font(s_page_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_page_layer, GTextAlignmentRight);
  layer_add_child(root, text_layer_get_layer(s_page_layer));

  alert_show_current();
}

static void alert_window_unload(Window *window) {
  request_image(0);
  bitmap_layer_destroy(s_bitmap_layer);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_text_layer);
  text_layer_destroy(s_page_layer);
  s_bitmap_layer = NULL;
  s_time_layer = NULL;
  s_text_layer = NULL;
  s_page_layer = NULL;
  window_destroy(s_alert_window);
  s_alert_window = NULL;
}

// Shows s_alert_items, reusing the window if it is already open.
static void open_alert_window(void) {
  s_alert_pos = 0;
  if (s_alert_window) {
    alert_show_current();
    return;
  }
  s_alert_window = window_create();
  window_set_click_config_provider(s_alert_window, alert_click_config_provider);
  window_set_window_handlers(s_alert_window, (WindowHandlers) {
    .load = alert_window_load,
    .unload = alert_window_unload,
  });
  window_stack_push(s_alert_window, true);
}

// Collects reminders due within MERGE_WINDOW_S of the wakeup's intended time.
static bool show_due(time_t when) {
  struct tm *tm = localtime(&when);
  int wday = tm->tm_wday;
  int minute_of_day = tm->tm_hour * 60 + tm->tm_min;

  s_alert_count = 0;
  for (int i = 0; i < s_count; i++) {
    Reminder *r = &s_reminders[i];
    int m = r->hour * 60 + r->minute;
    if ((r->days & (1 << wday)) && m >= minute_of_day &&
        m < minute_of_day + MERGE_WINDOW_S / 60) {
      s_alert_items[s_alert_count++] = i;
    }
  }
  if (s_alert_count == 0) {
    return false;
  }

  light_enable_interaction();
  vibes_long_pulse();
  open_alert_window();
  return true;
}

static bool show_single(int index) {
  if (index < 0 || index >= s_count) {
    return false;
  }
  s_alert_items[0] = index;
  s_alert_count = 1;
  open_alert_window();
  return true;
}

static void wakeup_handler(WakeupId id, int32_t cookie) {
  schedule_wakeups();
  show_due((time_t)cookie * 60);
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
}

// --- Menu window -------------------------------------------------------------

static uint16_t menu_get_num_rows(MenuLayer *menu_layer, uint16_t section, void *context) {
  return s_count > 0 ? s_count : 1;
}

static int16_t menu_get_header_height(MenuLayer *menu_layer, uint16_t section, void *context) {
  return MENU_CELL_BASIC_HEADER_HEIGHT;
}

static void menu_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *context) {
  if (s_next_wakeup) {
    struct tm *tm = localtime(&s_next_wakeup);
    char clock[12];
    format_clock(tm->tm_hour, tm->tm_min, clock, sizeof(clock));
    char day[4];
    strftime(day, sizeof(day), "%a", tm);
    snprintf(s_header_buffer, sizeof(s_header_buffer), "Next: %s %s", day, clock);
  } else {
    snprintf(s_header_buffer, sizeof(s_header_buffer), "Food Reminder");
  }
  menu_cell_basic_header_draw(ctx, cell_layer, s_header_buffer);
}

static void menu_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *cell_index, void *context) {
  if (s_count == 0) {
    menu_cell_basic_draw(ctx, cell_layer, "No reminders", "Add them in the phone settings", NULL);
    return;
  }

  Reminder *r = &s_reminders[cell_index->row];
  char clock[12];
  char days[24];
  char title[40];
  format_clock(r->hour, r->minute, clock, sizeof(clock));
  format_days(r->days, days, sizeof(days));
  snprintf(title, sizeof(title), "%s  %s", clock, days);
  menu_cell_basic_draw(ctx, cell_layer, title, r->text, NULL);
}

static void menu_select(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  show_single(cell_index->row);
}

static void menu_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_menu_layer = menu_layer_create(layer_get_bounds(root));
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_rows = menu_get_num_rows,
    .get_header_height = menu_get_header_height,
    .draw_header = menu_draw_header,
    .draw_row = menu_draw_row,
    .select_click = menu_select,
  });
#ifdef PBL_COLOR
  menu_layer_set_highlight_colors(s_menu_layer, GColorOrange, GColorWhite);
#endif
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void menu_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

// --- Messages from the phone -------------------------------------------------

static void send_watch_info(void) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    return;
  }
  GRect bounds = layer_get_bounds(window_get_root_layer(
      s_alert_window ? s_alert_window : s_menu_window));
  dict_write_int32(iter, MESSAGE_KEY_WatchWidth, bounds.size.w);
  dict_write_int32(iter, MESSAGE_KEY_WatchHeight, bounds.size.h);
  dict_write_int32(iter, MESSAGE_KEY_WatchColor, PBL_IF_COLOR_ELSE(1, 0));
  if (s_image_id && !s_image_ready && !s_image) {
    dict_write_uint32(iter, MESSAGE_KEY_ImageRequest, s_image_id);
  }
  app_message_outbox_send();
}

static void handle_sync_message(DictionaryIterator *iter, Tuple *count_tuple) {
  int count = tuple_int(count_tuple);
  if (count < 0) {
    count = 0;
  }
  if (count > MAX_REMINDERS) {
    count = MAX_REMINDERS;
  }

  Tuple *index_tuple = dict_find(iter, MESSAGE_KEY_SyncIndex);
  if (index_tuple) {
    int i = tuple_int(index_tuple);
    if (i < 0 || i >= count) {
      return;
    }

    Reminder r;
    memset(&r, 0, sizeof(r));
    Tuple *t;
    if ((t = dict_find(iter, MESSAGE_KEY_RemId))) r.id = (uint32_t)tuple_int(t);
    if ((t = dict_find(iter, MESSAGE_KEY_RemHour))) r.hour = tuple_int(t);
    if ((t = dict_find(iter, MESSAGE_KEY_RemMinute))) r.minute = tuple_int(t);
    if ((t = dict_find(iter, MESSAGE_KEY_RemDays))) r.days = tuple_int(t);
    if ((t = dict_find(iter, MESSAGE_KEY_RemHasImage))) r.has_image = tuple_int(t) ? 1 : 0;
    if ((t = dict_find(iter, MESSAGE_KEY_RemText))) {
      strncpy(r.text, t->value->cstring, TEXT_LEN - 1);
    }

    s_reminders[i] = r;
    persist_write_data(PERSIST_KEY_REMINDER_BASE + i, &r, sizeof(r));

    if (i != count - 1) {
      return;  // the list is committed with its last entry
    }
  }

  for (int i = count; i < s_count; i++) {
    persist_delete(PERSIST_KEY_REMINDER_BASE + i);
  }
  s_count = count;
  persist_write_int(PERSIST_KEY_COUNT, s_count);

  schedule_wakeups();
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
}

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
  if (dict_find(iter, MESSAGE_KEY_JsReady)) {
    s_js_ready = true;
    s_image_retries = 0;
    send_watch_info();
  }

  Tuple *count_tuple = dict_find(iter, MESSAGE_KEY_SyncCount);
  if (count_tuple) {
    handle_sync_message(iter, count_tuple);
  }

  Tuple *image_tuple = dict_find(iter, MESSAGE_KEY_ImageId);
  if (image_tuple) {
    handle_image_message(iter, image_tuple);
  }
}

static void outbox_failed_callback(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (s_image_id && !s_image_ready && !s_image) {
    schedule_image_retry();
  }
}

// --- App lifecycle -----------------------------------------------------------

static void init(void) {
  load_reminders();

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_open(2048, 128);

  wakeup_service_subscribe(wakeup_handler);

  s_menu_window = window_create();
  window_set_window_handlers(s_menu_window, (WindowHandlers) {
    .load = menu_window_load,
    .unload = menu_window_unload,
  });

  bool shown = false;
  AppLaunchReason reason = launch_reason();
  if (reason == APP_LAUNCH_WAKEUP) {
    WakeupId id;
    int32_t cookie;
    if (wakeup_get_launch_event(&id, &cookie)) {
      shown = show_due((time_t)cookie * 60);
    }
  } else if (reason == APP_LAUNCH_TIMELINE_ACTION) {
    // The timeline pin's "Show reminder" action passes the reminder id.
    shown = show_single(find_reminder(launch_get_args()));
  }

  // Launched for a reminder: show only that, so Back exits to the watchface.
  if (!shown) {
    window_stack_push(s_menu_window, true);
  }

  schedule_wakeups();
}

static void deinit(void) {
  destroy_image();
  window_destroy(s_menu_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
