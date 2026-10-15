package com.wallx.play.core

import android.util.Log
import com.wallx.play.data.MqttBatch
import com.wallx.play.data.MqttBridgeStatus
import com.wallx.play.data.MqttBrokerConfig
import com.wallx.play.data.MqttReading
import com.wallx.play.data.MqttSubscription
import com.wallx.play.data.json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import org.eclipse.paho.client.mqttv3.IMqttActionListener
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.IMqttToken
import org.eclipse.paho.client.mqttv3.MqttAsyncClient
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import java.util.Locale

/** Turns an MQTT payload into a channel value (Double for numbers, Boolean for on/off). */
object MqttValues {
    private val TRUE = setOf("true", "on", "yes", "1", "open", "high", "active")
    private val FALSE = setOf("false", "off", "no", "0", "closed", "close", "low", "inactive")

    /**
     * [path] picks a field of a JSON payload ("data.temp", "sensors.0.value"); without it the
     * whole payload is the value ("23.5", "ON", "true"). Null when the value is missing or of
     * the wrong kind.
     */
    fun value(payload: String, path: String?, valueType: String): Any? {
        val raw = (if (path == null) scalar(payload) else at(payload, path)) ?: return null
        return if (valueType == "boolean") bool(raw) else number(raw)
    }

    private fun scalar(payload: String): JsonPrimitive? {
        val t = payload.trim()
        if (t.isEmpty()) return null
        return runCatching { json.parseToJsonElement(t) as? JsonPrimitive }.getOrNull() ?: JsonPrimitive(t)
    }

    private fun at(payload: String, path: String): JsonPrimitive? {
        var node: JsonElement = runCatching { json.parseToJsonElement(payload) }.getOrNull() ?: return null
        for (key in path.split('.')) {
            node = when (val n = node) {
                is JsonObject -> n[key]
                is JsonArray -> key.toIntOrNull()?.let { n.getOrNull(it) }
                else -> null
            } ?: return null
        }
        return (node as? JsonPrimitive)?.takeIf { it !is JsonNull }
    }

    private fun number(p: JsonPrimitive): Double? {
        p.booleanOrNull?.let { if (!p.isString) return if (it) 1.0 else 0.0 }
        return p.content.trim().toDoubleOrNull()?.takeIf { it.isFinite() }
    }

    private fun bool(p: JsonPrimitive): Boolean? {
        val s = p.content.trim().lowercase(Locale.ROOT)
        if (s in TRUE) return true
        if (s in FALSE) return false
        return s.toDoubleOrNull()?.let { it != 0.0 }
    }
}

/**
 * Latest value per channel since the last upload. The bridge uploads at most every
 * MQTT_FLUSH_SEC, so a chatty topic costs one reading per channel per upload.
 */
class MqttBuffer {
    private data class Entry(val value: Any, val ts: Long)
    private val latest = LinkedHashMap<Pair<String, String>, Entry>()

    @Synchronized fun put(sensorDeviceId: String, channel: String, value: Any, ts: Long) {
        val key = sensorDeviceId to channel
        val prev = latest[key]
        if (prev == null || prev.ts <= ts) latest[key] = Entry(value, ts)
    }

    /** Takes everything, one batch per sensor device. */
    @Synchronized fun drain(): List<MqttBatch> {
        val batches = latest.entries.groupBy({ it.key.first }) { it }.map { (device, entries) ->
            MqttBatch(
                sensorDeviceId = device,
                ts = entries.maxOf { it.value.ts },
                readings = entries.map { MqttReading(it.key.second, primitive(it.value.value)) },
            )
        }
        latest.clear()
        return batches
    }

    /** Puts back values of a failed upload unless newer ones arrived meanwhile. */
    @Synchronized fun restore(batches: List<MqttBatch>) {
        for (b in batches) for (r in b.readings) {
            val key = b.sensorDeviceId to r.channel
            if (latest[key] == null) latest[key] = Entry(r.value.booleanOrNull ?: r.value.content.toDouble(), b.ts)
        }
    }

    @get:Synchronized val size: Int get() = latest.size

    private fun primitive(v: Any) = when (v) {
        is Boolean -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        else -> JsonPrimitive(v.toString())
    }
}

/** One broker connection (the Paho client on a player; a fake in tests). */
interface MqttTransport {
    fun connect(
        broker: MqttBrokerConfig,
        topics: Set<String>,
        onMessage: (topic: String, payload: String) -> Unit,
        onState: (state: String, error: String?) -> Unit,
    )
    fun close()
}

/**
 * The player as an MQTT bridge: connects to the brokers this screen bridges, routes messages
 * to their channels (latest value per channel goes to [buffer] for upload, and to [onLocal]
 * so this screen shows it at once) and reports each connection's state for the heartbeat.
 */
class MqttBridge(
    private val newTransport: () -> MqttTransport,
    private val now: () -> Long,
    private val onLocal: (key: String, value: Double, ts: Long) -> Unit = { _, _, _ -> },
) {
    val buffer = MqttBuffer()

    private class Conn(
        val broker: MqttBrokerConfig,
        val transport: MqttTransport,
        @Volatile var routes: Map<String, List<MqttSubscription>>,
    ) {
        @Volatile var state = "connecting"
        @Volatile var error: String? = null
        @Volatile var messages = 0
        @Volatile var lastMessageAt: Long? = null
        @Volatile var failedAt = 0L
    }

    private val conns = LinkedHashMap<String, Conn>()

    /** Same server, account and topics: the connection can stay. */
    private fun sameConnection(a: MqttBrokerConfig, b: MqttBrokerConfig) =
        a.host == b.host && a.port == b.port && a.tls == b.tls && a.username == b.username && a.password == b.password &&
            a.clientId == b.clientId && a.subscriptions.map { it.topic }.toSet() == b.subscriptions.map { it.topic }.toSet()

    /** Applies the configuration from GET /devices/mqtt (empty = not a bridge any more). */
    @Synchronized fun apply(brokers: List<MqttBrokerConfig>) {
        val wanted = brokers.associateBy { it.id }
        for (id in conns.keys.toList()) {
            val old = conns[id]!!
            val next = wanted[id]
            if (next == null || !sameConnection(old.broker, next)) {
                old.transport.close()
                conns.remove(id)
            } else {
                old.routes = routesOf(next)
            }
        }
        for (b in brokers) if (b.id !in conns && b.subscriptions.isNotEmpty()) open(b)
    }

    private fun routesOf(b: MqttBrokerConfig) = b.subscriptions.groupBy { it.topic }

    private fun open(b: MqttBrokerConfig) {
        val conn = Conn(b, newTransport(), routesOf(b))
        conns[b.id] = conn
        conn.transport.connect(
            b,
            conn.routes.keys,
            onMessage = { topic, payload -> receive(conn, topic, payload) },
            onState = { state, error ->
                conn.state = state
                conn.error = error?.take(200)
                if (state == "error") conn.failedAt = now()
            },
        )
    }

    private fun receive(conn: Conn, topic: String, payload: String) {
        val at = now()
        conn.messages++
        conn.lastMessageAt = at
        for (sub in conn.routes[topic].orEmpty()) {
            val v = MqttValues.value(payload, sub.path, sub.valueType) ?: continue
            buffer.put(sub.sensorDeviceId, sub.channel, v, at)
            onLocal("${sub.sensorDeviceId}/${sub.channel}", if (v is Boolean) (if (v) 1.0 else 0.0) else v as Double, at)
        }
    }

    /** Retries connections that failed to start (Paho only reconnects after a first success). */
    @Synchronized fun maintain(retryAfterMs: Long = 60_000) {
        val t = now()
        for ((id, c) in conns.entries.toList()) {
            if (c.state == "error" && t - c.failedAt >= retryAfterMs) {
                c.transport.close()
                conns.remove(id)
                open(c.broker)
            }
        }
    }

    @Synchronized fun status(): List<MqttBridgeStatus> =
        conns.values.map { MqttBridgeStatus(it.broker.id, it.state, it.error, it.messages, it.lastMessageAt) }

    @get:Synchronized val active: Boolean get() = conns.isNotEmpty()

    @Synchronized fun stop() = apply(emptyList())
}

/** Eclipse Paho client: TCP or TLS, keep-alive, automatic reconnect after the first connection. */
class PahoTransport : MqttTransport {
    private var client: MqttAsyncClient? = null

    override fun connect(
        broker: MqttBrokerConfig,
        topics: Set<String>,
        onMessage: (topic: String, payload: String) -> Unit,
        onState: (state: String, error: String?) -> Unit,
    ) {
        val host = if (broker.host.contains(':') && !broker.host.startsWith("[")) "[${broker.host}]" else broker.host
        val uri = "${if (broker.tls) "ssl" else "tcp"}://$host:${broker.port}"
        try {
            val c = MqttAsyncClient(uri, broker.clientId, MemoryPersistence())
            client = c
            c.setCallback(object : MqttCallbackExtended {
                override fun connectComplete(reconnect: Boolean, serverURI: String?) {
                    try {
                        if (topics.isNotEmpty()) c.subscribe(topics.toTypedArray(), IntArray(topics.size) { 1 })
                        onState("connected", null)
                    } catch (e: Exception) {
                        onState("error", "subscribe failed: ${e.message}")
                    }
                }
                override fun connectionLost(cause: Throwable?) = onState("connecting", cause?.message ?: "connection lost")
                override fun messageArrived(topic: String, message: MqttMessage) = onMessage(topic, String(message.payload, Charsets.UTF_8))
                override fun deliveryComplete(token: IMqttDeliveryToken?) = Unit
            })
            val options = MqttConnectOptions().apply {
                isCleanSession = true
                isAutomaticReconnect = true
                maxReconnectDelay = 60_000
                keepAliveInterval = 60
                connectionTimeout = 20
                broker.username?.let { userName = it }
                broker.password?.let { password = it.toCharArray() }
            }
            onState("connecting", null)
            c.connect(options, null, object : IMqttActionListener {
                override fun onSuccess(asyncActionToken: IMqttToken?) = Unit
                override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) =
                    onState("error", describe(exception))
            })
        } catch (e: Exception) {
            onState("error", describe(e))
        }
    }

    override fun close() {
        val c = client ?: return
        client = null
        runCatching { if (c.isConnected) c.disconnectForcibly(1_000, 1_000) }
        runCatching { c.close(true) }
    }

    private fun describe(e: Throwable?): String {
        val cause = generateSequence(e) { it.cause }.lastOrNull()
        return (cause?.message ?: e?.message ?: "could not connect").also { Log.w("WallXMqtt", "MQTT: $it") }
    }
}
