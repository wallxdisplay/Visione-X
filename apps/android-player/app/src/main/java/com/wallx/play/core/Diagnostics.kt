package com.wallx.play.core

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.StatFs
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.WindowManager
import com.wallx.play.BuildConfig
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.TimeZone

/** Snapshot for the "diagnostics" remote command. No secrets, no personal data. */
object Diagnostics {
    @Suppress("DEPRECATION")
    fun collect(context: Context, manifestVersion: Int?, assetDir: File, serverTimeSkewMs: Long?): JsonObject {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val stat = StatFs(context.filesDir.path)
        val metrics = DisplayMetrics().also {
            (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(it)
        }
        val refresh = (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.refreshRate
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val cacheBytes = assetDir.listFiles()?.sumOf { it.length() } ?: 0L

        return buildJsonObject {
            put("app", BuildConfig.VERSION_NAME)
            put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
            put("android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: "?")
            put("uptimeMin", SystemClock.elapsedRealtime() / 60_000)
            put("memoryAvailMb", mem.availMem / (1024 * 1024))
            put("memoryTotalMb", mem.totalMem / (1024 * 1024))
            put("lowMemory", mem.lowMemory)
            put("storageFreeMb", stat.availableBytes / (1024 * 1024))
            put("storageTotalMb", stat.totalBytes / (1024 * 1024))
            put("mediaCacheMb", cacheBytes / (1024 * 1024))
            put("display", "${metrics.widthPixels}x${metrics.heightPixels} @ ${"%.0f".format(refresh)}Hz")
            put("network", network(context))
            put("timezone", TimeZone.getDefault().id)
            serverTimeSkewMs?.let { put("clockSkewSec", it / 1000) }
            put("manifestVersion", manifestVersion ?: 0)
            put("kioskDeviceOwner", dpm.isDeviceOwnerApp(context.packageName))
            put("decoders", decoders())
        }
    }

    private fun network(context: Context): String {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "none"
        return when {
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "other"
        } + if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) "" else " (no internet)"
    }

    /** Video decoders by codec, flagging likely hardware ones (non-Google software codecs). */
    private fun decoders(): String {
        val wanted = mapOf("video/avc" to "H.264", "video/hevc" to "HEVC", "video/x-vnd.on2.vp9" to "VP9")
        val infos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
        return wanted.entries.joinToString(", ") { (mime, label) ->
            val matching = infos.filter { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } }
            val hw = matching.any { isHardware(it) }
            "$label:${if (matching.isEmpty()) "no" else if (hw) "hw" else "sw"}"
        }
    }

    private fun isHardware(info: MediaCodecInfo): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) info.isHardwareAccelerated
        else !info.name.startsWith("OMX.google.", ignoreCase = true) && !info.name.startsWith("c2.android.", ignoreCase = true)
}
