package com.wallx.play.core

import com.wallx.play.data.PlayBucketBody
import com.wallx.play.data.UptimeBucketBody
import com.wallx.play.data.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.util.UUID

/**
 * Proof-of-play: counts what the screen shows (media items and layouts, also inside layout
 * zones) per UTC hour, keeps the counts in a file so they survive restarts and offline days,
 * and hands finished hours to the uploader as batches. A batch keeps its id until the server
 * confirms it, so an upload retried after a lost response is counted once. Also keeps how long
 * the player ran and was online per hour (uptime for screen analytics, 0.14.0+).
 */
class PlayLog(
    private val file: File?,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    @Serializable
    data class Batch(val id: String, val buckets: List<PlayBucketBody>, val uptime: List<UptimeBucketBody> = emptyList())

    @Serializable
    private data class Saved(
        val buckets: List<PlayBucketBody> = emptyList(),
        val uptime: List<UptimeBucketBody> = emptyList(),
        val pending: Batch? = null,
    )

    private class Showing(val kind: String, val id: String, var since: Long)

    private val lock = Any()
    private val buckets = LinkedHashMap<String, PlayBucketBody>()
    private val uptime = LinkedHashMap<Long, UptimeBucketBody>()
    private val showing = HashMap<Long, Showing>()
    private var nextHandle = 1L
    private var pending: Batch? = null

    init {
        val saved = file?.takeIf { it.exists() }?.let { runCatching { json.decodeFromString<Saved>(it.readText()) }.getOrNull() }
        saved?.buckets?.forEach { buckets[key(it.hour, it.kind, it.id)] = it }
        saved?.uptime?.forEach { uptime[it.hour] = it }
        pending = saved?.pending
    }

    /** Something came on screen; returns a handle for [end]. */
    fun start(kind: String, id: String): Long = synchronized(lock) {
        val now = clock()
        update(hourOf(now), kind, id) { it.copy(plays = it.plays + 1) }
        val handle = nextHandle++
        showing[handle] = Showing(kind, id, now)
        handle
    }

    /** It left the screen: its time on screen is added to the hours it covered. */
    fun end(handle: Long) = synchronized(lock) {
        showing.remove(handle)?.let { addSeconds(it.kind, it.id, it.since, clock()) }
        Unit
    }

    /**
     * The player ran for the last [seconds] (called every minute); [online] when its last contact
     * with the server worked. Split across hours like plays.
     */
    fun addUptime(seconds: Int, online: Boolean) = synchronized(lock) {
        val to = clock()
        var t = to - seconds * 1000L
        while (t < to) {
            val hour = hourOf(t)
            val until = minOf(to, hour + HOUR_MS)
            val secs = ((until - t) / 1000).toInt()
            val c = uptime[hour] ?: UptimeBucketBody(hour, 0, 0)
            uptime[hour] = UptimeBucketBody(hour, minOf(3600, c.on + secs), minOf(3600, c.online + if (online) secs else 0))
            t = until
        }
    }

    /** Counts the time so far of what is still on screen (before saving or uploading). */
    fun checkpoint() = synchronized(lock) {
        val now = clock()
        for (s in showing.values) {
            addSeconds(s.kind, s.id, s.since, now)
            s.since = now
        }
    }

    /**
     * The batch to upload now: the one still waiting for confirmation, else the finished hours
     * (at most [MAX_BUCKETS]). Null when there is nothing to send.
     */
    fun nextBatch(): Batch? = synchronized(lock) {
        pending?.let { return it }
        checkpoint()
        val currentHour = hourOf(clock())
        val done = buckets.values.filter { it.hour < currentHour }.sortedBy { it.hour }.take(MAX_BUCKETS)
        val up = uptime.values.filter { it.hour < currentHour }.sortedBy { it.hour }.take(MAX_BUCKETS)
        if (done.isEmpty() && up.isEmpty()) return null
        done.forEach { buckets.remove(key(it.hour, it.kind, it.id)) }
        up.forEach { uptime.remove(it.hour) }
        pending = Batch(UUID.randomUUID().toString().replace("-", ""), done, up)
        save()
        pending
    }

    /** The server confirmed (or permanently refused) this batch. */
    fun acknowledge(batchId: String) = synchronized(lock) {
        if (pending?.id == batchId) {
            pending = null
            save()
        }
    }

    /** Writes the counts to the file (atomically). */
    fun save() = synchronized(lock) {
        val target = file ?: return@synchronized
        // A box offline for weeks keeps only the newest hours.
        if (buckets.size > MAX_STORED) {
            buckets.values.sortedBy { it.hour }.take(buckets.size - MAX_STORED).forEach { buckets.remove(key(it.hour, it.kind, it.id)) }
        }
        if (uptime.size > MAX_STORED) uptime.keys.sorted().take(uptime.size - MAX_STORED).forEach { uptime.remove(it) }
        val tmp = File(target.parentFile, target.name + ".tmp")
        tmp.writeText(json.encodeToString(Saved(buckets.values.toList(), uptime.values.toList(), pending)))
        if (!tmp.renameTo(target)) {
            target.delete()
            tmp.renameTo(target)
        }
    }

    /** Forgets everything (the box was reset and will become a different screen). */
    fun clear() = synchronized(lock) {
        buckets.clear()
        uptime.clear()
        showing.clear()
        pending = null
        file?.delete()
        Unit
    }

    /** Uptime not yet uploaded (for tests). */
    fun uptimeSnapshot(): List<UptimeBucketBody> = synchronized(lock) { uptime.values.sortedBy { it.hour } }

    /** Counts not yet uploaded (for tests and diagnostics). */
    fun snapshot(): List<PlayBucketBody> = synchronized(lock) { buckets.values.sortedWith(compareBy({ it.hour }, { it.kind }, { it.id })) }

    private fun addSeconds(kind: String, id: String, from: Long, to: Long) {
        var t = from
        while (t < to) {
            val hour = hourOf(t)
            val until = minOf(to, hour + HOUR_MS)
            val secs = (until - t) / 1000
            if (secs > 0) update(hour, kind, id) { it.copy(seconds = it.seconds + secs) }
            t = until
        }
    }

    private inline fun update(hour: Long, kind: String, id: String, change: (PlayBucketBody) -> PlayBucketBody) {
        val k = key(hour, kind, id)
        buckets[k] = change(buckets[k] ?: PlayBucketBody(hour, kind, id, 0, 0))
    }

    companion object {
        const val HOUR_MS = 3_600_000L
        const val MAX_BUCKETS = 2000
        const val MAX_STORED = 20_000
        fun hourOf(ms: Long) = ms - Math.floorMod(ms, HOUR_MS)
        private fun key(hour: Long, kind: String, id: String) = "$hour|$kind|$id"
    }
}
