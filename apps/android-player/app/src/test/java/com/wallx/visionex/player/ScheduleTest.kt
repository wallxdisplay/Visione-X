package com.wallx.visionex.player

import com.wallx.visionex.player.core.Schedule
import com.wallx.visionex.player.data.Emergency
import com.wallx.visionex.player.data.ScheduleRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.OffsetDateTime

/** Mirrors packages/layout-spec/src/schedule.test.ts case for case. 2026-10-09 is a Friday. */
class ScheduleTest {
    private fun ist(date: String, hhmm: String) = OffsetDateTime.parse("${date}T$hhmm:00+05:30").toInstant().toEpochMilli()

    private fun rule(
        id: String = "r",
        priority: Int = 10,
        timezone: String = "Asia/Kolkata",
        startDate: String? = null,
        endDate: String? = null,
        days: List<Int> = emptyList(),
        from: String? = null,
        to: String? = null,
        playlistId: String = "p",
    ) = ScheduleRule(id, priority, timezone, startDate, endDate, days, from, to, playlistId)

    @Test
    fun localPartsReportsWallClock() {
        assertEquals(Schedule.LocalParts("2026-10-09", 5, 23 * 60 + 45), Schedule.localParts(ist("2026-10-09", "23:45"), "Asia/Kolkata"))
    }

    @Test
    fun daytimeWindowIsStartInclusiveEndExclusive() {
        val r = rule(from = "09:00", to = "18:00")
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-09", "08:59")))
        assertTrue(Schedule.ruleActiveAt(r, ist("2026-10-09", "09:00")))
        assertTrue(Schedule.ruleActiveAt(r, ist("2026-10-09", "17:59")))
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-09", "18:00")))
    }

    @Test
    fun overnightWindowBelongsToStartDay() {
        val r = rule(from = "22:00", to = "06:00", days = listOf(5))
        assertTrue(Schedule.ruleActiveAt(r, ist("2026-10-09", "23:00")))
        assertTrue(Schedule.ruleActiveAt(r, ist("2026-10-10", "02:00")))
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-10", "23:00")))
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-09", "02:00")))
    }

    @Test
    fun respectsDateRangeAndWeekdays() {
        val r = rule(startDate = "2026-10-10", endDate = "2026-10-12", days = listOf(0, 6))
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-09", "12:00")))
        assertTrue(Schedule.ruleActiveAt(r, ist("2026-10-10", "12:00")))
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-12", "12:00")))
        assertFalse(Schedule.ruleActiveAt(r, ist("2026-10-17", "12:00")))
    }

    @Test
    fun evaluatesInRuleTimezone() {
        val london = rule(timezone = "Europe/London", from = "09:00", to = "10:00")
        assertTrue(Schedule.ruleActiveAt(london, OffsetDateTime.parse("2026-10-09T08:30:00Z").toInstant().toEpochMilli()))
        assertFalse(Schedule.ruleActiveAt(london, OffsetDateTime.parse("2026-12-09T08:30:00Z").toInstant().toEpochMilli()))
    }

    private val morning = rule(id = "morning", playlistId = "breakfast", from = "06:00", to = "11:00")
    private val promo = rule(id = "promo", playlistId = "sale", priority = 50, startDate = "2026-10-09", endDate = "2026-10-09")

    @Test
    fun higherPriorityWinsThenDefaultThenNothing() {
        val rules = listOf(morning, promo)
        assertEquals(Schedule.Resolution("sale", "schedule", "promo"), Schedule.resolvePlaylist(rules, "always", null, ist("2026-10-09", "08:00")))
        assertEquals("breakfast", Schedule.resolvePlaylist(rules, "always", null, ist("2026-10-10", "08:00")).playlistId)
        assertEquals(Schedule.Resolution("always", "default"), Schedule.resolvePlaylist(rules, "always", null, ist("2026-10-10", "20:00")))
        assertEquals(Schedule.Resolution(null, "none"), Schedule.resolvePlaylist(emptyList(), null, null, 0))
    }

    @Test
    fun emergencyOverridesUntilExpiry() {
        val at = ist("2026-10-09", "08:00")
        val e = Emergency("e", "evacuate", at + 60_000)
        assertEquals("emergency", Schedule.resolvePlaylist(listOf(morning, promo), "always", e, at).source)
        assertEquals("schedule", Schedule.resolvePlaylist(listOf(morning, promo), "always", e, at + 120_000).source)
    }

    @Test
    fun breaksTiesDeterministically() {
        val a = rule(id = "a", playlistId = "A")
        val b = rule(id = "b", playlistId = "B", startDate = "2026-10-01")
        assertEquals("B", Schedule.resolvePlaylist(listOf(a, b), null, null, ist("2026-10-09", "12:00")).playlistId)
        assertEquals("B", Schedule.resolvePlaylist(listOf(b, a), null, null, ist("2026-10-09", "12:00")).playlistId)
    }
}
