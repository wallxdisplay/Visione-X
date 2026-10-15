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
import com.wallx.play.data.BrandStore
import com.wallx.play.data.BrandInfo
import com.wallx.play.data.MqttReadingsBody
import com.wallx.play.data.DeviceStore
import com.wallx.play.data.Heartbeat
import com.wallx.play.data.Manifest
import com.wallx.play.data.ManifestStore
import com.wallx.play.data.Playing
import com.wallx.play.data.SUPPORTED_SPEC_VERSION
import com.wallx.play.data.Size
import com.wallx.play.data.json
import com.wallx.play.data.CommandResult
import com.wallx.play.data.PlayUpload
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
    /** Clock for proof-of-play hours (tests move it; a real player uses server-corrected time). */
    playClock: (() -> Long)? = null,
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

    /** In-app updates offered by the server. */
    val updater = Updater(context, api.http)

    /** Proof-of-play counts (the renderer reports what it shows; uploaded hourly). */
    val plays = PlayLog(File(context.filesDir, "plays.json"), playClock ?: ::serverNow)

    /** MQTT bridge (0.18.0): connects to the brokers this screen bridges and forwards readings. */
    internal var mqttTransport: () -> MqttTransport = { PahoTransport() }
    val mqtt = MqttBridge({ mqttTransport() }, ::serverNow) { key, value, ts -> live.applyLocal(key, value, ts) }
    @Volatile private var mqttConfigAt: Long? = null
    @Volatile private var mqttFetchedAt = 0L

    /** White label (0.19.0): the brand shown on the player's own screens; null = WallX Play. */
    private val brandStore = BrandStore(context)
    private val _brand = MutableStateFlow(brandStore.load())
    val brand: StateFlow<BrandInfo?> = _brand.asStateFlow()

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
    private var scope: CoroutineScope? = null

    fun start(scope: CoroutineScope) {
        if (loop?.isActive == true) return
        this.scope = scope
        // Show saved content immediately — before any network call.
        manifests.load()?.let { show(it) }
        loop = scope.launch { pollLoop() }
        scope.launch { heartbeatLoop() }
        scope.launch { liveLoop() }
        scope.launch { dataLoop() }
        scope.launch { playsLoop() }
        scope.launch { uptimeLoop() }
        scope.launch { clockLoop() }
        scope.launch { mqttLoop() }
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
                // Downloads run beside playback; the next poll sees the progress.
                scope?.launch { updater.offer(state.update) }
                if (state.brandAt != _brand.value?.updatedAt) refreshBrand(state.brandAt)
                if (state.mqttConfigAt != mqttConfigAt) {
                    mqttConfigAt = state.mqttConfigAt
                    refreshMqtt()
                }
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
        "install_update" ->
            if (updater.showPrompt()) Outcome("done", buildJsonObject { put("versionCode", updater.status.value?.versionCode ?: 0) })
            else Outcome("failed", buildJsonObject { put("error", "no player update downloaded") })
        else -> Outcome("failed", buildJsonObject { put("error", "unsupported command $type — update the player app") })
    } }

    private fun show(manifest: Manifest) {
        val files = manifest.assets
            .filter { cache.has(it) }
            .associate { a: Asset -> a.mediaId to (cache.fileFor(a) to a.mimeType) }
        _ui.value = UiState.Playing(manifest, MediaLibrary(files))
    }

    /** Precise server clock, measured while the content plays in a sync group. */
    val clockSync = ClockSync()

    /**
     * Server time as best known: from the sync clock when measured (monotonic, tens of ms), else the
     * device clock corrected by the skew seen on /me.
     */
    fun serverNow(): Long =
        clockSync.offsetMs?.let { android.os.SystemClock.elapsedRealtime() + it } ?: (System.currentTimeMillis() - (serverSkewMs ?: 0L))

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
            delay(live.pollSec * 1000)
        }
    }

    /** Refreshes weather / RSS values while the playing manifest uses data sources. */
    private suspend fun dataLoop() {
        delay(3_000)
        var lastIds = emptySet<String>()
        var nextAt = 0L
        while (currentCoroutineContextActive()) {
            val ids = (_ui.value as? UiState.Playing)?.manifest?.dataSources.orEmpty().map { it.id }.toSet()
            val auth = device.auth
            val now = android.os.SystemClock.elapsedRealtime()
            if (ids.isEmpty()) {
                lastIds = emptySet()
            } else if (auth != null && dataFetchDue(ids, lastIds, now, nextAt)) {
                if (ids != lastIds) data.retain(ids)
                lastIds = ids
                nextAt = try {
                    data.apply(api.data(auth))
                    now + DataStore.POLL_SEC * 1000
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "Data sources failed: ${e.message}")
                    now + 60_000 // retry sooner after a failure
                }
            }
            // Short ticks: newly published widgets get their weather / RSS within seconds.
            delay(DATA_CHECK_MS)
        }
    }

    /**
     * Saves proof-of-play counts every few minutes and uploads finished hours. Counts stay on
     * the box while offline and go up when the network is back.
     */
    private suspend fun playsLoop() {
        delay(60_000)
        while (currentCoroutineContextActive()) {
            uploadPlays()
            delay(PLAYS_SEC * 1000L)
        }
    }

    internal suspend fun uploadPlays() {
        plays.checkpoint()
        plays.save()
        val auth = device.auth ?: return
        // Send everything finished; a few batches per round when a box was offline for long.
        repeat(5) {
            val batch = plays.nextBatch() ?: return
            try {
                api.plays(auth, PlayUpload(batch.id, batch.buckets, batch.uptime))
                plays.acknowledge(batch.id)
            } catch (e: ApiException) {
                // A refused batch (malformed, or the box is no longer a screen) would never pass.
                if (e.status in 400..499 && e.status != 429) plays.acknowledge(batch.id)
                Log.w(TAG, "Play upload refused: ${e.message}")
                return
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Play upload failed: ${e.message}")
                return
            }
        }
    }

/** While the content plays in a sync group: measure the server clock now and every 10 minutes. */
    private suspend fun clockLoop() {
        while (currentCoroutineContextActive()) {
            val synced = (_ui.value as? UiState.Playing)?.manifest?.sync != null
            if (synced) measureClock()
            delay(if (synced && clockSync.offsetMs != null) CLOCK_RESYNC_MS else 15_000L)
        }
    }

    /** A few quick round trips; ClockSync keeps the most accurate. */
    internal suspend fun measureClock(samples: Int = 5) {
        repeat(samples) {
            try {
                val sentAt = android.os.SystemClock.elapsedRealtime()
                val serverTime = api.time().serverTime
                clockSync.add(sentAt, android.os.SystemClock.elapsedRealtime(), serverTime)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Clock sample failed: ${e.message}")
            }
            delay(200)
        }
    }

    /** Every minute: the player is running, and online if its last server contact worked. */
    private suspend fun uptimeLoop() {
        while (currentCoroutineContextActive()) {
            delay(60_000)
            plays.addUptime(60, _status.value.online)
        }
    }

    /** Fetches the brand after it changed (null brandAt: back to WallX Play). */
    private suspend fun refreshBrand(brandAt: Long?) {
        val next = if (brandAt == null) {
            null
        } else {
            val auth = device.auth ?: return
            try {
                api.brand(auth).brand
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "Brand failed: ${e.message}")
                return // keep the current one; retried on the next poll
            }
        }
        brandStore.save(next)
        _brand.value = next
    }

    /** Fetches the bridge configuration (or stops bridging when this screen is not a bridge). */
    internal suspend fun refreshMqtt() {
        val auth = device.auth ?: return
        if (mqttConfigAt == null) {
            mqtt.stop()
            return
        }
        try {
            mqtt.apply(api.mqtt(auth).brokers)
            mqttFetchedAt = System.currentTimeMillis()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "MQTT configuration failed: ${e.message}")
            mqttConfigAt = null // try again on the next poll
        }
    }

    /** Uploads the latest MQTT values every MQTT_FLUSH_SEC and keeps the connections up. */
    private suspend fun mqttLoop() {
        while (currentCoroutineContextActive()) {
            delay(MQTT_FLUSH_SEC * 1000)
            if (!mqtt.active) continue
            mqtt.maintain()
            if (System.currentTimeMillis() - mqttFetchedAt > MQTT_CONFIG_REFRESH_SEC * 1000) refreshMqtt()
            flushMqtt()
        }
    }

    internal suspend fun flushMqtt() {
        val auth = device.auth ?: return
        val batches = mqtt.buffer.drain()
        if (batches.isEmpty()) return
        try {
            val res = api.mqttReadings(auth, MqttReadingsBody(batches))
            // Rate-limited devices try again with their (then newer) values next time.
            val retry = res.results.filter { it.status == 429 }.map { it.sensorDeviceId }.toSet()
            if (retry.isNotEmpty()) mqtt.buffer.restore(batches.filter { it.sensorDeviceId in retry })
            res.results.filter { it.error != null && it.status != 429 }.forEach { Log.w(TAG, "MQTT readings for ${it.sensorDeviceId}: ${it.error}") }
        } catch (e: kotlinx.coroutines.CancellationException) {
            mqtt.buffer.restore(batches)
            throw e
        } catch (e: Exception) {
            mqtt.buffer.restore(batches)
            Log.w(TAG, "MQTT upload failed: ${e.message}")
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
                            update = updater.status.value,
                            vitals = runCatching { Diagnostics.vitals(context) }.getOrNull(),
                            mqtt = mqtt.status().takeIf { it.isNotEmpty() },
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
        plays.clear()
        manifests.clear()
        cache.clear()
        mqtt.stop()
        mqttConfigAt = null
        brandStore.save(null)
        _brand.value = null
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
        const val MQTT_FLUSH_SEC = 15L
        const val MQTT_CONFIG_REFRESH_SEC = 15 * 60L
        /** Proof-of-play: save counts and upload finished hours this often. */
        const val PLAYS_SEC = 300

        /** Re-measure the sync clock this often (box clocks drift a few ms per minute). */
        const val CLOCK_RESYNC_MS = 10 * 60_000L

        /** How often the data loop looks for new data sources in the playing content. */
        const val DATA_CHECK_MS = 15_000L

        /** Fetch widget data now: the content's data sources changed, or the refresh is due. */
        fun dataFetchDue(ids: Set<String>, lastIds: Set<String>, now: Long, nextAt: Long): Boolean =
            ids.isNotEmpty() && (ids != lastIds || now >= nextAt)

        @Volatile private var instance: PlayerEngine? = null
        fun get(context: Context): PlayerEngine =
            instance ?: synchronized(this) { instance ?: PlayerEngine(context.applicationContext).also { instance = it } }
    }
}
