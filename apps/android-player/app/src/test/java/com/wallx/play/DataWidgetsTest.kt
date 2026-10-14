package com.wallx.play

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import com.wallx.play.core.DataStore
import com.wallx.play.core.MediaLibrary
import com.wallx.play.core.Weather
import com.wallx.play.data.DeviceDataResponse
import com.wallx.play.data.Manifest
import com.wallx.play.data.json
import com.wallx.play.ui.RenderContext
import com.wallx.play.ui.WidgetView
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** /devices/data parsing, weather mapping (same cases as live.test.ts) and data widgets. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DataWidgetsTest {
    @get:Rule val compose = createComposeRule()

    private val response = """
        {"serverTime":1,"sources":[
          {"id":"w1","type":"weather","name":"Pune","ok":true,"error":null,"fetchedAt":1,
           "weather":{"current":{"tempC":29.6,"feelsLikeC":33.2,"humidity":70,"windKmh":9,"code":3,"isDay":true},
                      "daily":[{"date":"2026-10-12","code":3,"maxC":31,"minC":24},{"date":"2026-10-13","code":61,"maxC":29,"minC":23}],
                      "timezone":"Asia/Kolkata","attribution":"Google Maps"},"rss":null},
          {"id":"r1","type":"rss","name":"News","ok":true,"error":null,"fetchedAt":1,"weather":null,
           "rss":{"feedTitle":"Pune Today","items":[{"title":"Metro extension opens","publishedAt":null},{"title":"Rain likely","publishedAt":null}]}}
        ]}
    """.trimIndent()

    private fun ctx(store: DataStore): RenderContext {
        val manifest = Manifest(1, "o", "s", 1, 0, emptyList(), emptyList(), emptyList(), assets = emptyList())
        return RenderContext(manifest, MediaLibrary(emptyMap()), data = store)
    }

    private fun widget(s: String) = json.decodeFromString<JsonObject>(s)

    @Test
    fun weatherConditions() {
        assertEquals(listOf("clear", "partly", "cloudy", "fog", "drizzle", "rain", "rain", "snow", "storm"), listOf(0, 2, 3, 45, 53, 63, 81, 73, 95).map(Weather::condition))
        assertEquals("🌙", Weather.icon("clear", isDay = false))
    }

    @Test
    fun keepsLastGoodValueWhenTheServerOnlyHasAnError() {
        val store = DataStore()
        store.apply(json.decodeFromString<DeviceDataResponse>(response))
        store.apply(json.decodeFromString<DeviceDataResponse>("""{"sources":[{"id":"w1","type":"weather","ok":false,"error":"down"}]}"""))
        val w1 = store.values.value["w1"]!!
        assertFalse(w1.ok)
        assertEquals(29.6, w1.weather!!.current.tempC, 0.0)
    }

    @Test
    fun rendersWeatherAndRss() {
        val store = DataStore().apply { apply(json.decodeFromString<DeviceDataResponse>(response)) }
        compose.setContent {
            Box(Modifier.size(600.dp, 300.dp)) { WidgetView(widget("""{"type":"weather","dataSourceId":"w1","layout":"forecast","style":{}}"""), ctx(store)) }
        }
        compose.onNodeWithText("Pune").assertExists()
        compose.onNodeWithText("30°").assertExists()
        compose.onNodeWithText("Cloudy · Feels like 33°").assertExists()
        compose.onNodeWithText("Google Maps").assertExists() // provider credit required next to the data
    }

    @Test
    fun rendersHeadlines() {
        val store = DataStore().apply { apply(json.decodeFromString<DeviceDataResponse>(response)) }
        compose.setContent {
            Box(Modifier.size(800.dp, 200.dp)) { WidgetView(widget("""{"type":"rss","dataSourceId":"r1","itemDurationSec":8,"showFeedTitle":true,"style":{}}"""), ctx(store)) }
        }
        compose.onNodeWithText("Pune Today").assertExists()
        compose.onNodeWithText("Metro extension opens").assertExists()
    }

    @Test
    fun showsNoDataForUnknownSource() {
        compose.setContent {
            Box(Modifier.size(400.dp, 200.dp)) { WidgetView(widget("""{"type":"rss","dataSourceId":"zzz","style":{}}"""), ctx(DataStore())) }
        }
        compose.onNodeWithText("No data yet").assertExists()
    }
}
