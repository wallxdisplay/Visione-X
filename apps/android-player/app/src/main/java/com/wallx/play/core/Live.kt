package com.wallx.play.core

import com.wallx.play.data.HistoryResponse
import com.wallx.play.data.LiveChannel
import com.wallx.play.data.LiveResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/** One live sensor value (mirror of LiveValue in packages/layout-spec/src/live.ts). */
data class LiveValue(
    val value: Double?,
    val ts: Long?,
    val staleAfterSec: Int,
    val deviceOnline: Boolean,
    val valueType: String = "number",
    /** The channel's unit, e.g. "°C" (shown by table cells). */
    val unit: String = "",
)

enum class LiveState { OK, STALE, OFFLINE, NODATA }

/** Display rules shared with the web renderer. Keep in step with live.ts. */
object Live {
    fun state(v: LiveValue?, now: Long, staleOverrideSec: Int? = null): LiveState {
        if (v?.value == null || v.ts == null) return LiveState.NODATA
        if (!v.deviceOnline) return LiveState.OFFLINE
        val staleAfter = (staleOverrideSec ?: v.staleAfterSec) * 1000L
        return if (now - v.ts > staleAfter) LiveState.STALE else LiveState.OK
    }

    /** Up to one decimal without a trailing ".0", or exactly [decimals]. */
    fun format(value: Double, decimals: Int? = null): String {
        if (decimals != null) return String.format(Locale.US, "%.${decimals}f", value)
        if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) return value.toLong().toString()
        return String.format(Locale.US, "%.1f", value).removeSuffix(".0")
    }

    private fun compare(op: String, v: Double, limit: Double) = when (op) {
        ">" -> v > limit
        ">=" -> v >= limit
        "<" -> v < limit
        "<=" -> v <= limit
        else -> false
    }

    data class Band(val label: String, val operator: String, val value: Double, val color: String)

    /** First band the value falls in. */
    fun band(bands: List<Band>, value: Double): Band? = bands.firstOrNull { compare(it.operator, value, it.value) }

    /** Numbers compare numerically; true/on = non-zero, false/off = zero. */
    fun statusMatches(match: String, value: Double): Boolean {
        val m = match.trim().lowercase(Locale.ROOT)
        if (m == "true" || m == "on") return value != 0.0
        if (m == "false" || m == "off") return value == 0.0
        val n = m.toDoubleOrNull() ?: return false
        return n == value
    }

    fun gaugeFraction(value: Double, min: Double, max: Double): Float {
        if (max <= min) return 0f
        return min(1.0, max(0.0, (value - min) / (max - min))).toFloat()
    }
}

/**
 * Live values and chart history for the channels of the playing manifest. The engine fills it
 * from /devices/live (every LIVE_POLL_SEC) and /devices/live/history (every HISTORY_POLL_SEC);
 * between history fetches, new live readings are appended to the series so charts move.
 * When the network is down the last values stay, and widgets show them as stale.
 */
class LiveStore {
    private val _values = MutableStateFlow<Map<String, LiveValue>>(emptyMap())
    val values: StateFlow<Map<String, LiveValue>> = _values.asStateFlow()
    private val _history = MutableStateFlow<Map<String, List<Pair<Long, Double>>>>(emptyMap())
    val history: StateFlow<Map<String, List<Pair<Long, Double>>>> = _history.asStateFlow()

    /** Channel names by key, for chart legends (updated with the values). */
    @Volatile var names: Map<String, String> = emptyMap()
        private set

    fun applyLive(res: LiveResponse, channels: List<LiveChannel>) {
        val next = res.values.associate {
            "${it.sourceId}/${it.field}" to LiveValue(it.value, it.ts, it.staleAfterSec, it.deviceOnline, it.valueType, it.unit)
        }
        names = res.values.associate { "${it.sourceId}/${it.field}" to it.name.ifEmpty { it.field } }
        _values.value = next
        // Append newer readings to charted series, trimmed to each chart's window.
        val windows = channels.filter { it.historyMinutes != null }.associate { it.key to it.historyMinutes!! }
        if (windows.isEmpty()) return
        val hist = _history.value.toMutableMap()
        for ((key, minutes) in windows) {
            val v = next[key] ?: continue
            val value = v.value ?: continue
            val ts = v.ts ?: continue
            val series = hist[key].orEmpty()
            if (series.isNotEmpty() && series.last().first >= ts) continue
            val from = ts - minutes * 60_000L
            hist[key] = (series + (ts to value)).filter { it.first >= from }
        }
        _history.value = hist
    }

    fun applyHistory(res: HistoryResponse) {
        _history.value = res.series.associate { s ->
            "${s.sourceId}/${s.field}" to s.points.mapNotNull { p -> if (p.size >= 2) p[0].toLong() to p[1] else null }
        }
    }

    /** Drops channels no longer shown (after a new manifest). */
    fun retain(channels: List<LiveChannel>) {
        val keys = channels.map { it.key }.toSet()
        _values.value = _values.value.filterKeys { it in keys }
        _history.value = _history.value.filterKeys { it in keys }
    }

    companion object {
        const val LIVE_POLL_SEC = 15L
        const val HISTORY_POLL_SEC = 300L
    }
}
