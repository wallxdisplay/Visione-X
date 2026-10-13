package com.wallx.play

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import com.wallx.play.data.Manifest
import com.wallx.play.data.json
import com.wallx.play.ui.Rotated
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Portrait walls: content is laid out with swapped dimensions before it is turned. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RotationTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun quarterTurnsSwapWidthAndHeight() {
        val degrees = listOf(0, 90, 180, 270)
        val outer = Array(4) { IntSize.Zero }
        val inner = Array(4) { IntSize.Zero }
        // One composition (a test may set content once): four 150×60 areas stacked.
        compose.setContent {
            Column {
                degrees.forEachIndexed { i, deg ->
                    Box(Modifier.size(150.dp, 60.dp).onSizeChanged { outer[i] = it }) {
                        Rotated(deg) { Box(Modifier.fillMaxSize().onSizeChanged { inner[i] = it }) }
                    }
                }
            }
        }
        compose.waitForIdle()
        degrees.forEachIndexed { i, deg ->
            val expected = if (deg % 180 == 0) outer[i] else IntSize(outer[i].height, outer[i].width)
            assertEquals("rotation $deg", expected, inner[i])
        }
    }

    @Test
    fun manifestRotationDefaultsToZero() {
        val base = """{"specVersion":1,"orgId":"o","screenId":"s","version":1,"generatedAt":0,"layouts":[],"playlists":[],"schedules":[],"assets":[]}"""
        assertEquals(0, json.decodeFromString<Manifest>(base).rotation)
        assertEquals(270, json.decodeFromString<Manifest>(base.replace("\"assets\":[]", "\"assets\":[],\"rotation\":270")).rotation)
    }
}
