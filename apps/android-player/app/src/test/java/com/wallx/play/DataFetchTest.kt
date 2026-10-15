package com.wallx.play

import com.wallx.play.core.PlayerEngine.Companion.dataFetchDue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When the player fetches weather / RSS / air quality values. */
class DataFetchTest {
    @Test
    fun fetchesAtOnceWhenNewContentBringsDataSources() {
        // A layout with a new weather widget was just published: no 5-minute wait.
        assertTrue(dataFetchDue(setOf("weather", "rss"), setOf("weather"), now = 1_000, nextAt = 300_000))
        assertTrue(dataFetchDue(setOf("weather"), emptySet(), now = 1_000, nextAt = 300_000))
    }

    @Test
    fun otherwiseRefreshesOnSchedule() {
        assertFalse(dataFetchDue(setOf("weather"), setOf("weather"), now = 299_999, nextAt = 300_000))
        assertTrue(dataFetchDue(setOf("weather"), setOf("weather"), now = 300_000, nextAt = 300_000))
        assertFalse("nothing to fetch", dataFetchDue(emptySet(), emptySet(), now = 999_999, nextAt = 0))
    }
}
