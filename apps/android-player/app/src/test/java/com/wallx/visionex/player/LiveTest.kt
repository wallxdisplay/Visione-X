package com.wallx.visionex.player

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import com.wallx.visionex.player.core.Live
import com.wallx.visionex.player.core.LiveState
import com.wallx.visionex.player.core.LiveStore
import com.wallx.visionex.player.core.LiveValue
import com.wallx.visionex.player.core.MediaLibrary
import com.wallx.visionex.player.data.HistoryResponse
import com.wallx.visionex.player.data.HistorySeries
import com.wallx.visionex.player.data.LiveChannel
import com.wallx.visionex.player.data.LiveResponse
import com.wallx.visionex.player.data.LiveValueDto
import com.wallx.visionex.player.data.Manifest
import com.wallx.visionex.player.data.json
import com.wallx.visionex.player.ui.RenderContext
import com.wallx.visionex.player.ui.WidgetView
import com.wallx.visionex.player.ui.niceTicks
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Live sensor rules (same cases as packages/layout-spec/src/live.test.ts) and widget rendering. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LiveTest {
    @get:Rule val compose = createComposeRule()

    private val now = 1_000_000L
    private val v = LiveValue(4.0, now - 30_000, 60, true)

    @Test
    fun states() {
        assertEquals(LiveState.OK, Live.state(v, now))
        assertEquals(LiveState.STALE, Live.state(v.copy(ts = now - 61_000), now))
        assertEquals(LiveState.OFFLINE, Live.state(v.copy(ts = now - 61_000, deviceOnline = false), now))
        assertEquals(LiveState.NODATA, Live.state(v.copy(value = null), now))
        assertEquals(LiveState.NODATA, Live.state(null, now))
        assertEquals(LiveState.STALE, Live.state(v, now, staleOverrideSec = 10))
    }

    @Test
    fun formattingMatchingAndBands() {
        assertEquals("21", Live.format(21.0))
        assertEquals("21", Live.format(21.04))
        assertEquals("21.3", Live.format(21.26))
        assertEquals("21.26", Live.format(21.26, 2))
        val bands = listOf(Live.Band("Hot", ">=", 8.0, "#DC2626"), Live.Band("Warm", ">=", 5.0, "#F59E0B"))
        assertEquals("#DC2626", Live.band(bands, 9.0)?.color)
        assertEquals("#F59E0B", Live.band(bands, 6.0)?.color)
        assertEquals(null, Live.band(bands, 2.0))
        assertTrue(Live.statusMatches("2", 2.0))
        assertTrue(Live.statusMatches("on", 1.0))
        assertTrue(Live.statusMatches("OFF", 0.0))
        assertFalse(Live.statusMatches("true", 0.0))
        assertFalse(Live.statusMatches("open", 1.0))
        assertEquals(0.5f, Live.gaugeFraction(5.0, 0.0, 10.0))
        assertEquals(1f, Live.gaugeFraction(30.0, 0.0, 10.0))
        assertEquals(listOf(4.0, 6.0, 8.0, 10.0), niceTicks(4.1, 9.1))
    }

    @Test
    fun storeAppendsLiveReadingsToChartHistory() {
        val store = LiveStore()
        val channels = listOf(LiveChannel("d1", "temp", historyMinutes = 60))
        store.applyHistory(HistoryResponse(now, listOf(HistorySeries("d1", "temp", listOf(listOf(now - 7_200_000.0, 1.0), listOf(now - 60_000.0, 3.5))))))
        store.applyLive(LiveResponse(now, listOf(LiveValueDto("d1", "temp", "Temperature", 3.9, now, 600, true, "°C"))), channels)
        // The 2-hour-old point falls out of the 60-minute window; the new reading is appended.
        assertEquals(listOf(now - 60_000 to 3.5, now to 3.9), store.history.value["d1/temp"])
        assertEquals("Temperature", store.names["d1/temp"])
        // The same reading again is not duplicated.
        store.applyLive(LiveResponse(now, listOf(LiveValueDto("d1", "temp", "Temperature", 3.9, now, 600, true))), channels)
        assertEquals(2, store.history.value["d1/temp"]!!.size)
        store.retain(emptyList())
        assertTrue(store.values.value.isEmpty())
    }

    private fun ctx(store: LiveStore, at: Long): RenderContext {
        val manifest = Manifest(1, "o", "s", 1, 0, emptyList(), emptyList(), emptyList(), assets = emptyList())
        return RenderContext(manifest, MediaLibrary(emptyMap()), store, now = { at })
    }

    private fun sensorValue() = json.decodeFromString<JsonObject>(
        """{"type":"sensorValue","binding":{"source":"sensor","sourceId":"d1","field":"temp"},"label":"Cold room","unit":"°C",
           "thresholds":[{"label":"Too warm","operator":">","value":8,"color":"#DC2626"}],"style":{}}""",
    )

    @Test
    fun rendersValueBandAndStaleNote() {
        val store = LiveStore()
        store.applyLive(LiveResponse(now, listOf(LiveValueDto("d1", "temp", "Temperature", 9.1, now - 20 * 60_000, 600, true, "°C"))), emptyList())
        compose.setContent { Box(Modifier.size(400.dp, 300.dp)) { WidgetView(sensorValue(), ctx(store, now)) } }
        compose.onNodeWithText("Cold room").assertExists()
        compose.onNodeWithText("9.1 °C").assertExists()
        compose.onNodeWithText("Too warm").assertExists()
        compose.onNodeWithText("Stale").assertExists() // 20 min old, stale after 10
    }

    @Test
    fun showsNoDataWithoutAValue() {
        compose.setContent { Box(Modifier.size(400.dp, 300.dp)) { WidgetView(sensorValue(), ctx(LiveStore(), now)) } }
        compose.onNodeWithText("No data").assertExists()
    }
}
