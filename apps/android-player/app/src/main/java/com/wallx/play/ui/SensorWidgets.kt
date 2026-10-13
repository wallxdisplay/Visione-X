package com.wallx.play.ui

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.wallx.play.R
import com.wallx.play.core.Live
import com.wallx.play.core.LiveState
import com.wallx.play.core.LiveValue
import com.wallx.play.data.str
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.pow

/**
 * Sensor widgets (value, gauge, chart, status) — the native counterpart of
 * apps/web/src/render/SensorWidgets.tsx. Sizes are fractions of the zone, like the web
 * renderer; values and states follow core/Live.kt (mirror of layout-spec/live.ts).
 */

/** Categorical slots 1–3 for dark surfaces (validated for colour-vision deficiency). */
private val SERIES = listOf(Color(0xFF3987E5), Color(0xFFD95926), Color(0xFF199E70))

private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun color(hex: String?, fallback: Int) = Color(parseColor(hex, fallback))

/** Black or white, whichever reads better on [c]. */
fun inkFor(c: Color): Color {
    fun lin(v: Float) = if (v <= 0.03928f) v / 12.92f else ((v + 0.055f) / 1.055f).toDouble().pow(2.4).toFloat()
    val l = 0.2126f * lin(c.red) + 0.7152f * lin(c.green) + 0.0722f * lin(c.blue)
    return if (l > 0.4f) Color(0xFF0B1020) else Color.White
}

data class Binding(val key: String, val decimals: Int?, val staleOverrideSec: Int?)

private fun binding(o: JsonObject?): Binding? {
    if (o == null || o.str("source") != "sensor") return null
    return Binding(
        "${o.str("sourceId")}/${o.str("field")}",
        (o["decimals"] as? JsonPrimitive)?.intOrNull,
        (o["staleAfterSec"] as? JsonPrimitive)?.intOrNull,
    )
}

private fun bands(o: JsonObject): List<Live.Band> = (o["thresholds"] as? JsonArray).orEmpty().mapNotNull {
    val t = it as? JsonObject ?: return@mapNotNull null
    Live.Band(t.str("label") ?: "", t.str("operator") ?: ">", t.num("value") ?: return@mapNotNull null, t.str("color") ?: "#DC2626")
}

/** Re-evaluates staleness every few seconds even without new data. */
@Composable
private fun rememberTicker(ctx: RenderContext, periodMs: Long = 5_000): Long {
    var now by remember { mutableLongStateOf(ctx.now()) }
    LaunchedEffect(periodMs) {
        while (true) {
            now = ctx.now()
            delay(periodMs)
        }
    }
    return now
}

@Composable
private fun liveOf(ctx: RenderContext, b: Binding?): Pair<LiveValue?, LiveState> {
    val values by ctx.live.values.collectAsState()
    val now = rememberTicker(ctx)
    val v = b?.let { values[it.key] }
    return v to Live.state(v, now, b?.staleOverrideSec)
}

private fun Dp.min(other: Dp) = if (this < other) this else other

/** Caption, body (dimmed when stale/offline) and a state note — same structure as the web. */
@Composable
private fun Frame(
    label: String,
    state: LiveState,
    background: Color,
    textColor: Color,
    content: @Composable (h: Dp, w: Dp) -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize().background(background)) {
        val h = maxHeight
        val w = maxWidth
        val density = LocalDensity.current
        Column(
            Modifier.fillMaxSize().padding(horizontal = w * 0.04f, vertical = h * 0.04f),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(h * 0.02f),
        ) {
            if (label.isNotEmpty()) {
                Text(
                    label,
                    color = textColor.copy(alpha = 0.8f),
                    fontSize = with(density) { (h * 0.12f).min(w * 0.09f).toSp() },
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            val dim = state == LiveState.STALE || state == LiveState.OFFLINE
            Box(Modifier.weight(1f).fillMaxWidth().alpha(if (dim) 0.5f else 1f), contentAlignment = Alignment.Center) {
                content(h, w)
            }
            if (dim) {
                Text(
                    stringResource(if (state == LiveState.STALE) R.string.sensor_stale else R.string.sensor_offline),
                    color = Color(0xFFFDE68A),
                    fontSize = with(density) { (h * 0.08f).min(w * 0.06f).toSp() },
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.background(Color.Black.copy(alpha = 0.55f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun NoData(h: Dp, w: Dp, textColor: Color) {
    Text(
        stringResource(R.string.sensor_nodata),
        color = textColor.copy(alpha = 0.7f),
        fontSize = with(LocalDensity.current) { (h * 0.12f).min(w * 0.08f).toSp() },
    )
}

@Composable
fun SensorValueWidget(widget: JsonObject, ctx: RenderContext) {
    val style = widget.obj("style")
    val text = color(style?.str("color"), android.graphics.Color.WHITE)
    val bg = color(style?.str("background"), android.graphics.Color.TRANSPARENT)
    val b = binding(widget.obj("binding"))
    val (v, state) = liveOf(ctx, b)
    val scale = style?.num("fontScale") ?: 0.4
    Frame(widget.str("label") ?: "", state, bg, text) { h, w ->
        val value = v?.value
        if (value == null) {
            NoData(h, w, text)
            return@Frame
        }
        val band = Live.band(bands(widget), value)
        val size = with(LocalDensity.current) { (h * scale.toFloat()).min(w * 0.22f).toSp() }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(h * 0.02f)) {
            Text(
                buildAnnotatedString {
                    append(Live.format(value, b?.decimals))
                    val unit = widget.str("unit").orEmpty()
                    if (unit.isNotEmpty()) withStyle(SpanStyle(fontSize = size * 0.45f, fontWeight = FontWeight.Medium)) { append(" $unit") }
                },
                color = band?.let { color(it.color, android.graphics.Color.WHITE) } ?: text,
                fontSize = size,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
            )
            if (band != null && band.label.isNotEmpty()) {
                val bc = color(band.color, android.graphics.Color.RED)
                Text(
                    band.label,
                    color = inkFor(bc),
                    fontWeight = FontWeight.Bold,
                    fontSize = with(LocalDensity.current) { (h * 0.09f).min(w * 0.07f).toSp() },
                    modifier = Modifier.background(bc, RoundedCornerShape(50)).padding(horizontal = 12.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
fun GaugeWidget(widget: JsonObject, ctx: RenderContext) {
    val style = widget.obj("style")
    val text = color(style?.str("color"), android.graphics.Color.WHITE)
    val bg = color(style?.str("background"), android.graphics.Color.TRANSPARENT)
    val b = binding(widget.obj("binding"))
    val (v, state) = liveOf(ctx, b)
    val min = widget.num("min") ?: 0.0
    val max = widget.num("max") ?: 100.0
    Frame(widget.str("label") ?: "", state, bg, text) { _, _ ->
        val value = v?.value
        val fill = value?.let { Live.band(bands(widget), it) }?.let { color(it.color, 0) } ?: SERIES[0]
        val fraction = value?.let { Live.gaugeFraction(it, min, max) } ?: 0f
        val unit = widget.str("unit").orEmpty()
        Canvas(Modifier.fillMaxSize()) {
            // Same geometry as the web gauge: a 100×60 box, radius 40, stroke 9.
            val s = kotlin.math.min(size.width / 100f, size.height / 60f)
            val ox = (size.width - 100f * s) / 2f
            val oy = (size.height - 60f * s) / 2f
            val topLeft = Offset(ox + 10f * s, oy + 10f * s)
            val arcSize = Size(80f * s, 80f * s)
            drawArc(text.copy(alpha = 0.18f), 180f, 180f, false, topLeft, arcSize, style = Stroke(9f * s, cap = StrokeCap.Round))
            if (fraction > 0f) drawArc(fill, 180f, 180f * fraction, false, topLeft, arcSize, style = Stroke(9f * s, cap = StrokeCap.Round))
            drawIntoCanvas { c ->
                val p = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = text.toArgb()
                    textAlign = Paint.Align.CENTER
                    typeface = Typeface.DEFAULT_BOLD
                }
                p.textSize = (if (value == null) 8f else 15f) * s
                val main = if (value == null) "—" else Live.format(value, b?.decimals) + if (unit.isNotEmpty()) " $unit" else ""
                c.nativeCanvas.drawText(main, ox + 50f * s, oy + 47f * s, p)
                p.typeface = Typeface.DEFAULT
                p.textSize = 6f * s
                p.alpha = 180
                c.nativeCanvas.drawText(Live.format(min), ox + 10f * s, oy + 58f * s, p)
                c.nativeCanvas.drawText(Live.format(max), ox + 90f * s, oy + 58f * s, p)
            }
        }
    }
}

@Composable
fun StatusWidget(widget: JsonObject, ctx: RenderContext) {
    val style = widget.obj("style")
    val b = binding(widget.obj("binding"))
    val (v, state) = liveOf(ctx, b)
    val value = v?.value
    val match = value?.let { x ->
        (widget["states"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }.firstOrNull { Live.statusMatches(it.str("match") ?: "", x) }
    }
    val bg = match?.let { color(it.str("color"), 0xFF1F2937.toInt()) } ?: color(style?.str("background"), 0xFF1F2937.toInt())
    val ink = inkFor(bg)
    val scale = style?.num("fontScale") ?: 0.3
    Frame(widget.str("label") ?: "", state, bg, ink) { h, w ->
        if (value == null) {
            NoData(h, w, ink)
            return@Frame
        }
        Text(
            match?.str("label") ?: Live.format(value, b?.decimals),
            color = ink,
            fontWeight = FontWeight.Bold,
            fontSize = with(LocalDensity.current) { (h * scale.toFloat()).toSp() },
            maxLines = 2,
        )
    }
}

/** 3–5 round tick values covering [min, max] (same as niceTicks in SeriesChart.tsx). */
fun niceTicks(minIn: Double, maxIn: Double, count: Int = 4): List<Double> {
    var min = minIn
    var max = maxIn
    if (min == max) {
        min -= 1
        max += 1
    }
    val raw = (max - min) / count
    val mag = 10.0.pow(floor(log10(raw)))
    val step = listOf(1.0, 2.0, 2.5, 5.0, 10.0).map { it * mag }.firstOrNull { it >= raw } ?: (10 * mag)
    val start = floor(min / step) * step
    val ticks = mutableListOf<Double>()
    var v = start
    while (v <= max + step * 0.001) {
        ticks += kotlin.math.round(v * 1e10) / 1e10
        v += step
    }
    if (ticks.last() < max) ticks += start + ticks.size * step
    return ticks
}

@Composable
fun ChartWidget(widget: JsonObject, ctx: RenderContext) {
    val style = widget.obj("style")
    val text = color(style?.str("color"), android.graphics.Color.WHITE)
    val bg = color(style?.str("background"), android.graphics.Color.TRANSPARENT)
    val bindings = (widget["bindings"] as? JsonArray).orEmpty().mapNotNull { binding(it as? JsonObject) }.take(3)
    val windowMin = widget.num("windowMinutes")?.toLong() ?: 60L
    val bars = widget.str("kind") == "bar"
    val history by ctx.live.history.collectAsState()
    val values by ctx.live.values.collectAsState()
    val now = rememberTicker(ctx, 30_000)
    val names = remember(values) { bindings.map { b -> ctx.live.names[b.key] ?: b.key.substringAfter('/') } }
    val from = now - windowMin * 60_000
    val series = bindings.map { b -> history[b.key].orEmpty().filter { it.first in from..now } }
    val timeFmt = remember { SimpleDateFormat("hh:mm a", Locale("en", "IN")) }
    val decimals = bindings.firstOrNull()?.decimals

    Frame(widget.str("label") ?: "", LiveState.OK, bg, text) { h, _ ->
        val all = series.flatten().map { it.second }
        if (all.isEmpty()) {
            NoData(h, h * 2, text)
            return@Frame
        }
        Canvas(Modifier.fillMaxSize()) {
            val fontPx = kotlin.math.max(9f * density, size.height * 0.055f)
            val stroke = kotlin.math.max(2f * density, fontPx / 6f)
            val ticks = niceTicks(all.min(), all.max())
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = fontPx; color = text.copy(alpha = 0.7f).toArgb() }
            val tickW = ticks.maxOf { paint.measureText(Live.format(it, decimals)) }
            val legendH = if (series.size > 1) fontPx * 1.8f else 0f
            val left = tickW + fontPx * 0.8f
            val right = fontPx * 0.8f
            val top = fontPx * 0.8f + legendH
            val bottom = fontPx * 2f
            val plotW = kotlin.math.max(1f, size.width - left - right)
            val plotH = kotlin.math.max(1f, size.height - top - bottom)
            val yMin = ticks.first()
            val yMax = ticks.last()
            fun x(t: Long) = left + ((t - from).toFloat() / (now - from).toFloat()) * plotW
            fun y(v: Double) = top + plotH - ((v - yMin) / (yMax - yMin).let { if (it == 0.0) 1.0 else it }).toFloat() * plotH

            drawIntoCanvas { c ->
                // Legend (≥ 2 series), grid + y labels, x labels: text in text colours only.
                if (series.size > 1) {
                    val lp = Paint(paint).apply { color = text.toArgb() }
                    series.indices.forEach { i ->
                        val lx = left + i * plotW / series.size
                        drawLine(SERIES[i], Offset(lx, fontPx * 0.9f), Offset(lx + fontPx, fontPx * 0.9f), strokeWidth = stroke, cap = StrokeCap.Round)
                        c.nativeCanvas.drawText(names[i], lx + fontPx * 1.4f, fontPx * 1.25f, lp)
                    }
                }
                paint.textAlign = Paint.Align.RIGHT
                for (t in ticks) {
                    drawLine(text.copy(alpha = 0.15f), Offset(left, y(t)), Offset(left + plotW, y(t)), strokeWidth = 1f)
                    c.nativeCanvas.drawText(Live.format(t, decimals), left - fontPx * 0.5f, y(t) + fontPx * 0.35f, paint)
                }
                listOf(from to Paint.Align.LEFT, (from + now) / 2 to Paint.Align.CENTER, now to Paint.Align.RIGHT).forEach { (t, align) ->
                    paint.textAlign = align
                    c.nativeCanvas.drawText(timeFmt.format(Date(t)), x(t), size.height - fontPx * 0.6f, paint)
                }
            }

            if (bars) {
                val bins = (plotW / (28f * density)).toInt().coerceIn(4, 24)
                val groupW = plotW / bins
                val barW = kotlin.math.min(24f * density, (groupW - 4f * density - 2f * density * (series.size - 1)) / series.size)
                val baseV = kotlin.math.min(kotlin.math.max(0.0, yMin), yMax)
                series.forEachIndexed { si, pts ->
                    val sums = DoubleArray(bins)
                    val counts = IntArray(bins)
                    for ((t, v) in pts) {
                        val i = (((t - from).toDouble() / (now - from)) * bins).toInt().coerceIn(0, bins - 1)
                        sums[i] += v
                        counts[i]++
                    }
                    for (b in 0 until bins) {
                        if (counts[b] == 0) continue
                        val v = sums[b] / counts[b]
                        val bx = left + b * groupW + (groupW - (barW * series.size + 2f * density * (series.size - 1))) / 2f + si * (barW + 2f * density)
                        val y0 = kotlin.math.min(y(v), y(baseV))
                        val hgt = kotlin.math.max(1f, abs(y(baseV) - y(v)))
                        val r = kotlin.math.min(4f * density, kotlin.math.min(barW / 2f, hgt))
                        // Rounded data end, square at the baseline.
                        drawRoundRect(SERIES[si], Offset(bx, y0), Size(barW, hgt), CornerRadius(r, r))
                        val squareTop = if (y(v) <= y(baseV)) y0 + hgt - r else y0
                        drawRect(SERIES[si], Offset(bx, squareTop), Size(barW, r))
                    }
                }
            } else {
                series.forEachIndexed { si, pts ->
                    if (pts.isEmpty()) return@forEachIndexed
                    // Break the line where readings stop for a while.
                    val gaps = pts.zipWithNext { a, b -> b.first - a.first }.sorted()
                    val typical = gaps.getOrNull(gaps.size / 2) ?: 0L
                    val path = Path()
                    pts.forEachIndexed { i, (t, v) ->
                        val breakHere = i == 0 || t - pts[i - 1].first > kotlin.math.max(typical * 4, 60_000L)
                        if (breakHere) path.moveTo(x(t), y(v)) else path.lineTo(x(t), y(v))
                    }
                    drawPath(path, SERIES[si], style = Stroke(stroke, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    val (lt, lv) = pts.last()
                    val r = kotlin.math.max(4f * density, stroke * 2f)
                    drawCircle(bg.takeIf { it.alpha > 0f } ?: Color.Black, r + 2f * density, Offset(x(lt), y(lv)))
                    drawCircle(SERIES[si], r, Offset(x(lt), y(lv)))
                }
            }
        }
    }
}
