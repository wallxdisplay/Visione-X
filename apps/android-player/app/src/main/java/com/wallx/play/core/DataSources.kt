package com.wallx.play.core

import com.wallx.play.data.DataSourceValue
import com.wallx.play.data.DeviceDataResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Weather / RSS / air quality values for the playing manifest, refreshed from /devices/data every
 * POLL_SEC. The server fetches and caches providers; when the network is down the last values
 * stay on screen.
 */
class DataStore {
    private val _values = MutableStateFlow<Map<String, DataSourceValue>>(emptyMap())
    val values: StateFlow<Map<String, DataSourceValue>> = _values.asStateFlow()

    fun apply(res: DeviceDataResponse) {
        // Keep a previous good value when the server now only has an error for it.
        val previous = _values.value
        _values.value = res.sources.associate { v ->
            val keep = previous[v.id]
            v.id to if (v.weather == null && v.rss == null && v.airQuality == null && keep != null) keep.copy(ok = false, error = v.error) else v
        }
    }

    fun retain(ids: Set<String>) {
        _values.value = _values.value.filterKeys { it in ids }
    }

    companion object {
        const val POLL_SEC = 300L
    }
}

/** WMO weather codes → condition and symbol (mirror of weatherCondition/weatherIcon in live.ts). */
object Weather {
    fun condition(code: Int): String = when {
        code == 0 -> "clear"
        code <= 2 -> "partly"
        code == 3 -> "cloudy"
        code == 45 || code == 48 -> "fog"
        code in 51..57 -> "drizzle"
        code in 61..67 || code in 80..82 -> "rain"
        code in 71..77 || code == 85 || code == 86 -> "snow"
        code >= 95 -> "storm"
        else -> "cloudy"
    }

    fun icon(condition: String, isDay: Boolean = true): String = when (condition) {
        "clear" -> if (isDay) "☀️" else "🌙"
        "partly" -> if (isDay) "⛅" else "☁️"
        "cloudy" -> "☁️"
        "fog" -> "🌫️"
        "drizzle" -> "🌦️"
        "rain" -> "🌧️"
        "snow" -> "❄️"
        "storm" -> "⛈️"
        else -> "☁️"
    }

    /** English labels (the player UI is English in v1, like the web app). */
    fun label(condition: String): String = when (condition) {
        "clear" -> "Clear"
        "partly" -> "Partly cloudy"
        "cloudy" -> "Cloudy"
        "fog" -> "Fog"
        "drizzle" -> "Drizzle"
        "rain" -> "Rain"
        "snow" -> "Snow"
        "storm" -> "Thunderstorm"
        else -> ""
    }
}
