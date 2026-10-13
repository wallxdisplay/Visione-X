package com.wallx.play.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer

/**
 * Rotates everything inside by [degrees] clockwise (0, 90, 180 or 270). For a quarter turn the
 * content is laid out with width and height swapped and then turned, so a portrait layout fills
 * a portrait LED wall that is driven by a landscape HDMI output.
 */
@Composable
fun Rotated(degrees: Int, content: @Composable () -> Unit) {
    val turn = ((degrees % 360) + 360) % 360
    if (turn == 0) {
        Box(Modifier.fillMaxSize()) { content() }
        return
    }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val quarter = turn == 90 || turn == 270
        val w = if (quarter) maxHeight else maxWidth
        val h = if (quarter) maxWidth else maxHeight
        Box(Modifier.requiredSize(w, h).graphicsLayer { rotationZ = turn.toFloat() }) { content() }
    }
}
