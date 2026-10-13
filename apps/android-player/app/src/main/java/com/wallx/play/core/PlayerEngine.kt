package com.wallx.play.core

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.StatFs
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import com.wallx.play.BuildConfig
import com.wallx.play.ErrorLog
import com.wallx.play.PlayerApp.Companion.TAG
import com.wallx.play.data.Api
import com.wallx.play.data.ApiException
import com.wallx.play.data.Asset
import com.wallx.play.data.AssetCache
import com.wallx.play.data.DeviceHardware
import com.wallx.play.data.DeviceState
import com.wallx.play.data.DeviceStore
import com.wallx.play.data.Heartbeat
import com.wallx.play.data.Manifest
import com.wallx.play.data.ManifestStore
import com.wallx.play.data.Playing
import com.wallx.play.data.SUPPORTED_SPEC_VERSION
import com.wallx.play.data.Size
import com.wallx.play.data.json
import com.wallx.play.data.CommandResult
import com.wallx.play.PlayerApp
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/** What the screen shows. */
sealed interface UiState {
    data object Starting : UiState
    data class Pairing(val code: String, val url: String?, val expiresAt: Long?) : UiState
    data class Waiting(val orgName: String, val screenName: String) : UiState
    data class NoContent(val orgName: String, val screenName: String) : UiState
    data class Playing(val manifest: Manifest, val library: MediaLibrary) : UiState
}

/** Cached media files by media id, for the renderer. */
class MediaLibrary(private val files: Map<String, Pair<File, String>>) {
    fun file(mediaId: String): File? = files[mediaId]?.first
    fun mimeType(mediaId: String): String? = files[mediaId]?.second
}

data class Status(
    val online: Boolean = true,
    val syncProgress: Int? = null,
    val lastError: String? = null,
)

/**
 * The player's brain: registers the box, polls the server, downloads published content and
 * reports health. Playback never depends on connectivity: the last fully downloaded manifest
 * keeps playing until a complete new one replaces it.
 */
class PlayerEngine internal constructor(
    private val context: Context,
    apiBase: String = BuildConfig.API_BASE,
) {
    private val api = Api(apiBase)
    private val device = DeviceStore(context)
    private val manifests = ManifestStore(context)
    private val cache = AssetCache(File(context.filesDir, "assets"), api.http)

    private val _ui = MutableStateFlow<UiState>(UiState.Starting)
    val ui: StateFlow<UiState> = _ui.asStateFlow()
    private val _status = MutableStateFlow(Status())
    val status: StateFlow<Status> = _status.asStateFlow()

    /** Live sensor values for the widgets of the playing manifest. */
    val live = LiveStore()

    /** Weather / RSS values for the widgets of the playing manifest. */
    val data = DataStore()

    /** Set by the renderer so heartbeats can report what is on screen. */
    @Volatile var nowPlaying: Playing? = null

    /** Set by MainActivity: captures the screen as JPEG bytes (null when not possible). */
    @Volatile var screenshotter: (suspend () -> ByteArray?)? = null

    /** Process restart / device reboot (replaceable in tests). Reboot returns false if not allowed. */
    internal var restarter: () -> Unit = {
        PlayerApp.scheduleRestart(context, 1_500)
        kotlin.system.exitProcess(0)
    }
    internal var rebooter: () -> Boolean = {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
        if (dpm.isDeviceOwnerApp(context.packageName)) {
            dpm.reboot(android.content.ComponentName(context, com.wallx.play.KioskAdminReceiver::class.java))
            true
        } else {
            false
        }
    }

    private var serverSkewMs: Long? = null

    private var pollSec = 60
    private var heartbeatSec = 300
    private var loop: Job? = null

    fun start(scope: CoroutineScope) {
        if (loop?.isActive == true) return
        // Show saved content immediately — before any network call.
        manifests.load()?.let { show(it) }
        loop = scope.launch { pollLoop() }
        scope.launch { heartbeatLoop() }
        scope.launch { liveLoop() }
        scope.launch { dataLoop() }
    }

    private suspend fun pollLoop() {
        while (currentCoroutineContextActive()) {
            if (tick()) delay(pollSec * 1000L)
        }
    }

    /**
     * One poll cycle: register if needed, read state, sync content. Returns false when the
     * identity was reset and the cycle should run again immediately.
     */
    internal suspend fun tick(): Boolean {
        try {
            val auth = ensureRegistered()
            handleState(api.me(auth))
            _status.value = _status.value.copy(online = true)
        } catch (e: ApiException) {
            if (e.status == 401 || e.code == "revoked") {
                resetIdentity("server rejected credentials (${e.code ?: e.status})")
                return false
            }
            fail("api ${e.message}")
        } catch (e: java.io.IOException) {
            _status.value = _status.value.copy(online = false)
            fail("network: ${e.message}")
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // e.g. an unexpected response shape: log and keep playing what we have.
            fail("unexpected ${e.javaClass.simpleName}: ${e.message}")
        }
        return true
    }

    private suspend fun currentCoroutineContextActive() = kotlin.coroutines.coroutineContext.isActive

    private suspend fun ensureRegistered(): String {
        device.auth?.let { return it }
        val res = api.register(hardware())
        device.save(res.deviceId, res.deviceSecret)
        Log.i(TAG, "Registered device ${res.deviceId}")
        return device.auth!!
    }

    private suspend fun handleState(state: DeviceState) {
        pollSec = state.config.pollSec.coerceIn(15, 900)
        heartbeatSec = state.config.heartbeatSec.coerceIn(60, 3600)
        if (state.serverTime > 0) serverSkewMs = System.currentTimeMillis() - state.serverTime
        val org = state.orgName ?: ""
        val screen = state.screen
        when (state.status) {
            "unpaired" -> {
                manifests.clear()
                _ui.value = UiState.Pairing(state.pairingCode ?: "", state.pairingUrl, state.pairingExpiresAt)
            }
            "pending_authorization" -> _ui.value = UiState.Waiting(org, screen?.name ?: "")
            "authorized" -> {
                val active = manifests.load()
                val latest = screen?.manifestVersion ?: 0
                if (latest > 0 && latest != active?.version) sync()
                val current = manifests.load()
                if (current == null) _ui.value = UiState.NoContent(org, screen?.name ?: "")
                else if ((_ui.value as? UiState.Playing)?.manifest?.version != current.version) show(current)
                if (state.commandsPending > 0) runCommands(org, screen?.name ?: "")
            }
            "revoked" -> resetIdentity("screen removed")
        }
    }

    /** Download a new manifest and all its assets; switch only when everything is verified. */
    private suspend fun sync() {
        val auth = device.auth ?: return
        val raw = api.manifestJson(auth)
        val manifest = json.decodeFromString<Manifest>(raw)
        if (manifest.specVersion > SUPPORTED_SPEC_VERSION) {
            fail("manifest spec ${manifest.specVersion} needs a newer player app")
            return
        }
        try {
            cache.ensureAll(manifest.assets) { pct -> _status.value = _status.value.copy(syncProgress = pct) }
        } finally {
            _status.value = _status.value.copy(syncProgress = null)
        }
        manifests.save(raw)
        cache.prune(manifest.assets)
        Log.i(TAG, "Activated manifest v${manifest.version} (${manifest.assets.size} assets)")
    }

    private class Outcome(
        val status: String,
        val result: JsonObject?,
        val screenshot: String? = null,
        val after: (() -> Unit)? = null,
    )

    /** Fetches queued remote commands, runs them, reports each result. */
    private suspend fun runCommands(org: String, screenName: String) {
        val auth = device.auth ?: return
        for (command in api.commands(auth).commands) {
            val outcome = try {
                execute(command.type, org, screenName)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Outcome("failed", buildJsonObject { put("error", "${e.javaClass.simpleName}: ${e.message}") })
            }
            api.commandResult(auth, CommandResult(command.id, outcome.status, outcome.result, outcome.screenshot))
            Log.i(TAG, "Command ${command.type} → ${outcome.status}")
            outcome.after?.invoke()
        }
    }

    private suspend fun execute(type: String, org: String, screenName: String): Outcome { return when (type) {
        "refresh" -> {
            sync()
            manifests.load()?.let { show(it) }
            Outcome("done", buildJsonObject { put("manifestVersion", manifests.load()?.version ?: 0) })
        }
        "clear_cache" -> {
            cache.clear()
            manifests.clear()
            _ui.value = UiState.NoContent(org, screenName)
            sync()
            manifests.load()?.let { show(it) }
            Outcome("done", buildJsonObject { put("manifestVersion", manifests.load()?.version ?: 0) })
        }
        "restart_app" -> Outcome("done", null, after = restarter)
        "reboot" -> {
            val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as android.app.admin.DevicePolicyManager
            if (dpm.isDeviceOwnerApp(context.packageName)) {
                Outcome("done", buildJsonObject { put("action", "reboot") }, after = { rebooter() })
            } else {
                // Not a kiosk-provisioned box: a full reboot is not permitted, restart the player instead.
                Outcome("done", buildJsonObject { put("action", "restart_app"); put("reason", "not device owner") }, after = restarter)
            }
        }
        "screenshot" -> {
            val bytes = screenshotter?.invoke() ?: return Outcome("failed", buildJsonObject { put("error", "screenshot unavailable") })
            Outcome("done", buildJsonObject { put("bytes", bytes.size) }, screenshot = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP))
        }
        "diagnostics" -> Outcome("done", Diagnostics.collect(context, manifests.load()?.version, File(context.filesDir, "assets"), serverSkewMs))
        else -> Outcome("failed", buildJsonObject { put("error", "unsupported command $type — update the player app") })
    } }

    private fun show(manifest: Manifest) {
        val files = manifest.assets
            .filter { cache.has(it) }
            .associate { a: Asset -> a.mediaId to (cache.fileFor(a) to a.mimeType) }
        _ui.value = UiState.Playing(manifest, MediaLibrary(files))
    }

    /** Server time as best known (device clock corrected by the skew seen on /me). */
    fun serverNow(): Long = System.currentTimeMillis() - (serverSkewMs ?: 0L)

    /**
     * Polls live sensor values while the playing manifest binds sensor channels; chart
     * history is refreshed less often (and on any change of the bound channels).
     */
    private suspend fun liveLoop() {
        delay(2_000)
        var lastHistoryAt = 0L
        var lastKeys = emptyList<String>()
        while (currentCoroutineContextActive()) {
            val channels = (_ui.value as? UiState.Playing)?.manifest?.liveChannels.orEmpty()
            val auth = device.auth
            if (channels.isNotEmpty() && auth != null) {
                val keys = channels.map { it.key }
                if (keys != lastKeys) {
                    live.retain(channels)
                    lastKeys = keys
                    lastHistoryAt = 0L
                }
                try {
                    live.applyLive(api.live(auth), channels)
                    val now = System.currentTimeMillis()
                    if (channels.any { it.historyMinutes != null } && now - lastHistoryAt >= LiveStore.HISTORY_POLL_SEC * 1000) {
                        live.applyHistory(api.liveHistory(auth))
                        lastHistoryAt = now
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Keep showing the last values; widgets turn them stale over time.
                    Log.w(TAG, "Live data failed: ${e.message}")
                }
            }
            delay(LiveStore.LIVE_POLL_SEC * 1000)
        }
    }

    /** Refreshes weather / RSS values while the playing manifest uses data sources. */
    private suspend fun dataLoop() {
        delay(3_000)
        var lastIds = emptySet<String>()
        while (currentCoroutineContextActive()) {
            val ids = (_ui.value as? UiState.Playing)?.manifest?.dataSources.orEmpty().map { it.id }.toSet()
            val auth = device.auth
            var wait = DataStore.POLL_SEC * 1000
            if (ids.isNotEmpty() && auth != null) {
                if (ids != lastIds) data.retain(ids)
                try {
                    data.apply(api.data(auth))
                    lastIds = ids
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "Data sources failed: ${e.message}")
                    wait = 60_000 // retry sooner after a failure
                }
            } else if (ids.isEmpty()) {
                lastIds = emptySet()
                wait = 15_000 // pick up a new manifest with data sources quickly
            }
            delay(wait)
        }
    }

    private suspend fun heartbeatLoop() {
        delay(5_000)
        while (currentCoroutineContextActive()) {
            device.auth?.let { auth ->
                try {
                    api.heartbeat(
                        auth,
                        Heartbeat(
                            appVersion = BuildConfig.VERSION_NAME,
                            display = displaySize(),
                            storageFreeMb = runCatching { StatFs(context.filesDir.path).availableBytes / (1024 * 1024) }.getOrNull(),
                            playing = nowPlaying,
                            manifestVersion = manifests.load()?.version,
                            errors = ErrorLog.recent(context),
                        ),
                    )
                    ErrorLog.clear(context)
                } catch (e: Exception) {
                    Log.w(TAG, "Heartbeat failed: ${e.message}")
                }
            }
            delay(heartbeatSec * 1000L)
        }
    }

    private fun resetIdentity(reason: String) {
        Log.w(TAG, "Resetting device identity: $reason")
        ErrorLog.record(context, "reset: $reason")
        device.clear()
        manifests.clear()
        cache.clear()
        _ui.value = UiState.Starting
    }

    private fun fail(message: String) {
        Log.w(TAG, message)
        _status.value = _status.value.copy(lastError = message)
        ErrorLog.record(context, message)
    }

    private fun hardware() = DeviceHardware(
        manufacturer = Build.MANUFACTURER.take(80),
        model = Build.MODEL.take(80),
        androidVersion = Build.VERSION.RELEASE.take(20),
        sdkInt = Build.VERSION.SDK_INT,
        appVersion = BuildConfig.VERSION_NAME,
        display = displaySize(),
    )

    @SuppressLint("NewApi")
    @Suppress("DEPRECATION")
    private fun displaySize(): Size {
        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(metrics)
        return Size(metrics.widthPixels.coerceAtLeast(1), metrics.heightPixels.coerceAtLeast(1))
    }

    companion object {
        @Volatile private var instance: PlayerEngine? = null
        fun get(context: Context): PlayerEngine =
            instance ?: synchronized(this) { instance ?: PlayerEngine(context.applicationContext).also { instance = it } }
    }
}
