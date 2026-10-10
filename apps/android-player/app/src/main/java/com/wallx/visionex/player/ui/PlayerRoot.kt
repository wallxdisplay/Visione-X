package com.wallx.visionex.player.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wallx.visionex.player.R
import com.wallx.visionex.player.core.PlayerEngine
import com.wallx.visionex.player.core.Schedule
import com.wallx.visionex.player.core.UiState
import com.wallx.visionex.player.data.Playing
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

private val Indigo = Color(0xFF4F46E5)
private val Orange = Color(0xFFD77836)
private val Ink = Color(0xFF0B1020)

@Composable
fun PlayerRoot(engine: PlayerEngine) {
    val ui by engine.ui.collectAsState()
    val status by engine.status.collectAsState()
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when (val s = ui) {
            UiState.Starting -> Message(stringResource(R.string.starting), null)
            is UiState.Pairing -> PairingScreen(s)
            is UiState.Waiting -> Message(
                stringResource(R.string.waiting_title),
                stringResource(R.string.waiting_body, s.orgName, s.screenName),
            )
            is UiState.NoContent -> Message(
                stringResource(R.string.no_content_title),
                stringResource(R.string.no_content_body, s.orgName, s.screenName),
            )
            is UiState.Playing -> Playback(s, engine)
        }
        // Small, unobtrusive status line (bottom-left) only when something needs attention.
        val note = when {
            status.syncProgress != null -> stringResource(R.string.syncing, status.syncProgress ?: 0)
            !status.online && ui is UiState.Playing -> stringResource(R.string.offline_note)
            !status.online -> stringResource(R.string.cannot_connect)
            else -> null
        }
        if (note != null) {
            Text(
                note,
                color = Color.White.copy(alpha = 0.75f),
                fontSize = 12.sp,
                modifier = Modifier.align(Alignment.BottomStart).padding(10.dp)
                    .background(Color.Black.copy(alpha = 0.5f), RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/** Resolves the schedule every 15 s and plays the winning playlist. */
@Composable
private fun Playback(state: UiState.Playing, engine: PlayerEngine) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(15_000)
            now = System.currentTimeMillis()
        }
    }
    val m = state.manifest
    val resolution = Schedule.resolvePlaylist(m.schedules, m.defaultPlaylistId, m.emergency, now)
    val ctx = remember(m, state.library) { RenderContext(m, state.library) }
    val playlist = resolution.playlistId?.let { ctx.playlists[it] }
    if (playlist == null) {
        engine.nowPlaying = Playing(null, null, resolution.source)
        Box(Modifier.fillMaxSize().background(Color.Black))
        return
    }
    PlaylistPlayer(playlist.items, ctx) { item ->
        engine.nowPlaying = Playing(playlist.id, item?.id, resolution.source)
    }
}

@Composable
private fun Brand() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)).background(Indigo), contentAlignment = Alignment.Center) {
            Text("X", color = Orange, fontSize = 26.sp, fontWeight = FontWeight.ExtraBold)
        }
        Spacer(Modifier.size(14.dp))
        Text("Visione-X", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Message(title: String, body: String?) {
    Column(
        Modifier.fillMaxSize().background(Ink).padding(48.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Brand()
        Spacer(Modifier.height(32.dp))
        Text(title, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.SemiBold)
        if (body != null) {
            Spacer(Modifier.height(12.dp))
            Text(body, color = Color(0xFFCBD5E1), fontSize = 18.sp)
        }
    }
}

@Composable
private fun PairingScreen(s: UiState.Pairing) {
    val qr = remember(s.url) { s.url?.let { qrBitmap(it) } }
    Row(
        Modifier.fillMaxSize().background(Ink).padding(56.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        Column(Modifier.weight(1f)) {
            Brand()
            Spacer(Modifier.height(36.dp))
            Text(stringResource(R.string.pair_title), color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(16.dp))
            Text("1. " + stringResource(R.string.pair_step1), color = Color(0xFFCBD5E1), fontSize = 18.sp)
            Text("2. " + stringResource(R.string.pair_step2), color = Color(0xFFCBD5E1), fontSize = 18.sp)
            Spacer(Modifier.height(28.dp))
            Text(
                s.code.chunked(3).joinToString(" "),
                color = Color.White,
                fontSize = 72.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 6.sp,
            )
            s.expiresAt?.let {
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.pair_expires, DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it))),
                    color = Color(0xFF94A3B8),
                    fontSize = 14.sp,
                )
            }
        }
        if (qr != null) {
            Box(Modifier.size(280.dp).clip(RoundedCornerShape(12.dp)).background(Color.White).padding(14.dp)) {
                Image(qr.asImageBitmap(), null, Modifier.fillMaxSize(), filterQuality = FilterQuality.None)
            }
        }
    }
}
