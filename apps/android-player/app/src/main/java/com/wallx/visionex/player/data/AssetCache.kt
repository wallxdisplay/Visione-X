package com.wallx.visionex.player.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/**
 * Content-addressed media cache: each asset is stored as `<sha256>` and only becomes visible
 * after its checksum is verified. Partial downloads (`<sha256>.part`) resume with HTTP Range,
 * so a dropped connection never restarts a large video from zero.
 */
class AssetCache(private val dir: File, private val http: OkHttpClient) {
    init {
        dir.mkdirs()
    }

    fun fileFor(asset: Asset): File = File(dir, asset.sha256)

    fun has(asset: Asset): Boolean = fileFor(asset).let { it.exists() && it.length() == asset.bytes }

    /** Downloads every missing asset. Throws on failure; already-finished files are kept. */
    suspend fun ensureAll(assets: List<Asset>, onProgress: (Int) -> Unit) {
        val total = assets.sumOf { it.bytes }.coerceAtLeast(1)
        var done = assets.filter { has(it) }.sumOf { it.bytes }
        onProgress(((done * 100) / total).toInt())
        for (asset in assets) {
            if (has(asset)) continue
            download(asset) { delta ->
                done += delta
                onProgress(((done * 100) / total).toInt().coerceAtMost(99))
            }
        }
        onProgress(100)
    }

    private suspend fun download(asset: Asset, onBytes: (Long) -> Unit) = withContext(Dispatchers.IO) {
        val part = File(dir, "${asset.sha256}.part")
        var offset = if (part.exists()) part.length() else 0L
        if (offset > asset.bytes) {
            part.delete()
            offset = 0
        }
        val request = Request.Builder().url(asset.url).apply { if (offset > 0) header("Range", "bytes=$offset-") }.build()
        http.newCall(request).execute().use { res ->
            if (!res.isSuccessful) throw IOException("Download failed (${res.code}) for ${asset.mediaId}")
            // Server ignored the Range header: start over.
            val append = offset > 0 && res.code == 206
            if (!append) offset = 0
            val body = res.body ?: throw IOException("Empty body for ${asset.mediaId}")
            FileOutputStream(part, append).use { out ->
                val buffer = ByteArray(64 * 1024)
                val input = body.byteStream()
                while (true) {
                    coroutineContext.ensureActive()
                    val n = input.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                    onBytes(n.toLong())
                }
            }
        }
        val actual = sha256(part)
        if (actual != asset.sha256) {
            part.delete()
            throw IOException("Checksum mismatch for ${asset.mediaId}")
        }
        if (!part.renameTo(fileFor(asset))) throw IOException("Could not store ${asset.mediaId}")
    }

    /** Deletes cached files the given manifests do not reference (keeps in-progress parts of those). */
    fun prune(keep: Collection<Asset>) {
        val names = keep.flatMap { listOf(it.sha256, "${it.sha256}.part") }.toSet()
        dir.listFiles()?.filter { it.name !in names }?.forEach { it.delete() }
    }

    fun clear() {
        dir.listFiles()?.forEach { it.delete() }
    }

    companion object {
        fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buffer)
                    if (n < 0) break
                    digest.update(buffer, 0, n)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
