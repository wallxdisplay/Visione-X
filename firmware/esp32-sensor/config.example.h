// Copy this file to config.h (which is git-ignored) and fill in your values.
// Never commit config.h: it holds the device's API key and Wi-Fi password.
#pragma once

// ---- Wi-Fi
#define WXP_WIFI_SSID "your-wifi"
#define WXP_WIFI_PASSWORD "your-wifi-password"

// ---- WallX Play
// Production: https://wallx-play.web.app/api/v1/ingest
// Local emulator (same network, http only, testing): http://<your-pc-ip>:5001/demo-wallx-play/asia-south1/api/v1/ingest
#define WXP_INGEST_URL "https://wallx-play.web.app/api/v1/ingest"
// From Sensors → Add sensor device (shown once). Starts with wxp_.
#define WXP_API_KEY "wxp_REPLACE_ME"
#define WXP_FIRMWARE "wxp-esp32 1.0.0"

// Seconds between readings. The server accepts at most one request every 10 s on average.
#define WXP_INTERVAL_SEC 60

// ---- Sensors (channel keys must match the channels created in the web app)
// DHT22 temperature / humidity on a GPIO (needs the "DHT sensor library" by Adafruit).
#define WXP_USE_DHT22 1
#define WXP_DHT_PIN 4
#define WXP_CH_TEMP "temp"
#define WXP_CH_HUMIDITY "humidity"

// Door / reed switch to GND on a GPIO (internal pull-up): sends true when open.
#define WXP_USE_DOOR 1
#define WXP_DOOR_PIN 27
#define WXP_CH_DOOR "door"

// ---- TLS
// Root certificate of the server, PEM. Get it with:
//   openssl s_client -showcerts -connect wallx-play.web.app:443 </dev/null
// and paste the LAST certificate of the chain (the root) here. Keep it up to date: if the
// hosting provider changes its root CA, devices with an old certificate stop connecting.
static const char WXP_ROOT_CA[] = R"PEM(
-----BEGIN CERTIFICATE-----
PASTE THE ROOT CERTIFICATE HERE
-----END CERTIFICATE-----
)PEM";

// Bench testing only: skip certificate checks. Never ship devices with this set to 1.
#define WXP_ALLOW_INSECURE_TLS 0
