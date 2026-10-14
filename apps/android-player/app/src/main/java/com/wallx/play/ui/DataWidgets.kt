package com.wallx.play.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wallx.play.R
import com.wallx.play.core.Weather
import com.wallx.play.data.str
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.time.LocalDate
import java.time.format.TextStyle as JavaTextStyle
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Weather and RSS widgets — native counterpart of apps/web/src/render/DataWidgets.tsx.
 * Values come from /devices/data via RenderContext.data; sizes are fractions of the zone.
 */

private fun Dp.atMost(other: Dp) = if (this < other) this else other
private fun deg(c: Double) = "${c.roundToInt()}°"

@Composable
private fun Placeholder(text: String, color: Color, h: Dp, w: Dp) {
    Text(
        text,
        color = color.copy(alpha = 0.7f),
        fontSize = with(LocalDensity.current) { (h * 0.12f).atMost(w * 0.08f).toSp() },
        textAlign = TextAlign.Center,
    )
}

@Composable
fun WeatherWidget(widget: JsonObject, ctx: RenderContext) {
    val style = widget["style"] as? JsonObject
    val text = Color(parseColor(style?.str("color"), android.graphics.Color.WHITE))
    val bg = Color(parseColor(style?.str("background"), android.graphics.Color.TRANSPARENT))
    val values by ctx.data.values.collectAsState()
    val v = values[widget.str("dataSourceId")]
    val forecast = widget.str("layout") == "forecast"
    BoxWithConstraints(Modifier.fillMaxSize().background(bg), contentAlignment = Alignment.Center) {
        val h = maxHeight
        val w = maxWidth
        val density = LocalDensity.current
        fun sp(x: Dp) = with(density) { x.toSp() }
        val weather = v?.weather
        if (weather == null) {
            Placeholder(v?.error ?: stringResource(R.string.data_nodata), text, h, w)
            return@BoxWithConstraints
        }
        val cond = Weather.condition(weather.current.code)
        Column(
            Modifier.fillMaxSize().padding(horizontal = w * 0.05f, vertical = h * 0.05f),
            verticalArrangement = Arrangement.spacedBy(h * 0.04f, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(w * 0.04f)) {
                Text(Weather.icon(cond, weather.current.isDay), fontSize = sp((h * if (forecast) 0.28f else 0.45f).atMost(w * if (forecast) 0.22f else 0.30f)))
                Column {
                    Text(v.name, color = text.copy(alpha = 0.8f), fontWeight = FontWeight.SemiBold, fontSize = sp((h * 0.10f).atMost(w * 0.07f)), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(deg(weather.current.tempC), color = text, fontWeight = FontWeight.Bold, fontSize = sp((h * if (forecast) 0.22f else 0.36f).atMost(w * if (forecast) 0.18f else 0.24f)))
                    val feels = weather.current.feelsLikeC?.let { " · " + stringResource(R.string.weather_feels, deg(it)) } ?: ""
                    Text(Weather.label(cond) + feels, color = text.copy(alpha = 0.85f), fontSize = sp((h * 0.09f).atMost(w * 0.06f)))
                }
            }
            if (forecast) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                    weather.daily.drop(1).take(3).forEach { d ->
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            val day = runCatching { LocalDate.parse(d.date).dayOfWeek.getDisplayName(JavaTextStyle.SHORT, Locale("en", "IN")) }.getOrDefault(d.date)
                            val size = sp((h * 0.08f).atMost(w * 0.055f))
                            Text(day, color = text, fontSize = size)
                            Text(Weather.icon(Weather.condition(d.code)), fontSize = size)
                            Text("${deg(d.maxC)} ${deg(d.minC)}", color = text, fontSize = size)
                        }
                    }
                }
            }
            if (!v.ok) StaleNote(text = stringResource(R.string.data_stale), size = sp((h * 0.08f).atMost(w * 0.06f)))
        }
        // Provider credit required by its terms ("Google Maps": 12–16 sp, white or #1F1F1F, never translated).
        weather.attribution?.let { credit ->
            val light = text.red * 0.299f + text.green * 0.587f + text.blue * 0.114f > 0.55f
            Text(
                credit,
                Modifier.align(Alignment.BottomEnd).padding(end = w * 0.02f, bottom = h * 0.015f),
                color = if (light) Color.White else Color(0xFF1F1F1F),
                fontSize = sp((h * 0.04f).coerceIn(12.dp, 16.dp)),
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun StaleNote(text: String, size: androidx.compose.ui.unit.TextUnit) {
    Text(
        text,
        color = Color(0xFFFDE68A),
        fontSize = size,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 2.dp),
    )
}

@Composable
fun RssWidget(widget: JsonObject, ctx: RenderContext) {
    val style = widget["style"] as? JsonObject
    val text = Color(parseColor(style?.str("color"), android.graphics.Color.WHITE))
    val bg = Color(parseColor(style?.str("background"), android.graphics.Color.TRANSPARENT))
    val scale = (style?.get("fontScale") as? JsonPrimitive)?.doubleOrNull ?: 0.14
    val bold = (style?.get("bold") as? JsonPrimitive)?.booleanOrNull != false
    val durationSec = ((widget["itemDurationSec"] as? JsonPrimitive)?.intOrNull ?: 8).coerceIn(3, 120)
    val showFeedTitle = (widget["showFeedTitle"] as? JsonPrimitive)?.booleanOrNull != false
    val values by ctx.data.values.collectAsState()
    val v = values[widget.str("dataSourceId")]
    val items = v?.rss?.items.orEmpty()
    var index by remember(items) { mutableIntStateOf(0) }
    LaunchedEffect(items, durationSec) {
        while (items.size > 1) {
            delay(durationSec * 1000L)
            index = (index + 1) % items.size
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize().background(bg), contentAlignment = Alignment.CenterStart) {
        val h = maxHeight
        val w = maxWidth
        val density = LocalDensity.current
        fun sp(x: Dp) = with(density) { x.toSp() }
        if (items.isEmpty()) {
            Placeholder(v?.error ?: stringResource(R.string.data_nodata), text, h, w)
            return@BoxWithConstraints
        }
        Column(
            Modifier.fillMaxSize().padding(horizontal = w * 0.04f, vertical = h * 0.04f),
            verticalArrangement = Arrangement.spacedBy(h * 0.02f, Alignment.CenterVertically),
        ) {
            val feedTitle = v?.rss?.feedTitle.orEmpty()
            if (showFeedTitle && feedTitle.isNotEmpty()) {
                Text(feedTitle, color = text.copy(alpha = 0.75f), fontWeight = FontWeight.SemiBold, fontSize = sp((h * 0.14f).atMost(w * 0.05f)), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            AnimatedContent(targetState = index % items.size, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "rss") { i ->
                val size = sp((h * scale.toFloat()).atMost(w * 0.07f))
                Text(
                    items[i].title,
                    color = text,
                    fontSize = size,
                    lineHeight = size * 1.2f,
                    fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
