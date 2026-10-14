package com.wallx.play

import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import com.wallx.play.core.PlayerEngine
import com.wallx.play.core.UiState
import com.wallx.play.ui.PlayerRoot
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.MessageDigest

/**
 * Drives the real PlayerEngine against a fake WallX Play server: registration, pairing, waiting
 * for authorization, downloading and verifying a manifest's media, refusing a corrupted update,
 * and resetting when the screen is removed. Also renders the real pairing screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PlayerEngineTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var server: MockWebServer
    private val context: Context = ApplicationProvider.getApplicationContext()

    private var status = "unpaired"
    private var manifestVersion = 0
    private var manifest = ""
    private val files = mutableMapOf<String, ByteArray>()
    private var authHeaders = mutableListOf<String?>()
    private val queued = mutableListOf<String>()
    private val results = mutableListOf<String>()
    private var playsCode = 200
    private val playUploads = mutableListOf<String>()

    private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3, 4, 5, 6, 7, 8)
    private val video = ByteArray(200_000) { (it % 251).toByte() }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                if (path.startsWith("/api/v1/devices")) authHeaders.add(request.getHeader("Authorization"))
                return when {
                    path == "/api/v1/devices/register" -> json(201, """{"deviceId":"dev12345678","deviceSecret":"${"s".repeat(43)}","pairingCode":"ABC234","pairingExpiresAt":1,"pairingUrl":"https://x/screens?pair=ABC234"}""")
                    path == "/api/v1/devices/me" && status == "revoked" -> json(403, """{"error":"revoked"}""")
                    path == "/api/v1/devices/me" -> json(
                        200,
                        """{"deviceId":"dev12345678","status":"$status",
                           "pairingCode":${if (status == "unpaired") "\"ABC234\"" else "null"},
                           "pairingUrl":"https://x/screens?pair=ABC234","orgName":"Acme",
                           "screen":${if (status == "unpaired") "null" else """{"id":"s1","name":"Lobby wall","orientation":"landscape","resolution":{"width":1920,"height":1080},"manifestVersion":$manifestVersion}"""},
                           "commandsPending":${queued.size},
                           "config":{"pollSec":60,"heartbeatSec":300},"serverTime":0}""",
                    )
                    path == "/api/v1/devices/manifest" -> json(200, manifest)
                    path == "/api/v1/devices/heartbeat" -> json(200, """{"ok":true}""")
                    path == "/api/v1/devices/plays" -> json(playsCode, """{"ok":true,"stored":true}""").also { playUploads.add(request.body.readUtf8()) }
                    path == "/api/v1/devices/commands" -> json(200, """{"commands":[${queued.joinToString(",") { """{"id":"c-$it","type":"$it"}""" }}]}""").also { queued.clear() }
                    path == "/api/v1/devices/commands/result" -> json(200, """{"ok":true}""").also { results.add(request.body.readUtf8()) }
                    path.startsWith("/files/") -> files[path.removePrefix("/files/")]?.let {
                        MockResponse().setResponseCode(200).setBody(Buffer().write(it))
                    } ?: MockResponse().setResponseCode(404)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun tearDown() = server.shutdown()

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun manifestJson(version: Int, videoSha: String) = """
        {"specVersion":1,"orgId":"o","screenId":"s1","version":$version,"generatedAt":0,
         "layouts":[],"schedules":[],"defaultPlaylistId":"p1","fallbackMediaId":null,"emergency":null,
         "playlists":[{"id":"p1","items":[
            {"id":"i1","content":{"kind":"media","mediaId":"m1"},"durationSec":10,"transition":"fade"},
            {"id":"i2","content":{"kind":"media","mediaId":"m2"},"durationSec":5,"transition":"none"}]}],
         "assets":[
            {"mediaId":"m1","url":"${server.url("/files/m1")}","sha256":"${sha(png)}","bytes":${png.size},"mimeType":"image/png"},
            {"mediaId":"m2","url":"${server.url("/files/m2")}","sha256":"$videoSha","bytes":${video.size},"mimeType":"video/mp4"}]}
    """.trimIndent()

    private fun engine() = PlayerEngine(context, server.url("/api/v1").toString().trimEnd('/'))

    @Test
    fun uploadsFinishedPlayHoursOnceAndRetriesWithTheSameBatch() = runBlocking {
        val hour = 3_600_000L
        var clock = 1_790_000_000_000L - Math.floorMod(1_790_000_000_000L, hour) + 10 * 60_000L
        val engine = PlayerEngine(context, server.url("/api/v1").toString().trimEnd('/'), playClock = { clock })
        engine.tick() // registers the box
        engine.plays.end(engine.plays.start("media", "m1"))
        engine.uploadPlays()
        assertTrue("the hour is not finished yet", playUploads.isEmpty())

        clock += hour
        playsCode = 500
        engine.uploadPlays()
        playsCode = 200
        engine.uploadPlays()
        engine.uploadPlays()
        assertEquals(2, playUploads.size)
        val ids = playUploads.map { Regex("\"batchId\":\"([A-Za-z0-9]+)\"").find(it)!!.groupValues[1] }
        assertEquals("the retry carries the same batch id", ids[0], ids[1])
        assertTrue(playUploads[1].contains("\"id\":\"m1\"") && playUploads[1].contains("\"plays\":1"))
    }

    @Test
    fun pairingThenAuthorizationThenVerifiedPlayback() = runBlocking {
        val engine = engine()

        engine.tick()
        assertEquals(UiState.Pairing("ABC234", "https://x/screens?pair=ABC234", null), engine.ui.value)
        assertTrue("second call authenticates", authHeaders.last()?.startsWith("Device dev12345678:") == true)

        status = "pending_authorization"
        engine.tick()
        assertEquals(UiState.Waiting("Acme", "Lobby wall"), engine.ui.value)

        status = "authorized"
        engine.tick()
        assertEquals(UiState.NoContent("Acme", "Lobby wall"), engine.ui.value)

        files["m1"] = png
        files["m2"] = video
        manifest = manifestJson(1, sha(video))
        manifestVersion = 1
        engine.tick()
        val playing = engine.ui.value as UiState.Playing
        assertEquals(1, playing.manifest.version)
        assertTrue(playing.library.file("m1")!!.readBytes().contentEquals(png))
        assertTrue(playing.library.file("m2")!!.readBytes().contentEquals(video))
        assertEquals("video/mp4", playing.library.mimeType("m2"))

        // A corrupted update (checksum mismatch) is refused; the verified version keeps playing.
        manifest = manifestJson(2, "f".repeat(64))
        manifestVersion = 2
        engine.tick()
        assertEquals(1, (engine.ui.value as UiState.Playing).manifest.version)
        assertTrue(ErrorLog.recent(context).any { "Checksum mismatch" in it })
    }

    @Test
    fun runsRemoteCommandsAndReportsResults() = runBlocking {
        val engine = engine()
        var restarted = 0
        engine.restarter = { restarted++ }
        engine.screenshotter = { byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 1, 2) }
        status = "authorized"
        files["m1"] = png
        files["m2"] = video
        manifest = manifestJson(1, sha(video))
        manifestVersion = 1
        engine.tick()

        queued += listOf("screenshot", "diagnostics", "restart_app", "reboot", "self_destruct")
        engine.tick()

        assertEquals(5, results.size)
        val byId = results.associateBy { Regex("\"id\":\"c-([a-z_]+)\"").find(it)!!.groupValues[1] }
        assertTrue(byId["screenshot"]!!.contains("\"status\":\"done\"") && byId["screenshot"]!!.contains("\"screenshotJpegBase64\":\"/9j/AQI=\""))
        assertTrue(byId["diagnostics"]!!.contains("\"manifestVersion\":1") && byId["diagnostics"]!!.contains("\"decoders\""))
        assertTrue(byId["reboot"]!!.contains("not device owner")) // falls back to a player restart
        assertTrue(byId["self_destruct"]!!.contains("\"status\":\"failed\""))
        assertEquals(2, restarted) // restart_app + reboot fallback, each after reporting
    }

    @Test
    fun removedScreenResetsIdentity() = runBlocking {
        val engine = engine()
        engine.tick()
        status = "revoked"
        val continueImmediately = engine.tick()
        assertEquals(false, continueImmediately)
        assertEquals(UiState.Starting, engine.ui.value)
        assertNull(context.getSharedPreferences("device", Context.MODE_PRIVATE).getString("deviceId", null))
    }

    @Test
    fun pairingScreenShowsCode() {
        val engine = engine()
        runBlocking { engine.tick() }
        compose.setContent { PlayerRoot(engine) }
        compose.onNodeWithText("ABC 234").assertExists()
        compose.onNodeWithText("Pair this screen").assertExists()
    }
}
