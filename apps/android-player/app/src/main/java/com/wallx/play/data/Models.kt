package com.wallx.play.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Kotlin mirror of packages/layout-spec (SPEC_VERSION 1) and the device API payloads.
 * Zone/item content and widgets are kept as JSON objects and interpreted by the renderer, so a
 * newer server can add widget types without breaking older players (they show a placeholder).
 */
val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

const val SUPPORTED_SPEC_VERSION = 1

@Serializable
data class Manifest(
    val specVersion: Int,
    val orgId: String,
    val screenId: String,
    val version: Int,
    val generatedAt: Long,
    val layouts: List<Layout>,
    val playlists: List<Playlist>,
    val schedules: List<ScheduleRule>,
    val defaultPlaylistId: String? = null,
    val fallbackMediaId: String? = null,
    val emergency: Emergency? = null,
    val assets: List<Asset>,
    /** Sensor channels the content shows; values come from /devices/live (phase 5). */
    val liveChannels: List<LiveChannel> = emptyList(),
    /** Weather / RSS data sources the content shows; values come from /devices/data (phase 6). */
    val dataSources: List<ManifestDataSource> = emptyList(),
    /** Clockwise degrees to rotate the whole output (0, 90, 180, 270): portrait walls on landscape HDMI. */
    val rotation: Int = 0,
)

@Serializable
data class Layout(val specVersion: Int, val id: String, val name: String, val canvas: Canvas, val zones: List<Zone>)

@Serializable
data class Canvas(val width: Int, val height: Int, val orientation: String, val background: String = "#000000")

@Serializable
data class Zone(
    val id: String,
    val name: String,
    val x: Double,
    val y: Double,
    val w: Double,
    val h: Double,
    val z: Int,
    val content: JsonObject,
)

@Serializable
data class Playlist(val id: String, val items: List<PlaylistItem>)

@Serializable
data class PlaylistItem(val id: String, val content: JsonObject, val durationSec: Int, val transition: String = "none")

@Serializable
data class ScheduleRule(
    val id: String,
    val priority: Int,
    val timezone: String,
    val startDate: String? = null,
    val endDate: String? = null,
    val daysOfWeek: List<Int> = emptyList(),
    val windowStart: String? = null,
    val windowEnd: String? = null,
    val playlistId: String,
)

@Serializable
data class Emergency(val id: String, val playlistId: String, val expiresAt: Long? = null)

@Serializable
data class LiveChannel(val sourceId: String, val field: String, val historyMinutes: Int? = null) {
    val key get() = "$sourceId/$field"
}

@Serializable
data class ManifestDataSource(val id: String, val type: String)

@Serializable
data class Asset(val mediaId: String, val url: String, val sha256: String, val bytes: Long, val mimeType: String)

/** `content.kind` / `widget.type` helpers. */
fun JsonObject.str(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.let {
    if (it.isString) it.content else it.content.takeIf { c -> c != "null" }
}
fun JsonObject.kind(): String = this["kind"]?.jsonPrimitive?.content ?: ""

// ---------------------------------------------------------------- device API

@Serializable
data class DeviceHardware(
    val manufacturer: String,
    val model: String,
    val androidVersion: String,
    val sdkInt: Int,
    val appVersion: String,
    val display: Size,
)

@Serializable
data class Size(val width: Int, val height: Int)

@Serializable
data class RegisterRequest(val hardware: DeviceHardware)

@Serializable
data class RegisterResponse(
    val deviceId: String,
    val deviceSecret: String,
    val pairingCode: String,
    val pairingExpiresAt: Long,
    val pairingUrl: String,
)

@Serializable
data class DeviceState(
    val deviceId: String,
    val status: String,
    val pairingCode: String? = null,
    val pairingExpiresAt: Long? = null,
    val pairingUrl: String? = null,
    val orgName: String? = null,
    val screen: ScreenInfo? = null,
    val commandsPending: Int = 0,
    val config: DeviceConfig = DeviceConfig(),
    /** A newer player release rolled out to this screen's organization. */
    val update: PlayerUpdate? = null,
    val serverTime: Long = 0,
)

@Serializable
data class PlayerUpdate(
    val versionCode: Int,
    val versionName: String,
    val url: String,
    val sha256: String,
    val bytes: Long,
)

/** Progress of an update, reported in heartbeats (shown to staff in Screens & players). */
@Serializable
data class UpdateStatus(
    val versionCode: Int,
    val versionName: String,
    /** downloading | installing | waiting_user | failed */
    val state: String,
    val error: String? = null,
    val at: Long,
)

@Serializable
data class ScreenInfo(
    val id: String,
    val name: String,
    val orientation: String,
    val resolution: Size,
    val manifestVersion: Int,
)

@Serializable
data class DeviceConfig(val pollSec: Int = 60, val heartbeatSec: Int = 300)

@Serializable
data class Playing(val playlistId: String?, val itemId: String?, val source: String)

@Serializable
data class RemoteCommand(val id: String, val type: String, val createdAt: Long = 0)

@Serializable
data class CommandList(val commands: List<RemoteCommand> = emptyList())

@Serializable
data class CommandResult(
    val id: String,
    val status: String,
    val result: JsonObject?,
    val screenshotJpegBase64: String?,
)

@Serializable
data class Heartbeat(
    val appVersion: String,
    val display: Size,
    val storageFreeMb: Long?,
    val playing: Playing?,
    val manifestVersion: Int?,
    val errors: List<String>,
    val update: UpdateStatus? = null,
)

// ---------------------------------------------------------------- live sensor data (phase 5)

@Serializable
data class LiveValueDto(
    val sourceId: String,
    val field: String,
    val name: String = "",
    val value: Double? = null,
    val ts: Long? = null,
    val staleAfterSec: Int = 600,
    val deviceOnline: Boolean = false,
    val unit: String = "",
    val valueType: String = "number",
)

@Serializable
data class LiveResponse(val serverTime: Long = 0, val values: List<LiveValueDto> = emptyList())

@Serializable
data class HistorySeries(val sourceId: String, val field: String, val points: List<List<Double>> = emptyList())

@Serializable
data class HistoryResponse(val serverTime: Long = 0, val series: List<HistorySeries> = emptyList())

// ---------------------------------------------------------------- data sources (phase 6)

@Serializable
data class WeatherNow(
    val tempC: Double,
    val feelsLikeC: Double? = null,
    val humidity: Double? = null,
    val windKmh: Double? = null,
    val code: Int,
    val isDay: Boolean = true,
)

@Serializable
data class WeatherDay(val date: String, val code: Int, val maxC: Double, val minC: Double)

@Serializable
data class WeatherData(val current: WeatherNow, val daily: List<WeatherDay> = emptyList(), val timezone: String = "UTC")

@Serializable
data class RssItem(val title: String, val publishedAt: Long? = null)

@Serializable
data class RssData(val feedTitle: String = "", val items: List<RssItem> = emptyList())

@Serializable
data class DataSourceValue(
    val id: String,
    val type: String,
    val name: String = "",
    val ok: Boolean = false,
    val error: String? = null,
    val fetchedAt: Long? = null,
    val weather: WeatherData? = null,
    val rss: RssData? = null,
)

@Serializable
data class DeviceDataResponse(val serverTime: Long = 0, val sources: List<DataSourceValue> = emptyList())
