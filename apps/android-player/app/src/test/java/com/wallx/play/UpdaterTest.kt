package com.wallx.play

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.wallx.play.core.Updater
import com.wallx.play.data.PlayerUpdate
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.MessageDigest

/** In-app updates: download checks, retry after failures, and the install prompt only on request. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UpdaterTest {
    private val server = MockWebServer()
    private val apk = ByteArray(10_000) { (it % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private var clock = 1_000_000L
    private lateinit var dir: File
    private val installed = mutableListOf<File>()
    private val launched = mutableListOf<Intent>()

    @Before fun setUp() {
        server.start()
        dir = File(ApplicationProvider.getApplicationContext<android.content.Context>().cacheDir, "updates-test").apply { deleteRecursively() }
    }

    @After fun tearDown() = server.shutdown()

    private fun updater(verify: (File, Int) -> String? = { _, _ -> null }) =
        Updater(ApplicationProvider.getApplicationContext(), OkHttpClient(), currentVersion = 8, dir = dir, now = { clock }).also {
            it.verifyArchive = verify
            it.installer = { f -> installed += f }
            it.launcher = { i -> launched += i }
        }

    private fun offer(versionCode: Int = 9, sha256: String = sha) =
        PlayerUpdate(versionCode, "0.$versionCode.0", server.url("/player.apk").toString(), sha256, apk.size.toLong())

    private fun serveApk() = server.enqueue(MockResponse().setBody(Buffer().write(apk)))

    @Test
    fun skipsVersionsItAlreadyHas() = runBlocking {
        val u = updater()
        u.offer(offer(versionCode = 8))
        u.offer(null)
        assertEquals(0, server.requestCount)
        assertNull(u.status.value)
    }

    @Test
    fun downloadsChecksAndInstallsOnce() = runBlocking {
        serveApk()
        val u = updater()
        u.offer(offer())
        assertEquals(1, installed.size)
        assertTrue(installed[0].readBytes().contentEquals(apk))
        assertEquals("installing", u.status.value?.state)
        // While installing, later polls do nothing.
        u.offer(offer())
        assertEquals(1, server.requestCount)
        assertEquals(1, installed.size)
    }

    @Test
    fun checksumMismatchFailsAndRetriesHoursLater() = runBlocking {
        serveApk()
        val u = updater()
        u.offer(offer(sha256 = "00".repeat(32)))
        assertEquals("failed", u.status.value?.state)
        assertTrue(installed.isEmpty())
        assertFalse(File(dir, "player-9.apk").exists())

        u.offer(offer()) // within the retry window: no new download
        assertEquals(1, server.requestCount)
        clock += Updater.RETRY_AFTER_MS + 1
        serveApk()
        u.offer(offer())
        assertEquals(1, installed.size)
    }

    @Test
    fun refusesAnApkThatFailsThePackageCheck() = runBlocking {
        serveApk()
        val u = updater(verify = { _, _ -> "signed with a different key" })
        u.offer(offer())
        assertEquals("failed", u.status.value?.state)
        assertEquals("signed with a different key", u.status.value?.error)
        assertTrue(installed.isEmpty())
    }

    @Test
    fun keepsTheInstallPromptUntilSomeoneAsks() = runBlocking {
        serveApk()
        val u = updater()
        u.offer(offer())
        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        u.onNeedsUser(confirm)
        assertEquals("waiting_user", u.status.value?.state)
        assertTrue(launched.isEmpty()) // never shown on its own over the signage

        assertTrue(u.showPrompt())
        assertEquals(listOf(confirm), launched)
    }

    @Test
    fun aDismissedPromptCanBeShownAgainOnRequest() = runBlocking {
        serveApk()
        val u = updater()
        u.offer(offer())
        u.onFailed(9, "install cancelled")
        // Staff send "Install player update": the downloaded APK is committed again and the prompt shown.
        assertTrue(u.showPrompt())
        assertEquals(2, installed.size)
        u.onNeedsUser(Intent("confirm"))
        assertEquals(1, launched.size)
        assertEquals(1, server.requestCount)
    }
}
