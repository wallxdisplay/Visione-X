/**
 * MQTT sensors (Enterprise, `sensor.mqtt`). A customer's MQTT broker usually sits on their own
 * network, out of reach of the cloud, so a WallX screen at the site is the bridge: its player
 * connects to the broker, subscribes to the topics of the org's MQTT sensor channels and
 * forwards the latest values to POST /api/v1/devices/mqtt/readings, which runs the same ingest
 * core as ESP32 devices (channels, history, alerts, widgets).
 *
 * orgs/{orgId}/mqttBrokers/{id} holds the connection (readable with sensor.view); the password
 * lives in the server-only orgs/{orgId}/mqttBrokerSecrets/{id} and only reaches the bridge
 * screen's player (GET /api/v1/devices/mqtt).
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const MAX_MQTT_BROKERS = 10;
/** The bridge sends each channel's latest value at most this often (fits the ingest rate). */
export const MQTT_FLUSH_SEC = 15;
/** Players check the bridge configuration on every state poll; this is the fallback refresh. */
export const MQTT_CONFIG_REFRESH_SEC = 15 * 60;

/** Host name or IP address (no scheme, no port). */
export const MqttHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/, 'Enter a host name or IP address, without mqtt:// or a port');

/** An exact topic (no + or # wildcards): one channel reads one topic. */
export const MqttTopic = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((t) => !/[+#]/.test(t) && !t.includes(String.fromCharCode(0)), 'Use an exact topic, without + or # wildcards');

/**
 * Where the value is in a JSON payload, as dot-separated keys / array indexes (e.g.
 * "data.temp", "sensors.0.value"). Null when the whole payload is the value ("23.5", "ON").
 */
export const MqttPath = z
  .string()
  .trim()
  .max(100)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'Use keys separated by dots, e.g. data.temp');

export const ChannelMqtt = z.object({ topic: MqttTopic, path: MqttPath.nullable() });
export type ChannelMqtt = z.infer<typeof ChannelMqtt>;

export const MQTT_STATES = ['connecting', 'connected', 'error'] as const;
export type MqttState = (typeof MQTT_STATES)[number];

/** Bridge state per broker, sent in the bridge screen's heartbeat (players 0.18.0+). */
export const MqttBridgeStatus = z.object({
  brokerId: id,
  state: z.enum(MQTT_STATES),
  // Players omit null fields.
  error: z.string().max(200).nullish(),
  /** Messages received since the player started. */
  messages: z.number().int().min(0),
  lastMessageAt: z.number().int().min(0).nullish(),
});
export type MqttBridgeStatus = z.infer<typeof MqttBridgeStatus>;

/** orgs/{orgId}/mqttBrokers/{id} */
export interface MqttBrokerDoc {
  id: string;
  name: string;
  host: string;
  port: number;
  tls: boolean;
  username: string | null;
  /** A password is stored (server-only). */
  hasPassword: boolean;
  /** The screen whose player connects to the broker. */
  bridgeScreenId: string;
  /** The bridge screen's site, for site-scoped members. */
  siteId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** orgs/{orgId}/mqttBrokerSecrets/{id} — never readable by clients. */
export interface MqttBrokerSecretDoc {
  password: string;
}

export const SaveMqttBrokerInput = z.object({
  orgId: id,
  brokerId: id.optional(),
  name: z.string().trim().min(1).max(80),
  host: MqttHost,
  port: z.number().int().min(1).max(65535),
  tls: z.boolean(),
  username: z.string().max(200).nullable(),
  /** Omitted = keep the stored password; null = remove it. */
  password: z.string().min(1).max(500).nullable().optional(),
  bridgeScreenId: id,
});
export type SaveMqttBrokerInput = z.infer<typeof SaveMqttBrokerInput>;
export const MqttBrokerRefInput = z.object({ orgId: id, brokerId: id });

/** GET /api/v1/devices/mqtt — the bridge configuration of this screen (empty when it is not one). */
export interface DeviceMqttResponse {
  brokers: Array<{
    id: string;
    host: string;
    port: number;
    tls: boolean;
    username: string | null;
    password: string | null;
    /** Stable per screen and broker, so the broker can tell bridges apart. */
    clientId: string;
    subscriptions: Array<{
      topic: string;
      path: string | null;
      sensorDeviceId: string;
      channel: string;
      valueType: 'number' | 'boolean';
    }>;
  }>;
  serverTime: number;
}

/** POST /api/v1/devices/mqtt/readings — latest values per MQTT sensor device. */
export const MqttReadingsBody = z.object({
  batches: z
    .array(
      z.object({
        sensorDeviceId: id,
        /** When the newest of these values arrived (epoch ms). */
        ts: z.number().int().nonnegative(),
        readings: z
          .array(z.object({ channel: z.string().max(40), value: z.union([z.number(), z.boolean()]) }))
          .min(1)
          .max(16),
      }),
    )
    .min(1)
    .max(50),
});
export type MqttReadingsBody = z.infer<typeof MqttReadingsBody>;

export interface MqttReadingsResponse {
  results: Array<{ sensorDeviceId: string; status: number; accepted: number; error: string | null }>;
  serverTime: number;
}
