package com.wallx.play

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import com.wallx.play.core.MediaLibrary
import com.wallx.play.core.TouchState
import com.wallx.play.data.Canvas
import com.wallx.play.data.Layout
import com.wallx.play.data.Manifest
import com.wallx.play.data.TouchInfo
import com.wallx.play.data.Zone
import com.wallx.play.data.ZoneAction
import com.wallx.play.data.json
import com.wallx.play.ui.LayoutView
import com.wallx.play.ui.LocalTouchNav
import com.wallx.play.ui.RenderContext
import com.wallx.play.ui.TouchNav
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Touch screens: visits, page history, idle timeout, tappable zones and buttons. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TouchTest {
    @get:Rule val compose = createComposeRule()

    private val attract = TouchInfo("home", idleSec = 30, attract = true)
    private val kiosk = TouchInfo("home", idleSec = 30, attract = false)

    @Test
    fun aVisitStartsOnHomeAndFollowsTaps() {
        var s = TouchState()
        assertNull(s.page(attract)) // attract loop: the schedule plays
        assertEquals("home", s.page(kiosk)) // no attract loop: home stays up
        assertNull(s.endsAt(attract))

        s = s.touched(attract, 1_000)
        assertEquals("home", s.page(attract))
        s = s.act(attract, ZoneAction("page", "menu"), 2_000)
        s = s.act(attract, ZoneAction("page", "menu"), 2_500) // same page twice: no duplicate history
        s = s.act(attract, ZoneAction("page", "drinks"), 3_000)
        assertEquals(listOf("home", "menu", "drinks"), s.pages)
        s = s.act(attract, ZoneAction("back"), 4_000)
        assertEquals("menu", s.page(attract))
        s = s.act(attract, ZoneAction("home"), 5_000)
        assertEquals(listOf("home"), s.pages)
        s = s.act(attract, ZoneAction("back"), 6_000) // back on home stays home
        assertEquals("home", s.page(attract))
    }

    @Test
    fun idleEndsTheVisit() {
        var s = TouchState().touched(attract, 1_000).act(attract, ZoneAction("page", "menu"), 10_000)
        assertEquals(40_000L, s.endsAt(attract)) // idleSec after the last touch
        s = s.touched(attract, 20_000)
        assertEquals(50_000L, s.endsAt(attract))
        s = s.ended()
        assertFalse(s.visiting)
        assertNull(s.page(attract))
        assertEquals("home", s.page(kiosk))
        // History is capped.
        var long = TouchState().touched(kiosk, 0)
        repeat(30) { long = long.act(kiosk, ZoneAction("page", "p$it"), 0) }
        assertEquals(TouchState.MAX_HISTORY, long.pages.size)
        assertEquals("p29", long.page(kiosk))
    }

    private fun zone(id: String, widget: String, action: ZoneAction?) =
        Zone(id, id, 0.0, if (id == "a") 0.0 else 0.5, 1.0, 0.5, 0, json.decodeFromString<JsonObject>("""{"kind":"widget","widget":$widget}"""), action)

    @Test
    fun zonesWithActionsAreTappableOnlyDuringAVisit() {
        val layout = Layout(
            1, "home", "Home", Canvas(1080, 1920, "portrait"),
            listOf(
                zone("a", """{"type":"button","label":"Menu","style":{}}""", ZoneAction("page", "menu")),
                zone("b", """{"type":"text","text":"Welcome","style":{}}""", null),
            ),
        )
        val ctx = RenderContext(Manifest(1, "o", "s", 1, 0, listOf(layout), emptyList(), emptyList(), assets = emptyList()), MediaLibrary(emptyMap()))
        val taps = mutableListOf<Pair<ZoneAction, String>>()
        compose.setContent {
            CompositionLocalProvider(LocalTouchNav provides TouchNav { a, page -> taps += a to page }) {
                Box(Modifier.size(270.dp, 480.dp)) { LayoutView(layout, ctx) }
            }
        }
        compose.onNodeWithText("Menu").performClick()
        compose.onNodeWithText("Welcome").performClick() // no action: nothing happens
        assertEquals(listOf(ZoneAction("page", "menu") to "home"), taps)
    }

    @Test
    fun withoutAVisitZonesAreNotTappable() {
        val layout = Layout(1, "home", "Home", Canvas(1080, 1920, "portrait"), listOf(zone("a", """{"type":"button","label":"Menu","style":{}}""", ZoneAction("home"))))
        val ctx = RenderContext(Manifest(1, "o", "s", 1, 0, listOf(layout), emptyList(), emptyList(), assets = emptyList()), MediaLibrary(emptyMap()))
        compose.setContent { Box(Modifier.size(270.dp, 480.dp)) { LayoutView(layout, ctx) } }
        val node = compose.onNodeWithText("Menu", useUnmergedTree = true).fetchSemanticsNode()
        var p = node.parent
        var clickable = false
        while (p != null) {
            if (p.config.contains(androidx.compose.ui.semantics.SemanticsActions.OnClick)) clickable = true
            p = p.parent
        }
        assertTrue(!clickable)
    }
}
