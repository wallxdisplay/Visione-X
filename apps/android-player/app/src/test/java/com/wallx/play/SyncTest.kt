package com.wallx.play

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import com.wallx.play.core.ClockSync
import com.wallx.play.core.DriftFix
import com.wallx.play.core.MediaLibrary
import com.wallx.play.core.SyncTimeline
import com.wallx.play.core.TimelinePosition
import com.wallx.play.core.VideoDrift
import com.wallx.play.data.Manifest
import com.wallx.play.data.PlaylistItem
import com.wallx.play.data.WallTile
import com.wallx.play.data.json
import com.wallx.play.ui.LocalSyncClock
import com.wallx.play.ui.PlaylistPlayer
import com.wallx.play.ui.RenderContext
import com.wallx.play.ui.SyncClock
import com.wallx.play.ui.WallTileView
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Multi-screen sync: shared timeline, server clock, video drift, synced playlists and wall tiles. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SyncTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun timelineIsTheSameForEveryScreenAndRepeats() {
        val d = listOf(8_000L, 12_000L) // 20 s cycle
        val anchor = 1_000_000L
        assertEquals(TimelinePosition(0, anchor, anchor + 8_000), SyncTimeline.position(d, anchor, anchor))
        assertEquals(TimelinePosition(1, anchor + 8_000, anchor + 20_000), SyncTimeline.position(d, anchor, anchor + 8_000))
        assertEquals(TimelinePosition(0, anchor + 40_000, anchor + 48_000), SyncTimeline.position(d, anchor, anchor + 47_999))
        // Before the anchor (a clock slightly behind) still lands on the right item.
        assertEquals(TimelinePosition(1, anchor - 12_000, anchor), SyncTimeline.position(d, anchor, anchor - 1))
        assertEquals(0, SyncTimeline.position(emptyList(), anchor, anchor).index)
    }

    @Test
    fun clockKeepsTheFastestRoundTrip() {
        val c = ClockSync()
        assertNull(c.offsetMs)
        c.add(sentAt = 1_000, receivedAt = 1_400, serverTime = 50_000) // rtt 400 → offset 48 800
        c.add(sentAt = 2_000, receivedAt = 2_040, serverTime = 51_030) // rtt 40 → offset 49 010
        c.add(sentAt = 3_000, receivedAt = 3_300, serverTime = 52_500)
        assertEquals(49_010L, c.offsetMs)
        assertEquals(20L, c.accuracyMs)
    }

    @Test
    fun videoDriftIsCorrectedGentlyOrByAJump() {
        assertEquals(30L, VideoDrift.drift(positionMs = 1_030, expectedMs = 1_000, durationMs = 10_000))
        // Across the loop point: 50 ms behind, not 9 950 ms ahead.
        assertEquals(-50L, VideoDrift.drift(positionMs = 9_960, expectedMs = 10, durationMs = 10_000))
        assertEquals(DriftFix.None, VideoDrift.fix(30))
        assertEquals(DriftFix.Speed(0.95f), VideoDrift.fix(120))
        assertEquals(DriftFix.Speed(1.05f), VideoDrift.fix(-120))
        assertEquals(DriftFix.Seek, VideoDrift.fix(800))
    }

    private fun text(id: String, text: String, seconds: Int) =
        PlaylistItem(id, json.decodeFromString<JsonObject>("""{"kind":"widget","widget":{"type":"text","text":"$text","style":{}}}"""), seconds)

    @Test
    fun syncedPlaylistsShowTheSameItemWhenEverTheyStarted() {
        val manifest = Manifest(1, "o", "s", 1, 0, emptyList(), emptyList(), emptyList(), assets = emptyList())
        val ctx = RenderContext(manifest, MediaLibrary(emptyMap()))
        val items = listOf(text("a", "Sale", 8), text("b", "New in", 12))
        val anchor = 1_000_000L
        // 9 s into the cycle: the second item, on both "screens".
        val clock = SyncClock(anchor) { anchor + 9_000 }
        compose.setContent {
            CompositionLocalProvider(LocalSyncClock provides clock) {
                Row {
                    Box(Modifier.size(200.dp)) { PlaylistPlayer(items, ctx) }
                    Box(Modifier.size(200.dp)) { PlaylistPlayer(items, ctx) }
                }
            }
        }
        compose.onAllNodesWithText("New in").assertCountEquals(2)
        compose.onAllNodesWithText("Sale").assertCountEquals(0)
    }

    @Test
    fun wallTileShowsItsPartOfTheCanvas() {
        compose.setContent {
            Box(Modifier.size(300.dp, 200.dp)) {
                WallTileView(WallTile(rows = 2, cols = 3, row = 1, col = 2)) {
                    Box(Modifier.fillMaxSize().testTag("canvas"))
                }
            }
        }
        val bounds = compose.onNodeWithTag("canvas", useUnmergedTree = true).getUnclippedBoundsInRoot()
        // The canvas is 3 × 2 screens; this screen (column 2, row 1) sees its bottom-right cell.
        assertEquals(900f, (bounds.right - bounds.left).value, 0.5f)
        assertEquals(400f, (bounds.bottom - bounds.top).value, 0.5f)
        assertEquals(-600f, bounds.left.value, 0.5f)
        assertEquals(-200f, bounds.top.value, 0.5f)
    }
}
