package com.wallx.play

import android.app.admin.DeviceAdminReceiver
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Starts the player after power-on (and after an app update). On Android 10+ background
 * activity starts are restricted; set the player as the box's Home app (or provision it as
 * device owner) so it is guaranteed to come up after boot. See apps/android-player/README.md.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                try {
                    context.startActivity(
                        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                } catch (e: Exception) {
                    // Fall back to an alarm-driven start (allowed in more situations on some ROMs).
                    PlayerApp.scheduleRestart(context, 1_000)
                }
            }
        }
    }
}

/** Device admin receiver; device-owner provisioning enables kiosk (lock task) mode. */
class KioskAdminReceiver : DeviceAdminReceiver()
