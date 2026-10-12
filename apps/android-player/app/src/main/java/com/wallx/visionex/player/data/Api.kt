package com.wallx.visionex.player.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Server answered with an error status (as opposed to a network failure). */
class ApiException(val status: Int, val code: String?, message: String) : IOException(message)

/** Client for the device endpoints under /api/v1/devices. All calls run on the IO dispatcher. */
class Api(private val base: String, val http: OkHttpClient = defaultClient()) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun register(hardware: DeviceHardware): RegisterResponse =
        post("/devices/register", json.encodeToString(RegisterRequest(hardware)), auth = null)

    suspend fun me(auth: String): DeviceState = get("/devices/me", auth)

    /** Raw manifest JSON (stored as-is so the exact published version can be reloaded offline). */
    suspend fun manifestJson(auth: String): String = request(Request.Builder().url("$base/devices/manifest").get(), auth)

    suspend fun commands(auth: String): CommandList = get("/devices/commands", auth)

    /** Latest values of the sensor channels bound by the published content. */
    suspend fun live(auth: String): LiveResponse = get("/devices/live", auth)

    /** Recent readings for chart widgets ([epoch ms, value] points). */
    suspend fun liveHistory(auth: String): HistoryResponse = get("/devices/live/history", auth)

    suspend fun commandResult(auth: String, body: CommandResult) {
        request(
            Request.Builder().url("$base/devices/commands/result").post(json.encodeToString(body).toRequestBody(jsonType)),
            auth,
        )
    }

    suspend fun heartbeat(auth: String, body: Heartbeat) {
        request(
            Request.Builder().url("$base/devices/heartbeat").post(json.encodeToString(body).toRequestBody(jsonType)),
            auth,
        )
    }

    private suspend inline fun <reified T> get(path: String, auth: String?): T =
        json.decodeFromString(request(Request.Builder().url(base + path).get(), auth))

    private suspend inline fun <reified T> post(path: String, body: String, auth: String?): T =
        json.decodeFromString(request(Request.Builder().url(base + path).post(body.toRequestBody(jsonType)), auth))

    private suspend fun request(builder: Request.Builder, auth: String?): String = withContext(Dispatchers.IO) {
        if (auth != null) builder.header("Authorization", auth)
        http.newCall(builder.build()).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val code = runCatching { json.decodeFromString<ErrorBody>(text).error }.getOrNull()
                throw ApiException(res.code, code, "HTTP ${res.code} ${code ?: ""}".trim())
            }
            text
        }
    }

    @kotlinx.serialization.Serializable
    private data class ErrorBody(val error: String? = null, val message: String? = null)

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
