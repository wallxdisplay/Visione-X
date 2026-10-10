package com.wallx.visionex.player.ui

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter

/** Renders a QR code as a bitmap (one pixel per module, scaled up by the UI without blur). */
fun qrBitmap(value: String, foreground: Int = Color.BLACK, background: Int = Color.WHITE): Bitmap? = runCatching {
    val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 1))
    val bmp = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
    for (x in 0 until matrix.width) for (y in 0 until matrix.height) {
        bmp.setPixel(x, y, if (matrix[x, y]) foreground else background)
    }
    bmp
}.getOrNull()

/** "#RRGGBB" / "#RRGGBBAA" (spec format) → Android ARGB int. */
fun parseColor(hex: String?, fallback: Int): Int {
    if (hex == null || !hex.startsWith("#")) return fallback
    return runCatching {
        when (hex.length) {
            7 -> Color.parseColor(hex)
            9 -> { // spec is RRGGBBAA; Android wants AARRGGBB
                val rgb = hex.substring(1, 7)
                val a = hex.substring(7, 9)
                Color.parseColor("#$a$rgb")
            }
            else -> fallback
        }
    }.getOrDefault(fallback)
}
