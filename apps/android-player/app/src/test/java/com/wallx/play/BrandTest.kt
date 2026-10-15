package com.wallx.play

import android.content.Context
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import com.wallx.play.core.PlayerEngine
import com.wallx.play.ui.PlayerRoot
import com.wallx.play.ui.decodeLogo
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** White label: the player fetches its brand when it changes and shows it on its own screens. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrandTest {
    @get:Rule val compose = createComposeRule()

    private val png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

    @Test
    fun logosDecode() {
        assertNotNull(decodeLogo(png))
        assertNull(decodeLogo(null))
        assertNull(decodeLogo("https://example.com/logo.png"))
    }

    @Test
    fun brandFollowsTheServerAndShowsOnTheWaitingScreen(): Unit = runBlocking {
        var brandAt: Long? = 7L
        var brandRequests = 0
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val ok = { body: String -> MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body) }
                return when (request.path) {
                    "/api/v1/devices/register" -> ok("""{"deviceId":"dev12345678","deviceSecret":"${"s".repeat(43)}","pairingCode":"ABC234","pairingExpiresAt":1,"pairingUrl":"https://x/p"}""")
                    "/api/v1/devices/me" -> ok(
                        """{"deviceId":"dev12345678","status":"authorized","orgName":"Kothari Sweets",
                           "screen":{"id":"s1","name":"Lobby","orientation":"landscape","resolution":{"width":1920,"height":1080},"manifestVersion":0},
                           "config":{"pollSec":60,"heartbeatSec":300},"brandAt":${brandAt ?: "null"},"serverTime":0}""",
                    )
                    "/api/v1/devices/brand" -> ok("""{"brand":{"name":"Deccan Signage","logo":"$png","primaryColor":"#0E7490","updatedAt":7}}""").also { brandRequests++ }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        try {
            val context: Context = ApplicationProvider.getApplicationContext()
            val engine = PlayerEngine(context, server.url("/api/v1").toString().trimEnd('/'))
            engine.tick()
            assertEquals("Deccan Signage", engine.brand.value?.name)
            engine.tick() // unchanged: not fetched again
            assertEquals(1, brandRequests)

            // No content yet: the waiting screen shows the brand instead of WallX Play.
            compose.setContent { PlayerRoot(engine) }
            compose.onNodeWithText("Deccan Signage").assertExists()

            // Kept across restarts.
            assertEquals("Deccan Signage", PlayerEngine(context, server.url("/api/v1").toString().trimEnd('/')).brand.value?.name)

            brandAt = null
            engine.tick()
            assertNull(engine.brand.value)
            compose.onNodeWithText("WallX Play").assertExists()
        } finally {
            server.shutdown()
        }
    }
}
