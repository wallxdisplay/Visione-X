package com.wallx.play

import com.wallx.play.core.PlayLog
import com.wallx.play.data.PlayBucketBody
import com.wallx.play.data.UptimeBucketBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Proof-of-play counting: hours, time on screen, persistence and upload batches. */
class PlayLogTest {
    @get:Rule val tmp = TemporaryFolder()

    private val h0 = 1_790_000_000_000L - Math.floorMod(1_790_000_000_000L, PlayLog.HOUR_MS)
    private var now = h0 + 50 * 60_000L // 50 minutes into the hour
    private fun log(file: java.io.File? = tmp.root.resolve("plays.json")) = PlayLog(file) { now }

    @Test
    fun countsPlaysAndSplitsTimeAcrossHours() {
        val log = log()
        val a = log.start("media", "m1")
        now += 4 * 60_000L
        log.end(a)
        val b = log.start("layout", "l1")
        now += 20 * 60_000L
        log.end(b)
        assertEquals(
            listOf(
                PlayBucketBody(h0, "media", "m1", 1, 240),
                PlayBucketBody(h0, "layout", "l1", 1, 360),
                PlayBucketBody(h0 + PlayLog.HOUR_MS, "layout", "l1", 0, 840),
            ).sortedWith(compareBy({ it.hour }, { it.kind }, { it.id })),
            log.snapshot(),
        )
    }

    @Test
    fun checkpointCountsWhatIsStillOnScreen() {
        val log = log()
        log.start("media", "m1")
        now += 30_000L
        log.checkpoint()
        now += 30_000L
        log.checkpoint()
        assertEquals(listOf(PlayBucketBody(h0, "media", "m1", 1, 60)), log.snapshot())
    }

    @Test
    fun batchesOnlyFinishedHoursAndKeepTheIdUntilConfirmed() {
        val log = log()
        log.end(log.start("media", "m1"))
        assertNull("the current hour is not finished", log.nextBatch())

        now = h0 + PlayLog.HOUR_MS + 5_000L
        log.end(log.start("media", "m2")) // in the new, unfinished hour
        val batch = log.nextBatch()!!
        assertEquals(listOf("m1"), batch.buckets.map { it.id })
        assertEquals("a retry reuses the batch", batch.id, log.nextBatch()!!.id)

        // Survives a restart while waiting for the server.
        val reloaded = log()
        assertEquals(batch, reloaded.nextBatch())
        reloaded.acknowledge(batch.id)
        assertNull(reloaded.nextBatch())
        assertEquals(listOf("m2"), reloaded.snapshot().map { it.id })
    }

    @Test
    fun clearForgetsEverything() {
        val file = tmp.root.resolve("plays.json")
        val log = log(file)
        log.start("media", "m1")
        log.save()
        log.clear()
        assertEquals(emptyList<PlayBucketBody>(), log.snapshot())
        assertEquals(false, file.exists())
    }

    @Test
    fun uptimeSplitsAcrossHoursAndTravelsInBatches() {
        val log = log()
        now = h0 + 59 * 60_000L // minute 58–59, online
        log.addUptime(60, online = true)
        now = h0 + PlayLog.HOUR_MS + 30_000L // 59:30–00:30, offline: half in each hour
        log.addUptime(60, online = false)
        assertEquals(listOf(UptimeBucketBody(h0, 90, 60), UptimeBucketBody(h0 + PlayLog.HOUR_MS, 30, 0)), log.uptimeSnapshot())

        now = h0 + PlayLog.HOUR_MS + 10 * 60_000L
        val batch = log.nextBatch()!!
        assertEquals(emptyList<PlayBucketBody>(), batch.buckets)
        assertEquals(listOf(UptimeBucketBody(h0, 90, 60)), batch.uptime)
        // Kept with the pending batch through a restart.
        assertEquals(batch, log().nextBatch())
    }
}
