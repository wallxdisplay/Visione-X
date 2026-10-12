# ESP32 sensor firmware (reference)

A minimal Arduino sketch that sends readings from an ESP32 to Visione-X. It reads a DHT22
temperature/humidity sensor and a door (reed) switch. Use it as-is or as a starting point for
other sensors: any device that can make an HTTPS POST can use the same API.

## Set up the device in Visione-X
1. **Sensors → Add sensor device.** Copy the API key (`vxs_…`). It is shown only once.
2. On the device page, **add a channel** for each value the firmware sends. The channel *key*
   must match the firmware: `temp` (Number, °C), `humidity` (Number, %), `door` (On / off).
3. Optional: add alert rules (e.g. `temp > 8`, `door == 1`) and a valid range (e.g. −40…85 °C
   for a DHT22) so faulty readings are rejected.

## Build and flash
1. Install the Arduino IDE (or `arduino-cli`) with the **esp32** board package (Espressif).
2. Library Manager → install **DHT sensor library** (Adafruit) and **Adafruit Unified Sensor**
   (only needed with `VX_USE_DHT22 1`).
3. Copy `config.example.h` to `config.h` and fill in the Wi-Fi, ingest URL, API key and the
   server's root certificate (see the comment in the file). `config.h` is git-ignored.
4. Select your board (e.g. *ESP32 Dev Module*), flash, and open the serial monitor at 115200
   baud. Each upload prints a line like `POST 200 {"accepted":3,...}`.

Wiring: DHT22 data → GPIO 4 (with a 10 kΩ pull-up to 3.3 V); reed switch between GPIO 27
and GND (internal pull-up, so "open" reads HIGH and is sent as `true`).

## The API
`POST /api/v1/ingest` with `Authorization: Bearer <key>` and a JSON body:

```json
{ "ts": 1791806476, "fw": "vx-esp32 1.0.0", "readings": [{ "channel": "temp", "value": 4.2 }, { "channel": "door", "value": false }] }
```

| Field | Notes |
|---|---|
| `readings` | 1–16 items; `value` is a number, or `true`/`false` for on/off channels |
| `ts` | Unix seconds (or ms). Omit it until the clock is set; the server then uses its own time. Times more than 10 minutes off are rejected (`clock_skew`) |
| `fw` | Optional firmware version, shown on the device page |
| `deviceId` | Optional; when sent it must match the key's device |

Responses: `200` with `{accepted, rejected[]}` (rejected readings name the channel and a reason:
`unknown_channel`, `wrong_type`, `out_of_range`, `duplicate`); `422` when nothing was accepted;
`401` unknown key; `403` device disabled, organization inactive or plan without sensors;
`429` too many requests (`retryAfterSec` says when to try again). Each device may send bursts
of up to 6 requests and about one every 10 seconds on average; one request per minute is
plenty for most sensors.

## Security
- The key identifies one device; the server stores only its hash. If it leaks, open the device
  in Visione-X and **Rotate key**, then flash the new key.
- Keep certificate checking on (`VX_ALLOW_INSECURE_TLS 0`) for real deployments.
- Local testing against the emulator is plain HTTP on your LAN; use it only on a trusted network.
