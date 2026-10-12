/*
 * Visione-X reference firmware for ESP32 sensor devices.
 *
 * Reads the configured sensors every VX_INTERVAL_SEC seconds and sends them to the
 * Visione-X ingest API:
 *
 *   POST /api/v1/ingest
 *   Authorization: Bearer vxs_…
 *   {"ts": <unix seconds>, "fw": "...", "readings": [{"channel": "temp", "value": 4.2}, ...]}
 *
 * - "ts" is sent only once the clock is set by NTP; otherwise the server timestamps it.
 * - HTTP 429 (rate limited) honours retryAfterSec; network errors back off up to 5 minutes.
 * - 401/403 (wrong key, device disabled, plan without sensors) are logged and retried slowly.
 *
 * Board: any ESP32 with the Arduino core (2.x or 3.x). Setup: see README.md.
 */
#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <time.h>

#include "config.h"

#if VX_USE_DHT22
#include <DHT.h>
DHT dht(VX_DHT_PIN, DHT22);
#endif

static uint32_t backoffSec = 0;

static void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("Wi-Fi: connecting to %s\n", VX_WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(VX_WIFI_SSID, VX_WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Wi-Fi: connected, IP %s\n", WiFi.localIP().toString().c_str());
    // UTC: the API expects Unix time, whatever the local time zone.
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  } else {
    Serial.println("Wi-Fi: not connected");
  }
}

/** Unix seconds once NTP has set the clock, else 0 (then "ts" is omitted). */
static time_t unixTime() {
  time_t now = time(nullptr);
  return now > 1700000000 ? now : 0;
}

/** Appends `"channel":value` readings; returns how many were added. */
static int collectReadings(String &json) {
  int n = 0;
  auto add = [&](const char *channel, const String &value) {
    json += n ? "," : "";
    json += "{\"channel\":\"";
    json += channel;
    json += "\",\"value\":";
    json += value;
    json += "}";
    n++;
  };
#if VX_USE_DHT22
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  // A failed DHT read returns NaN: skip it rather than send a bogus value.
  if (!isnan(t)) add(VX_CH_TEMP, String(t, 1));
  if (!isnan(h)) add(VX_CH_HUMIDITY, String(h, 1));
#endif
#if VX_USE_DOOR
  add(VX_CH_DOOR, digitalRead(VX_DOOR_PIN) == HIGH ? "true" : "false");  // pull-up: open = HIGH
#endif
  return n;
}

/** Sends one batch; returns the HTTP status (negative for network errors). */
static int sendReadings(const String &readings, uint32_t &retryAfterSec) {
  String body = "{\"fw\":\"" VX_FIRMWARE "\"";
  time_t ts = unixTime();
  if (ts) body += ",\"ts\":" + String((unsigned long)ts);
  body += ",\"readings\":[" + readings + "]}";

  HTTPClient http;
  WiFiClientSecure secure;
  WiFiClient plain;
  bool tls = String(VX_INGEST_URL).startsWith("https://");
  if (tls) {
#if VX_ALLOW_INSECURE_TLS
    secure.setInsecure();
#else
    secure.setCACert(VX_ROOT_CA);
#endif
    http.begin(secure, VX_INGEST_URL);
  } else {
    http.begin(plain, VX_INGEST_URL);
  }
  http.setTimeout(15000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " VX_API_KEY);
  int status = http.POST(body);
  String response = status > 0 ? http.getString() : http.errorToString(status);
  http.end();

  Serial.printf("POST %d %s\n", status, response.c_str());
  retryAfterSec = 0;
  if (status == 429) {
    int i = response.indexOf("\"retryAfterSec\":");
    retryAfterSec = i >= 0 ? response.substring(i + 16).toInt() : 30;
  }
  return status;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("Visione-X sensor " VX_FIRMWARE);
#if VX_USE_DHT22
  dht.begin();
#endif
#if VX_USE_DOOR
  pinMode(VX_DOOR_PIN, INPUT_PULLUP);
#endif
  connectWifi();
}

void loop() {
  connectWifi();
  uint32_t waitSec = VX_INTERVAL_SEC;
  if (WiFi.status() == WL_CONNECTED) {
    String readings;
    if (collectReadings(readings) > 0) {
      uint32_t retryAfter = 0;
      int status = sendReadings(readings, retryAfter);
      if (status >= 200 && status < 300) {
        backoffSec = 0;
      } else if (status == 429) {
        waitSec = max<uint32_t>(retryAfter, 10);
      } else if (status == 401 || status == 403) {
        // Wrong key, disabled device or inactive org: nothing will change quickly.
        waitSec = 600;
      } else if (status == 400 || status == 422) {
        // Bad payload / unknown channel keys: fix config.h or the channels in the web app.
        waitSec = VX_INTERVAL_SEC;
      } else {
        backoffSec = backoffSec ? min<uint32_t>(backoffSec * 2, 300) : 15;
        waitSec = backoffSec;
      }
    }
  } else {
    backoffSec = backoffSec ? min<uint32_t>(backoffSec * 2, 300) : 15;
    waitSec = backoffSec;
  }
  delay(waitSec * 1000UL);
}
