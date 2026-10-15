package com.wallx.play

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.wallx.play.core.LiveValue
import com.wallx.play.core.MqttBridge
import com.wallx.play.core.MqttBuffer
import com.wallx.play.core.MqttTransport
import com.wallx.play.core.MqttValues
import com.wallx.play.core.PlayerEngine
import com.wallx.play.data.MqttBrokerConfig
import com.wallx.play.data.MqttSubscription
import com.wallx.play.data.json
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** MQTT bridge: payload values, the upload buffer, connection handling and the engine round trip. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MqttTest {
    @Test
    fun payloadsBecomeChannelValues() {
        assertEquals(23.5, MqttValues.value("23.5", null, "number"))
        assertEquals(23.5, MqttValues.value(" \"23.5\" ", null, "number"))
        assertEquals(true, MqttValues.value("ON", null, "boolean"))
        assertEquals(false, MqttValues.value("closed", null, "boolean"))
        assertEquals(true, MqttValues.value("1", null, "boolean"))
        assertNull(MqttValues.value("warm", null, "number"))
        val payload = """{"data":{"temp":4.2,"door":"open"},"sensors":[{"value":7},{"value":"8.5"}],"gone":null}"""
        assertEquals(4.2, MqttValues.value(payload, "data.temp", "number"))
        assertEquals(true, MqttValues.value(payload, "data.door", "boolean"))
        assertEquals(8.5, MqttValues.value(payload, "sensors.1.value", "number"))
        assertNull(MqttValues.value(payload, "sensors.5.value", "number"))
        assertNull(MqttValues.value(payload, "gone", "number"))
        assertNull(MqttValues.value("not json", "data.temp", "number"))
        assertEquals(1.0, MqttValues.value("""{"on":true}""", "on", "number"))
    }

    @Test
    fun bufferKeepsTheLatestValuePerChannel() {
        val b = MqttBuffer()
        b.put("d1", "temp", 4.0, 1_000)
        b.put("d1", "temp", 5.0, 2_000)
        b.put("d1", "temp", 3.0, 1_500) // late: ignored
        b.put("d1", "door", true, 1_800)
        b.put("d2", "temp", 9.0, 1_200)
        val batches = b.drain()
        assertEquals(0, b.size)
        assertEquals(listOf("d1", "d2"), batches.map { it.sensorDeviceId })
        assertEquals(2_000L, batches[0].ts)
        assertEquals("5.0", batches[0].readings.first { it.channel == "temp" }.value.content)
        assertEquals("true", batches[0].readings.first { it.channel == "door" }.value.content)

        // A failed upload goes back, unless a newer value arrived meanwhile.
        b.put("d2", "temp", 10.0, 3_000)
        b.restore(batches)
        val again = b.drain().associateBy { it.sensorDeviceId }
        assertEquals("10.0", again["d2"]!!.readings.single().value.content)
        assertEquals(2, again["d1"]!!.readings.size)
    }

    private class FakeTransport : MqttTransport {
        var broker: MqttBrokerConfig? = null
        var topics: Set<String> = emptySet()
        var closed = false
        lateinit var deliver: (String, String) -> Unit
        lateinit var state: (String, String?) -> Unit
        override fun connect(broker: MqttBrokerConfig, topics: Set<String>, onMessage: (String, String) -> Unit, onState: (String, String?) -> Unit) {
            this.broker = broker
            this.topics = topics
            deliver = onMessage
            state = onState
        }
        override fun close() {
            closed = true
        }
    }

    private fun broker(id: String = "b1", host: String = "10.0.0.2", subs: List<MqttSubscription> = listOf(
        MqttSubscription("plant/line1", "temp", "d1", "temp", "number"),
        MqttSubscription("plant/line1", "door", "d1", "door", "boolean"),
    )) = MqttBrokerConfig(id, host, 1883, false, "u", "p", "wxp-1", subs)

    @Test
    fun bridgeRoutesMessagesAndReconnectsOnlyWhenNeeded() {
        val transports = mutableListOf<FakeTransport>()
        var now = 10_000L
        val local = mutableListOf<Triple<String, Double, Long>>()
        val bridge = MqttBridge({ FakeTransport().also { transports += it } }, { now }) { k, v, t -> local += Triple(k, v, t) }

        bridge.apply(listOf(broker()))
        val t = transports.single()
        assertEquals(setOf("plant/line1"), t.topics)
        t.state("connected", null)
        t.deliver("plant/line1", """{"temp":6.5,"door":"closed"}""")
        t.deliver("other/topic", "1")
        assertEquals(listOf(Triple("d1/temp", 6.5, 10_000L), Triple("d1/door", 0.0, 10_000L)), local)
        assertEquals(2, bridge.buffer.drain().single().readings.size)
        val s = bridge.status().single()
        assertEquals("connected", s.state)
        assertEquals(2, s.messages)

        // Same connection and topics (a channel's JSON field changed): no reconnect.
        bridge.apply(listOf(broker(subs = listOf(MqttSubscription("plant/line1", "t", "d1", "temp", "number")))))
        assertEquals(1, transports.size)
        t.deliver("plant/line1", """{"t":7}""")
        assertEquals(7.0, local.last().second, 0.0)

        // New host: reconnect. Failed start: retried after a minute.
        bridge.apply(listOf(broker(host = "10.0.0.3")))
        assertTrue(t.closed)
        val t2 = transports.last()
        t2.state("error", "Connection refused")
        bridge.maintain()
        assertEquals(2, transports.size)
        now += 60_000
        bridge.maintain()
        assertEquals(3, transports.size)
        assertTrue(t2.closed)

        // Not a bridge any more.
        bridge.stop()
        assertTrue(transports.last().closed)
        assertTrue(bridge.status().isEmpty())
    }

    @Test
    fun localValuesShowAtOnceUntilTheServerCatchesUp() {
        val live = com.wallx.play.core.LiveStore()
        val res = { v: Double, ts: Long -> com.wallx.play.data.LiveResponse(0, listOf(com.wallx.play.data.LiveValueDto("d1", "temp", "Temp", v, ts, 600, true)), 15) }
        live.applyLive(res(4.0, 1_000), emptyList())
        live.applyLocal("d1/temp", 6.0, 2_000)
        assertEquals(6.0, live.values.value["d1/temp"]!!.value!!, 0.0)
        live.applyLive(res(4.0, 1_000), emptyList()) // server not caught up yet
        assertEquals(LiveValue(6.0, 2_000, 600, true, "number", ""), live.values.value["d1/temp"])
        live.applyLive(res(6.5, 2_500), emptyList())
        assertEquals(6.5, live.values.value["d1/temp"]!!.value!!, 0.0)
    }

    @Test
    fun engineFetchesTheBridgeConfigAndUploadsReadings() = runBlocking {
        var configAt: Long? = 5L
        val uploads = mutableListOf<String>()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val ok = { body: String -> MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body) }
                return when (request.path) {
                    "/api/v1/devices/register" -> ok("""{"deviceId":"dev12345678","deviceSecret":"${"s".repeat(43)}","pairingCode":"ABC234","pairingExpiresAt":1,"pairingUrl":"https://x/p"}""")
                    "/api/v1/devices/me" -> ok(
                        """{"deviceId":"dev12345678","status":"authorized","orgName":"Acme",
                           "screen":{"id":"s1","name":"Lobby","orientation":"landscape","resolution":{"width":1920,"height":1080},"manifestVersion":0},
                           "config":{"pollSec":60,"heartbeatSec":300},"mqttConfigAt":${configAt ?: "null"},"serverTime":0}""",
                    )
                    "/api/v1/devices/mqtt" -> ok(
                        """{"brokers":[{"id":"b1","host":"10.0.0.2","port":1883,"tls":false,"username":"u","password":"p","clientId":"wxp-1",
                           "subscriptions":[{"topic":"plant/line1","path":null,"sensorDeviceId":"d1","channel":"temp","valueType":"number"}]}],"serverTime":0}""",
                    )
                    "/api/v1/devices/mqtt/readings" -> ok("""{"results":[{"sensorDeviceId":"d1","status":200,"accepted":1}]}""").also { uploads += request.body.readUtf8() }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        try {
            val context: Context = ApplicationProvider.getApplicationContext()
            val engine = PlayerEngine(context, server.url("/api/v1").toString().trimEnd('/'))
            val transports = mutableListOf<FakeTransport>()
            engine.mqttTransport = { FakeTransport().also { transports += it } }
            engine.tick()
            val t = transports.single()
            assertEquals("p", t.broker!!.password)
            t.deliver("plant/line1", "21.5")
            assertEquals("buffered", 1, engine.mqtt.buffer.size)
            engine.flushMqtt()
            val body = json.parseToJsonElement(uploads.single()).jsonObject
            val batch = body["batches"]!!.jsonArray.single().jsonObject
            assertEquals("d1", batch["sensorDeviceId"]!!.jsonPrimitive.content)
            assertEquals("21.5", (batch["readings"]!!.jsonArray.single() as JsonObject)["value"]!!.jsonPrimitive.content)

            // The screen stops being a bridge.
            configAt = null
            engine.tick()
            assertTrue(t.closed)
            assertTrue(!engine.mqtt.active)
        } finally {
            server.shutdown()
        }
    }
}
