package com.wallx.play.ui

import android.annotation.SuppressLint
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import coil.decode.GifDecoder
import coil.ImageLoader
import com.wallx.play.core.DataStore
import com.wallx.play.core.LiveStore
import com.wallx.play.core.MediaLibrary
import com.wallx.play.data.Layout
import com.wallx.play.data.Manifest
import com.wallx.play.data.PlaylistItem
import com.wallx.play.data.kind
import com.wallx.play.data.str
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Compose renderer for the layout spec — the native counterpart of apps/web/src/render.
 * Same rules: zone geometry in canvas fractions; font size = fontScale × zone height, and
 * single-line widgets are also capped at zone width / (0.62 × characters).
 */
class RenderContext(
    val manifest: Manifest,
    val library: MediaLibrary,
    /** Live sensor values for sensor widgets. */
    val live: LiveStore = LiveStore(),
    /** Current time (server-corrected on a real player). */
    val now: () -> Long = System::currentTimeMillis,
    /** Weather / RSS values for data widgets. */
    val data: DataStore = DataStore(),
) {
    val layouts = manifest.layouts.associateBy { it.id }
    val playlists = manifest.playlists.associateBy { it.id }
}

@Composable
fun rememberImageLoader(): ImageLoader {
    val context = LocalContext.current
    return remember { ImageLoader.Builder(context).components { add(GifDecoder.Factory()) }.build() }
}

/** Plays a playlist full-area, advancing by each item's duration; loops. */
@Composable
fun PlaylistPlayer(
    items: List<PlaylistItem>,
    ctx: RenderContext,
    modifier: Modifier = Modifier,
    onItem: (PlaylistItem?) -> Unit = {},
) {
    if (items.isEmpty()) {
        onItem(null)
        Box(modifier.fillMaxSize().background(Color.Black))
        return
    }
    var index by remember(items) { mutableIntStateOf(0) }
    val item = items[index % items.size]
    LaunchedEffect(item.id, index, items) {
        onItem(item)
        if (items.size > 1) {
            delay(item.durationSec * 1000L)
            index = (index + 1) % items.size
        }
    }
    AnimatedContent(
        targetState = index to item,
        transitionSpec = {
            when (targetState.second.transition) {
                "fade" -> fadeIn() togetherWith fadeOut()
                "slide" -> (slideInHorizontally { it / 12 } + fadeIn()) togetherWith fadeOut()
                else -> fadeIn(initialAlpha = 1f) togetherWith fadeOut(targetAlpha = 1f)
            }
        },
        modifier = modifier.fillMaxSize(),
        label = "playlist",
    ) { (_, current) ->
        val c = current.content
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            when (c.kind()) {
                "media" -> MediaView(c.str("mediaId") ?: "", "contain", ctx.library)
                "layout" -> ctx.layouts[c.str("layoutId")]?.let { LayoutView(it, ctx) }
                "widget" -> c["widget"]?.jsonObject?.let { WidgetView(it, ctx) }
            }
        }
    }
}

/** Draws a layout letterboxed to its canvas aspect ratio. */
@Composable
fun LayoutView(layout: Layout, ctx: RenderContext) {
    val bg = Color(parseColor(layout.canvas.background, android.graphics.Color.BLACK))
    BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black), contentAlignment = Alignment.Center) {
        val aspect = layout.canvas.width.toFloat() / layout.canvas.height
        val (w, h) = if (maxWidth / maxHeight > aspect) (maxHeight * aspect) to maxHeight else maxWidth to (maxWidth / aspect)
        Box(Modifier.size(w, h).background(bg).clipToBounds()) {
            for (zone in layout.zones.sortedBy { it.z }) {
                val zw = w * zone.w.toFloat()
                val zh = h * zone.h.toFloat()
                Box(
                    Modifier
                        .offset(x = w * zone.x.toFloat(), y = h * zone.y.toFloat())
                        .size(zw, zh)
                        .clipToBounds(),
                ) {
                    ZoneContent(zone.content, ctx)
                }
            }
        }
    }
}

@Composable
private fun ZoneContent(content: JsonObject, ctx: RenderContext) {
    when (content.kind()) {
        "media" -> MediaView(content.str("mediaId") ?: "", content.str("fit") ?: "cover", ctx.library)
        "widget" -> content["widget"]?.jsonObject?.let { WidgetView(it, ctx) }
        "playlist" -> ctx.playlists[content.str("playlistId")]?.let { PlaylistPlayer(it.items, ctx) }
        else -> Unit // empty zone
    }
}

@Composable
fun MediaView(mediaId: String, fit: String, library: MediaLibrary) {
    val file = library.file(mediaId) ?: return
    val mime = library.mimeType(mediaId) ?: ""
    when {
        mime.startsWith("image/") -> AsyncImage(
            model = file,
            imageLoader = rememberImageLoader(),
            contentDescription = null,
            contentScale = when (fit) {
                "cover" -> ContentScale.Crop
                "fill" -> ContentScale.FillBounds
                else -> ContentScale.Fit
            },
            modifier = Modifier.fillMaxSize(),
        )
        mime.startsWith("video/") -> VideoView(Uri.fromFile(file), fit)
        else -> Unit // audio-only items play silently on screen for now
    }
}

/** Hardware-decoded looping video (Media3 ExoPlayer). */
@OptIn(UnstableApi::class)
@Composable
private fun VideoView(uri: Uri, fit: String) {
    val context = LocalContext.current
    val player = remember(uri) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(uri))
            repeatMode = Player.REPEAT_MODE_ONE
            playWhenReady = true
            prepare()
        }
    }
    DisposableEffect(player) { onDispose { player.release() } }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = {
            PlayerView(it).apply {
                useController = false
                this.player = player
                resizeMode = when (fit) {
                    "cover" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                    "fill" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                    else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
                }
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            }
        },
    )
}

// ---------------------------------------------------------------- widgets

private class Style(o: JsonObject?) {
    val color = Color(parseColor(o?.str("color"), android.graphics.Color.WHITE))
    val background = o?.str("background")?.let { Color(parseColor(it, android.graphics.Color.TRANSPARENT)) }
    val bold = (o?.get("bold") as? JsonPrimitive)?.booleanOrNull == true
    val align = o?.str("align") ?: "center"
    val fontScale = (o?.get("fontScale") as? JsonPrimitive)?.doubleOrNull
}

@Composable
private fun fontSize(scale: Double, height: Dp, width: Dp, singleLineChars: Int? = null): TextUnit {
    val byHeight = height * scale.toFloat()
    val size = if (singleLineChars != null) minOf(byHeight, width / (0.62f * singleLineChars)) else byHeight
    return with(LocalDensity.current) { size.coerceAtLeast(6.dp).toSp() }
}

@Composable
fun WidgetView(widget: JsonObject, ctx: RenderContext? = null) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val h = maxHeight
        val w = maxWidth
        when (widget.str("type")) {
            "text" -> {
                val s = Style(widget["style"] as? JsonObject)
                TextBlock(widget.str("text") ?: "", s, fontSize(s.fontScale ?: 0.4, h, w), singleLine = false)
            }
            "clock" -> ClockWidget(widget, h, w)
            "qr" -> {
                val bmp = remember(widget) {
                    qrBitmap(
                        widget.str("value") ?: "",
                        parseColor(widget.str("foreground"), android.graphics.Color.BLACK),
                        parseColor(widget.str("background"), android.graphics.Color.WHITE),
                    )
                }
                Box(
                    Modifier.fillMaxSize().background(Color(parseColor(widget.str("background"), android.graphics.Color.WHITE))),
                    contentAlignment = Alignment.Center,
                ) {
                    bmp?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), filterQuality = FilterQuality.None) }
                }
            }
            "table" -> TableWidget(widget, h)
            "sensorValue" -> ctx?.let { SensorValueWidget(widget, it) }
            "gauge" -> ctx?.let { GaugeWidget(widget, it) }
            "chart" -> ctx?.let { ChartWidget(widget, it) }
            "status" -> ctx?.let { StatusWidget(widget, it) }
            "weather" -> ctx?.let { WeatherWidget(widget, it) }
            "rss" -> ctx?.let { RssWidget(widget, it) }
            "web" -> WebWidget(widget.str("url") ?: "", (widget["refreshSec"] as? JsonPrimitive)?.doubleOrNull?.toLong())
            else -> Box(Modifier.fillMaxSize().background(Color(0xFF111827)))
        }
    }
}

@Composable
private fun TextBlock(text: String, s: Style, size: TextUnit, singleLine: Boolean) {
    val align = when (s.align) {
        "start" -> TextAlign.Start
        "end" -> TextAlign.End
        else -> TextAlign.Center
    }
    Box(
        Modifier.fillMaxSize().background(s.background ?: Color.Transparent).padding(horizontal = 6.dp),
        contentAlignment = when (s.align) {
            "start" -> Alignment.CenterStart
            "end" -> Alignment.CenterEnd
            else -> Alignment.Center
        },
    ) {
        Text(
            text = text,
            color = s.color,
            fontSize = size,
            lineHeight = size * 1.15f,
            fontWeight = if (s.bold) FontWeight.Bold else FontWeight.Medium,
            textAlign = align,
            maxLines = if (singleLine) 1 else Int.MAX_VALUE,
            softWrap = !singleLine,
            overflow = TextOverflow.Clip,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ClockWidget(widget: JsonObject, h: Dp, w: Dp) {
    val s = Style(widget["style"] as? JsonObject)
    val seconds = (widget["seconds"] as? JsonPrimitive)?.booleanOrNull == true
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(seconds) {
        while (true) {
            now = System.currentTimeMillis()
            delay(if (seconds) 1_000 else 5_000)
        }
    }
    val zone = runCatching { ZoneId.of(widget.str("timezone") ?: "Asia/Kolkata") }.getOrDefault(ZoneId.systemDefault())
    val pattern = when (widget.str("format")) {
        "date" -> "EEE, d MMM"
        "datetime" -> if (seconds) "EEE, d MMM, hh:mm:ss a" else "EEE, d MMM, hh:mm a"
        else -> if (seconds) "hh:mm:ss a" else "hh:mm a"
    }
    val text = DateTimeFormatter.ofPattern(pattern, Locale("en", "IN")).format(Instant.ofEpochMilli(now).atZone(zone))
    TextBlock(text, s, fontSize(s.fontScale ?: 0.45, h, w, singleLineChars = maxOf(4, text.length)), singleLine = true)
}

@Composable
private fun TableWidget(widget: JsonObject, h: Dp) {
    val s = Style(widget["style"] as? JsonObject)
    val size = fontSize(s.fontScale ?: 0.06, h, h)
    val columns = (widget["columns"] as? JsonArray)?.map { (it as? JsonPrimitive)?.content ?: "" } ?: emptyList()
    val rows = (widget["rows"] as? JsonArray)?.map { row ->
        (row as? JsonArray)?.map { (it as? JsonPrimitive)?.content ?: "…" } ?: emptyList()
    } ?: emptyList()
    Column(
        Modifier.fillMaxSize().background(s.background ?: Color.Transparent).padding(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(Modifier.fillMaxWidth()) {
            columns.forEach { Text(it, Modifier.weight(1f), color = s.color, fontSize = size, fontWeight = FontWeight.Bold) }
        }
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth()) {
                columns.indices.forEach { i -> Text(row.getOrElse(i) { "" }, Modifier.weight(1f), color = s.color, fontSize = size) }
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun WebWidget(url: String, refreshSec: Long?) {
    if (!url.startsWith("https://")) return
    var reloadTick by remember { mutableIntStateOf(0) }
    LaunchedEffect(refreshSec) {
        if (refreshSec == null) return@LaunchedEffect
        while (true) {
            delay(refreshSec * 1000)
            reloadTick++
        }
    }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = {
            WebView(it).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.mediaPlaybackRequiresUserGesture = false
                webViewClient = WebViewClient()
                loadUrl(url)
            }
        },
        update = { view -> if (reloadTick > 0) view.reload() },
    )
}
