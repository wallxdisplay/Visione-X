package com.wallx.play.core

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.wallx.play.BuildConfig
import com.wallx.play.ErrorLog
import com.wallx.play.PlayerApp.Companion.TAG
import com.wallx.play.UpdateReceiver
import com.wallx.play.data.PlayerUpdate
import com.wallx.play.data.UpdateStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * In-app updates. When the server offers a newer release, the APK is downloaded in the
 * background (playback continues), checked (size, SHA-256, package, version and signing key
 * must match the installed app) and handed to Android's PackageInstaller.
 *
 * Kiosk boxes (device owner) and Android 12+ (an app updating itself) can install without a
 * tap. Otherwise Android needs someone to select Install: the prompt is kept ready and shown
 * only when someone at the box presses a key or staff send "Install player update" — never on
 * its own over the signage. The state is reported in heartbeats ("waiting_user").
 */
class Updater internal constructor(
    private val context: Context,
    private val http: OkHttpClient,
    private val currentVersion: Int = BuildConfig.VERSION_CODE,
    private val dir: File = File(context.filesDir, "updates"),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow<UpdateStatus?>(null)
    val status: StateFlow<UpdateStatus?> = _status.asStateFlow()

    private val busy = Mutex()
    private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)

    /** Android's confirmation screen for a committed install, waiting for someone at the box. */
    @Volatile private var pendingConfirm: Intent? = null
    @Volatile private var promptWhenPending = false
    @Volatile private var offered: PlayerUpdate? = null

    /** Checks a downloaded APK; returns why it may not be installed, or null. Replaceable in tests. */
    internal var verifyArchive: (File, Int) -> String? = ::verifyWithPackageManager

    /** Starts the install (result arrives in [UpdateReceiver]). Replaceable in tests. */
    internal var installer: (File) -> Unit = ::commitSession

    /** Shows an activity (the install prompt). Replaceable in tests. */
    internal var launcher: (Intent) -> Unit = { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }

    /** Called on every state poll with the server's offer (null = nothing to install). */
    suspend fun offer(update: PlayerUpdate?) {
        offered = update
        if (update == null || update.versionCode <= currentVersion) {
            _status.value = null
            pendingConfirm = null
            withContext(Dispatchers.IO) { cleanup(keep = null) }
            return
        }
        val s = _status.value
        // Already waiting for a tap, or an install is running: nothing to do until it resolves.
        if (s?.versionCode == update.versionCode && (s.state == "waiting_user" || s.state == "installing")) return
        val failedAt = prefs.getLong(failedKey(update.versionCode), 0L)
        if (failedAt > 0 && now() - failedAt < RETRY_AFTER_MS) return
        if (!busy.tryLock()) return
        try {
            install(update)
        } finally {
            busy.unlock()
        }
    }

    /**
     * Someone is at the box (key press) or staff asked for it: show the install prompt for a
     * downloaded update. Returns false when no update is downloaded.
     */
    suspend fun showPrompt(): Boolean {
        pendingConfirm?.let {
            pendingConfirm = null
            launcher(it)
            return true
        }
        val update = offered ?: return false
        if (update.versionCode <= currentVersion || !apkFile(update).exists()) return false
        promptWhenPending = true
        if (!busy.tryLock()) return true
        try {
            install(update, redownload = false)
        } finally {
            busy.unlock()
        }
        return true
    }

    private suspend fun install(update: PlayerUpdate, redownload: Boolean = true) {
        try {
            val file = apkFile(update)
            if (!file.exists()) {
                if (!redownload) return
                report(update, "downloading")
                withContext(Dispatchers.IO) { download(update, file) }
            }
            verifyArchive(file, update.versionCode)?.let {
                file.delete()
                throw IOException(it)
            }
            report(update, "installing")
            withContext(Dispatchers.IO) { installer(file) }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            onFailed(update.versionCode, e.message ?: e.javaClass.simpleName)
        }
    }

    // ---------------------------------------------------------------- results from Android

    /** Android needs someone to select Install. */
    fun onNeedsUser(confirm: Intent?) {
        val update = offered ?: return
        if (confirm == null) {
            onFailed(update.versionCode, "install prompt unavailable")
            return
        }
        report(update, "waiting_user")
        if (promptWhenPending) {
            promptWhenPending = false
            launcher(confirm)
        } else {
            pendingConfirm = confirm
        }
    }

    /** Install failed or the prompt was dismissed; try again in a few hours. */
    fun onFailed(versionCode: Int, message: String) {
        Log.w(TAG, "Player update $versionCode failed: $message")
        ErrorLog.record(context, "update $versionCode: $message")
        prefs.edit().putLong(failedKey(versionCode), now()).apply()
        pendingConfirm = null
        promptWhenPending = false
        val update = offered?.takeIf { it.versionCode == versionCode }
        _status.value = UpdateStatus(versionCode, update?.versionName ?: "", "failed", message.take(200), now())
    }

    // ---------------------------------------------------------------- download and checks

    private fun apkFile(update: PlayerUpdate) = File(dir, "player-${update.versionCode}.apk")
    private fun failedKey(versionCode: Int) = "failedAt.$versionCode"

    private fun report(update: PlayerUpdate, state: String) {
        _status.value = UpdateStatus(update.versionCode, update.versionName, state, null, now())
    }

    private fun download(update: PlayerUpdate, target: File) {
        dir.mkdirs()
        cleanup(keep = target.name)
        val part = File(dir, target.name + ".part")
        val digest = MessageDigest.getInstance("SHA-256")
        http.newCall(Request.Builder().url(update.url).get().build()).execute().use { res ->
            if (!res.isSuccessful) throw IOException("download HTTP ${res.code}")
            val body = res.body ?: throw IOException("download: empty response")
            var total = 0L
            part.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > update.bytes) throw IOException("download larger than announced")
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
            if (total != update.bytes) throw IOException("download incomplete ($total of ${update.bytes} bytes)")
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        if (!sha.equals(update.sha256, ignoreCase = true)) {
            part.delete()
            throw IOException("download checksum mismatch")
        }
        if (!part.renameTo(target)) throw IOException("could not store the update")
    }

    private fun cleanup(keep: String?) {
        dir.listFiles()?.filter { it.name != keep }?.forEach { it.delete() }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("PackageManagerGetSignatures")
    private fun verifyWithPackageManager(file: File, versionCode: Int): String? {
        val pm = context.packageManager
        val flags = PackageManager.GET_SIGNATURES or (if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else 0)
        val archive = pm.getPackageArchiveInfo(file.path, flags) ?: return "not a valid APK"
        if (archive.packageName != context.packageName) return "wrong app (${archive.packageName})"
        val archiveVersion = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode.toInt() else archive.versionCode
        if (archiveVersion != versionCode) return "APK is version $archiveVersion, expected $versionCode"
        val theirs = signers(archive)
        val mine = signers(pm.getPackageInfo(context.packageName, flags))
        // Some Android versions cannot read signers from an archive; the installer still refuses a key change.
        if (theirs.isNotEmpty() && mine.isNotEmpty() && theirs != mine) return "signed with a different key"
        return null
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> {
        val certs = if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            info.signingInfo!!.apkContentsSigners.toList()
        } else {
            info.signatures?.toList().orEmpty()
        }
        return certs.map { sig -> MessageDigest.getInstance("SHA-256").digest(sig.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
    }

    private fun commitSession(file: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(file.length())
            // Android 12+: an app may update itself without a tap.
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            session.openWrite("player.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val callback = PendingIntent.getBroadcast(context, sessionId, Intent(context, UpdateReceiver::class.java), flags)
            session.commit(callback.intentSender)
        }
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        Log.i(TAG, "Player update committed (device owner: ${dpm.isDeviceOwnerApp(context.packageName)})")
    }

    companion object {
        /** After a failure or a dismissed prompt, try again this much later. */
        const val RETRY_AFTER_MS = 6 * 60 * 60_000L
    }
}
