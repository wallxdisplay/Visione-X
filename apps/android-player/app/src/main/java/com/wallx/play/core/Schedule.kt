package com.wallx.play.core

import com.wallx.play.data.Emergency
import com.wallx.play.data.ScheduleRule
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Port of packages/layout-spec/src/schedule.ts. Must stay behaviourally identical — the same
 * cases are tested on both sides (ScheduleTest.kt mirrors schedule.test.ts).
 */
object Schedule {
    data class LocalParts(val date: String, val dow: Int, val minutes: Int)

    /** Wall-clock date/time of an instant in an IANA zone; dow 0 = Sunday. */
    fun localParts(ms: Long, timezone: String): LocalParts {
        val z = Instant.ofEpochMilli(ms).atZone(ZoneId.of(timezone))
        return LocalParts(z.toLocalDate().toString(), z.dayOfWeek.value % 7, z.hour * 60 + z.minute)
    }

    private fun toMinutes(hhmm: String) = hhmm.substring(0, 2).toInt() * 60 + hhmm.substring(3, 5).toInt()

    private fun previousDate(date: String) = LocalDate.parse(date).minusDays(1).toString()

    private fun dayMatches(rule: ScheduleRule, date: String, dow: Int): Boolean {
        if (rule.startDate != null && date < rule.startDate) return false
        if (rule.endDate != null && date > rule.endDate) return false
        return rule.daysOfWeek.isEmpty() || dow in rule.daysOfWeek
    }

    fun ruleActiveAt(rule: ScheduleRule, ms: Long): Boolean {
        val (date, dow, minutes) = localParts(ms, rule.timezone)
        val ws = rule.windowStart
        val we = rule.windowEnd
        if (ws == null || we == null) return dayMatches(rule, date, dow)
        val start = toMinutes(ws)
        val end = toMinutes(we)
        if (end > start) return dayMatches(rule, date, dow) && minutes >= start && minutes < end
        // Overnight window: after midnight belongs to the previous day's occurrence.
        if (minutes >= start) return dayMatches(rule, date, dow)
        if (minutes < end) return dayMatches(rule, previousDate(date), (dow + 6) % 7)
        return false
    }

    data class Resolution(val playlistId: String?, val source: String, val ruleId: String? = null)

    fun resolvePlaylist(
        schedules: List<ScheduleRule>,
        defaultPlaylistId: String?,
        emergency: Emergency?,
        ms: Long,
    ): Resolution {
        if (emergency != null && (emergency.expiresAt == null || emergency.expiresAt > ms)) {
            return Resolution(emergency.playlistId, "emergency")
        }
        val winner = schedules
            .filter { ruleActiveAt(it, ms) }
            .sortedWith(
                compareByDescending<ScheduleRule> { it.priority }
                    .thenByDescending { it.startDate ?: "" }
                    .thenBy { it.id },
            )
            .firstOrNull()
        if (winner != null) return Resolution(winner.playlistId, "schedule", winner.id)
        return if (defaultPlaylistId != null) Resolution(defaultPlaylistId, "default") else Resolution(null, "none")
    }
}
