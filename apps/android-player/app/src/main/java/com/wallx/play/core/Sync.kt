package com.wallx.play.core

/**
 * Multi-screen sync. Every player of a sync group derives what to show from the group's anchor
 * time and the playlist's durations, so they change items at the same instant without talking to
 * each other, and a player that restarts rejoins exactly in place. This needs a good estimate of
 * server time ([ClockSync]); videos are kept in step by [VideoDrift].
 */

/** Where the shared timeline is at a given server time. */
data class TimelinePosition(val index: Int, val startedAt: Long, val endsAt: Long)

object SyncTimeline {
    /** Item playing at server time [now] for items of [durationsMs] repeating from [anchor]. */
    fun position(durationsMs: List<Long>, anchor: Long, now: Long): TimelinePosition {
        val cycle = durationsMs.sum()
        if (durationsMs.isEmpty() || cycle <= 0) return TimelinePosition(0, now, Long.MAX_VALUE)
        val intoCycle = Math.floorMod(now - anchor, cycle)
        val cycleStart = now - intoCycle
        var t = 0L
        durationsMs.forEachIndexed { i, d ->
            if (intoCycle < t + d) return TimelinePosition(i, cycleStart + t, cycleStart + t + d)
            t += d
        }
        return TimelinePosition(durationsMs.lastIndex, cycleStart + cycle - durationsMs.last(), cycleStart + cycle)
    }
}

/**
 * Server clock from round trips to /devices/time (NTP-style): of the recent samples, the one with
 * the shortest round trip is the most accurate, its offset is server time minus local monotonic
 * time at the middle of the trip. Monotonic time (elapsedRealtime) does not jump when the box's
 * wall clock is changed.
 */
class ClockSync(private val keep: Int = 8) {
    private data class Sample(val rttMs: Long, val offsetMs: Long)

    private val samples = ArrayDeque<Sample>()

    @Synchronized
    fun add(sentAt: Long, receivedAt: Long, serverTime: Long) {
        val rtt = receivedAt - sentAt
        if (rtt < 0) return
        samples.addLast(Sample(rtt, serverTime - (sentAt + rtt / 2)))
        while (samples.size > keep) samples.removeFirst()
    }

    /** Server time minus monotonic time, or null before the first sample. */
    @get:Synchronized
    val offsetMs: Long? get() = samples.minByOrNull { it.rttMs }?.offsetMs

    /** Half the best round trip: how far off the estimate can be at most. */
    @get:Synchronized
    val accuracyMs: Long? get() = samples.minByOrNull { it.rttMs }?.rttMs?.div(2)
}

/** How to bring a video back in step with the timeline. */
sealed interface DriftFix {
    data object None : DriftFix
    data class Speed(val speed: Float) : DriftFix
    data object Seek : DriftFix
}

object VideoDrift {
    /** Below this the video counts as in step. */
    const val TOLERANCE_MS = 40L
    /** Beyond this a jump is better than a long catch-up. */
    const val SEEK_MS = 500L

    /** Signed drift of [positionMs] from [expectedMs] on a loop of [durationMs] (−d/2 … d/2]. */
    fun drift(positionMs: Long, expectedMs: Long, durationMs: Long): Long {
        if (durationMs <= 0) return positionMs - expectedMs
        val d = Math.floorMod(positionMs - expectedMs, durationMs)
        return if (d > durationMs / 2) d - durationMs else d
    }

    /** Ahead → play slightly slower; behind → slightly faster; far off → jump. */
    fun fix(driftMs: Long): DriftFix = when {
        kotlin.math.abs(driftMs) > SEEK_MS -> DriftFix.Seek
        driftMs > TOLERANCE_MS -> DriftFix.Speed(0.95f)
        driftMs < -TOLERANCE_MS -> DriftFix.Speed(1.05f)
        else -> DriftFix.None
    }
}
