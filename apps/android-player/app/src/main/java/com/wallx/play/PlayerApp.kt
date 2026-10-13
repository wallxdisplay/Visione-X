package com.wallx.play

import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import kotlin.system.exitProcess

/**
 * Watchdog: an unattended screen must never stay on a crash dialog. Any uncaught exception
 * schedules a relaunch in 3 seconds and ends the process.
 */
class PlayerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            Log.e(TAG, "Uncaught exception on ${thread.name}; restarting", error)
            ErrorLog.record(this, "crash: ${error.javaClass.simpleName}: ${error.message}")
            try {
                scheduleRestart(this)
            } catch (_: Throwable) {
                previous?.uncaughtException(thread, error)
            }
            exitProcess(2)
        }
    }

    companion object {
        const val TAG = "WallXPlay"

        fun scheduleRestart(context: Context, delayMs: Long = 3_000) {
            val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            val pending = PendingIntent.getActivity(
                context, 0, intent, PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            alarms.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + delayMs, pending)
        }
    }
}

/** Small persistent ring buffer of recent errors, reported with each heartbeat. */
object ErrorLog {
    private const val PREFS = "errors"
    private const val MAX = 20

    @Synchronized
    fun record(context: Context, message: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = recent(context).toMutableList()
        list.add("${java.time.Instant.now()} ${message.take(250)}")
        while (list.size > MAX) list.removeAt(0)
        prefs.edit().putString("list", list.joinToString("\n")).commit()
    }

    fun recent(context: Context): List<String> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("list", null)
            ?.split("\n")?.filter { it.isNotBlank() } ?: emptyList()

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("list").apply()
    }
}
