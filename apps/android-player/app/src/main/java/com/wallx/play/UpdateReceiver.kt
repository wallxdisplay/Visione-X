package com.wallx.play

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import com.wallx.play.core.PlayerEngine

/**
 * Result of a player update install (PackageInstaller session commit). On success Android
 * replaces the app and BootReceiver starts the new version (MY_PACKAGE_REPLACED).
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val updater = PlayerEngine.get(context).updater
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                updater.onNeedsUser(confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            else -> {
                val version = updater.status.value?.versionCode ?: return
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                updater.onFailed(version, if (status == PackageInstaller.STATUS_FAILURE_ABORTED) "install cancelled" else message ?: "install failed ($status)")
            }
        }
    }
}
