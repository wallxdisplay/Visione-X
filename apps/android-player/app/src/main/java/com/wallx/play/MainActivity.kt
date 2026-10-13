package com.wallx.play

import android.app.admin.DevicePolicyManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
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
import com.wallx.play.core.PlayerEngine
import com.wallx.play.ui.PlayerRoot

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
        engine.screenshotter = { captureJpeg() }
        engine.start(lifecycleScope)
        setContent { PlayerRoot(engine) }
    }

    override fun onDestroy() {
        engine.screenshotter = null
        super.onDestroy()
    }

    /**
     * Captures what is on screen as a JPEG (max 1280 px wide). PixelCopy (Android 8+) includes
     * hardware video surfaces; older boxes fall back to drawing the view tree (video shows black).
     */
    private suspend fun captureJpeg(): ByteArray? = withContext(Dispatchers.Main) {
        val view = window.decorView
        if (view.width == 0 || view.height == 0) return@withContext null
        val full = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            suspendCancellableCoroutine { cont ->
                PixelCopy.request(window, full, { result -> cont.resume(result == PixelCopy.SUCCESS) }, Handler(Looper.getMainLooper()))
            }
        } else {
            view.draw(Canvas(full))
            true
        }
        if (!ok) return@withContext null
        withContext(Dispatchers.Default) {
            val scale = minOf(1f, 1280f / full.width)
            val out = if (scale < 1f) Bitmap.createScaledBitmap(full, (full.width * scale).toInt(), (full.height * scale).toInt(), true) else full
            ByteArrayOutputStream().use { stream ->
                out.compress(Bitmap.CompressFormat.JPEG, 70, stream)
                stream.toByteArray()
            }
        }
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
