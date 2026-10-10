package com.wallx.visionex.player

import com.wallx.visionex.player.data.Manifest
import com.wallx.visionex.player.data.json
import com.wallx.visionex.player.data.kind
import com.wallx.visionex.player.data.str
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Parses the fixture that packages/layout-spec validates with the TypeScript schema. */
class ManifestFixtureTest {
    private fun fixture(): File {
        // Unit tests run with the module directory as working directory.
        val candidates = listOf("../../../packages/layout-spec/fixtures/manifest.sample.json", "../../packages/layout-spec/fixtures/manifest.sample.json")
        return candidates.map(::File).first { it.exists() }
    }

    @Test
    fun parsesSharedManifest() {
        val m = json.decodeFromString<Manifest>(fixture().readText())
        assertEquals(7, m.version)
        assertEquals(listOf("media", "widget", "widget", "empty"), m.layouts[0].zones.map { it.content.kind() })
        assertEquals("दिवाली ऑफर – 30% off", m.layouts[0].zones[2].content["widget"]!!.let { (it as kotlinx.serialization.json.JsonObject).str("text") })
        assertEquals(listOf("media", "layout", "widget"), m.playlists[0].items.map { it.content.kind() })
        assertEquals(listOf(1, 2, 3, 4, 5), m.schedules[0].daysOfWeek)
        assertEquals("video/mp4", m.assets[1].mimeType)
        assertEquals(null, m.emergency)
    }
}
