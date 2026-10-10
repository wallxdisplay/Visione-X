package com.wallx.visionex.player

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.OnBackPressedCallback
import androidx.lifecycle.lifecycleScope
import com.wallx.visionex.player.core.PlayerEngine
import com.wallx.visionex.player.ui.PlayerRoot

/**
 * The only screen. Full-screen, never sleeps, ignores Back. If the app is the device owner it
 * also enters lock task (kiosk) mode so the box cannot leave the player.
 */
class MainActivity : ComponentActivity() {
    private lateinit var engine: PlayerEngine

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersive()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = Unit // a signage screen has nowhere to go back to
        })

        engine = PlayerEngine.get(applicationContext)
        engine.start(lifecycleScope)
        setContent { PlayerRoot(engine) }
    }

    override fun onResume() {
        super.onResume()
        enterImmersive()
        startKioskIfOwner()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    @Suppress("DEPRECATION")
    private fun enterImmersive() {
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN)
    }

    private fun startKioskIfOwner() {
        val dpm = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isDeviceOwnerApp(packageName)) return
        val admin = ComponentName(this, KioskAdminReceiver::class.java)
        dpm.setLockTaskPackages(admin, arrayOf(packageName))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
        }
        try {
            startLockTask()
        } catch (e: IllegalStateException) {
            ErrorLog.record(this, "lock task: ${e.message}")
        }
    }
}
