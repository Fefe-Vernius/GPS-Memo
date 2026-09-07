#include <pebble.h>

#define STATUS_RESET_MS 2000
#define LONG_PRESS_MS 2000

static Window *s_window;
static TextLayer *s_time_layer;
static TextLayer *s_lat_layer;
static TextLayer *s_lon_layer;
static TextLayer *s_status_layer;

static char s_time_buffer[32];
static char s_lat_buffer[24] = "Lat: --";
static char s_lon_buffer[24] = "Lon: --";

static AppTimer *s_status_timer;

static void status_reset_callback(void *data) {
  text_layer_set_text(s_status_layer, "Hold SELECT to save");
}

static void update_time(void) {
  time_t now = time(NULL);
  struct tm *tick_time = localtime(&now);

  strftime(s_time_buffer, sizeof(s_time_buffer), "%Y%m%d_%Z_%H%M%S", tick_time);
  text_layer_set_text(s_time_layer, s_time_buffer);
}

static void tick_handler(struct tm *tick_time, TimeUnits units_changed) {
  update_time();
}

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *lat_tuple = dict_find(iterator, MESSAGE_KEY_Latitude);
  Tuple *lon_tuple = dict_find(iterator, MESSAGE_KEY_Longitude);
  Tuple *ack_tuple = dict_find(iterator, MESSAGE_KEY_SaveAck);

  if (lat_tuple) {
    snprintf(s_lat_buffer, sizeof(s_lat_buffer), "Lat: %s", lat_tuple->value->cstring);
    text_layer_set_text(s_lat_layer, s_lat_buffer);
  }

  if (lon_tuple) {
    snprintf(s_lon_buffer, sizeof(s_lon_buffer), "Lon: %s", lon_tuple->value->cstring);
    text_layer_set_text(s_lon_layer, s_lon_buffer);
  }

  if (ack_tuple) {
    if (s_status_timer) {
      app_timer_cancel(s_status_timer);
    }
    text_layer_set_text(s_status_layer, "Saved!");
    vibes_short_pulse();
    s_status_timer = app_timer_register(STATUS_RESET_MS, status_reset_callback, NULL);
  }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
  text_layer_set_text(s_status_layer, "Message dropped");
  if (s_status_timer) {
    app_timer_cancel(s_status_timer);
  }
  s_status_timer = app_timer_register(STATUS_RESET_MS, status_reset_callback, NULL);
}

static void outbox_failed_callback(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  text_layer_set_text(s_status_layer, "Save failed");
  if (s_status_timer) {
    app_timer_cancel(s_status_timer);
  }
  s_status_timer = app_timer_register(STATUS_RESET_MS, status_reset_callback, NULL);
}

static void long_click_handler(ClickRecognizerRef recognizer, void *context) {
  DictionaryIterator *iter;
  app_message_outbox_begin(&iter);
  dict_write_cstring(iter, MESSAGE_KEY_SaveEntry, s_time_buffer);
  app_message_outbox_send();

  text_layer_set_text(s_status_layer, "Saving...");
}

static void click_config_provider(void *context) {
  window_long_click_subscribe(BUTTON_ID_SELECT, LONG_PRESS_MS, long_click_handler, NULL);
}

static void window_load(Window *window) {
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  int16_t inset = PBL_IF_ROUND_ELSE(14, 4);
  int16_t w = bounds.size.w - (2 * inset);
  int16_t h = bounds.size.h;

  s_time_layer = text_layer_create(GRect(inset, (int16_t)(h * 0.04), w, (int16_t)(h * 0.24)));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, GColorBlack);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_time_layer, GTextOverflowModeWordWrap);
  layer_add_child(window_layer, text_layer_get_layer(s_time_layer));

  s_lat_layer = text_layer_create(GRect(inset, (int16_t)(h * 0.32), w, (int16_t)(h * 0.16)));
  text_layer_set_background_color(s_lat_layer, GColorClear);
  text_layer_set_text_color(s_lat_layer, GColorBlack);
  text_layer_set_font(s_lat_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_lat_layer, GTextAlignmentCenter);
  layer_add_child(window_layer, text_layer_get_layer(s_lat_layer));

  s_lon_layer = text_layer_create(GRect(inset, (int16_t)(h * 0.50), w, (int16_t)(h * 0.16)));
  text_layer_set_background_color(s_lon_layer, GColorClear);
  text_layer_set_text_color(s_lon_layer, GColorBlack);
  text_layer_set_font(s_lon_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_lon_layer, GTextAlignmentCenter);
  layer_add_child(window_layer, text_layer_get_layer(s_lon_layer));

  s_status_layer = text_layer_create(GRect(inset, (int16_t)(h * 0.80), w, (int16_t)(h * 0.18)));
  text_layer_set_background_color(s_status_layer, GColorClear);
  text_layer_set_text_color(s_status_layer, GColorDarkGray);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_text(s_status_layer, "Hold SELECT to save");
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));

  text_layer_set_text(s_lat_layer, s_lat_buffer);
  text_layer_set_text(s_lon_layer, s_lon_buffer);

  update_time();
}

static void window_unload(Window *window) {
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_lat_layer);
  text_layer_destroy(s_lon_layer);
  text_layer_destroy(s_status_layer);
}

static void init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load,
    .unload = window_unload,
  });
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received_callback);
  app_message_register_inbox_dropped(inbox_dropped_callback);
  app_message_register_outbox_failed(outbox_failed_callback);
  app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum());

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
