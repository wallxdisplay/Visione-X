plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.0" apply false
}

// OneDrive (and similar sync tools) lock files while syncing, which breaks Gradle builds.
// When the project lives in such a folder on Windows, build outside it:
// %LOCALAPPDATA%\visione-x-player-build\<module>.
val localAppData: String? = System.getenv("LOCALAPPDATA")
if (localAppData != null && rootDir.absolutePath.contains("OneDrive", ignoreCase = true)) {
    allprojects {
        layout.buildDirectory.set(File(localAppData, "visione-x-player-build/${project.name}"))
    }
}
