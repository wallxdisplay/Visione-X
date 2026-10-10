package com.wallx.visionex.player.data

import android.content.Context
import java.io.File

/**
 * Device credentials. Stored in the app's private storage, which other apps cannot read; the
 * secret only identifies this box to Visione-X and can be revoked by removing the screen.
 */
class DeviceStore(context: Context) {
    private val prefs = context.getSharedPreferences("device", Context.MODE_PRIVATE)

    val deviceId: String? get() = prefs.getString("deviceId", null)
    private val secret: String? get() = prefs.getString("secret", null)

    /** `Authorization` header value, or null when not registered yet. */
    val auth: String? get() = deviceId?.let { id -> secret?.let { "Device $id:$it" } }

    fun save(deviceId: String, secret: String) {
        prefs.edit().putString("deviceId", deviceId).putString("secret", secret).commit()
    }

    fun clear() {
        prefs.edit().clear().commit()
    }
}

/**
 * The last manifest whose assets were all downloaded and verified ("active") — what the screen
 * plays, including after a reboot without network. Written atomically.
 */
class ManifestStore(context: Context) {
    private val file = File(context.filesDir, "manifest.json")

    fun load(): Manifest? = runCatching {
        if (!file.exists()) null else json.decodeFromString<Manifest>(file.readText())
    }.getOrNull()?.takeIf { it.specVersion <= SUPPORTED_SPEC_VERSION }

    fun save(raw: String) {
        val tmp = File(file.parentFile, "manifest.json.tmp")
        tmp.writeText(raw)
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    fun clear() {
        file.delete()
    }
}
