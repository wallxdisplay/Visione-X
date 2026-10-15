package com.wallx.play.core

import com.wallx.play.data.TouchInfo
import com.wallx.play.data.ZoneAction

/**
 * Touch kiosk state (immutable, so Compose can hold it in a state value). A visit starts with a
 * touch on the home page; taps on zones with actions open pages, go back or go home; without
 * touches for idleSec the visit ends: back to the schedule (attract loop) or to the home page.
 */
data class TouchState(val pages: List<String> = emptyList(), val lastTouch: Long = 0L) {
    /** The page on screen, or null while the schedule plays (attract loop, no visit). */
    fun page(info: TouchInfo): String? = pages.lastOrNull() ?: if (info.attract) null else info.homeLayoutId

    val visiting: Boolean get() = pages.isNotEmpty()

    /** Any touch: keeps the visit alive, or starts one on the home page. */
    fun touched(info: TouchInfo, now: Long): TouchState = copy(pages = pages.ifEmpty { listOf(info.homeLayoutId) }, lastTouch = now)

    /** A zone's tap action. */
    fun act(info: TouchInfo, action: ZoneAction, now: Long): TouchState {
        val current = pages.ifEmpty { listOf(info.homeLayoutId) }
        val next = when (action.kind) {
            "page" -> action.layoutId?.takeIf { it != current.last() }?.let { (current + it).takeLast(MAX_HISTORY) } ?: current
            "back" -> if (current.size > 1) current.dropLast(1) else current
            "home" -> listOf(info.homeLayoutId)
            else -> current
        }
        return TouchState(next, now)
    }

    /** When the visit ends without further touches (null when there is no visit). */
    fun endsAt(info: TouchInfo): Long? = if (visiting) lastTouch + info.idleSec * 1000L else null

    fun ended(): TouchState = TouchState()

    companion object {
        /** Pages remembered for "back". */
        const val MAX_HISTORY = 20
    }
}
