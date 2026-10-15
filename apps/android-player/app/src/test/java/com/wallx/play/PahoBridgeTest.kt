package com.wallx.play

import com.wallx.play.core.MqttBridge
import com.wallx.play.core.PahoTransport
import com.wallx.play.data.MqttBrokerConfig
import com.wallx.play.data.MqttSubscription
import io.moquette.broker.Server
import io.moquette.broker.config.MemoryConfig
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.net.ServerSocket
import java.util.Properties

/** The real Paho client against an in-process broker: connect, subscribe, receive, reconnect. */
class PahoBridgeTest {
    private lateinit var broker: Server
    private var port = 0

    private fun startBroker() {
        broker = Server()
        broker.startServer(MemoryConfig(Properties().apply {
            setProperty("port", port.toString())
            setProperty("host", "127.0.0.1")
            setProperty("allow_anonymous", "true")
            setProperty("websocket_port", "disabled")
            setProperty("persistence_enabled", "false")
        }))
    }

    @Before
    fun setUp() {
        port = ServerSocket(0).use { it.localPort }
        startBroker()
    }

    @After
    fun tearDown() = runCatching { broker.stopServer() }.let { }

    private fun publish(topic: String, payload: String) {
        MqttClient("tcp://127.0.0.1:$port", "test-publisher", MemoryPersistence()).apply {
            connect()
            publish(topic, payload.toByteArray(), 1, false)
            disconnect()
            close()
        }
    }

    private fun waitFor(what: String, timeoutMs: Long = 10_000, check: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!check()) {
            if (System.currentTimeMillis() > end) throw AssertionError("timed out waiting for $what")
            Thread.sleep(50)
        }
    }

    @Test
    fun bridgeReceivesFromARealBrokerAndReconnects() {
        val bridge = MqttBridge({ PahoTransport() }, System::currentTimeMillis)
        bridge.apply(
            listOf(
                MqttBrokerConfig(
                    "b1", "127.0.0.1", port, false, null, null, "wxp-test",
                    listOf(MqttSubscription("plant/line1/temp", null, "d1", "temp", "number")),
                ),
            ),
        )
        waitFor("connected") { bridge.status().single().state == "connected" }
        publish("plant/line1/temp", "4.5")
        waitFor("message") { bridge.buffer.size == 1 }
        assertEquals("4.5", bridge.buffer.drain().single().readings.single().value.content)

        // Broker restart: Paho reconnects on its own and subscribes again.
        broker.stopServer()
        waitFor("connection lost") { bridge.status().single().state == "connecting" }
        startBroker()
        waitFor("reconnected", 90_000) { bridge.status().single().state == "connected" }
        publish("plant/line1/temp", "5.0")
        waitFor("message after reconnect") { bridge.buffer.size == 1 }
        bridge.stop()
    }
}
