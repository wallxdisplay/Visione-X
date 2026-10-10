# kotlinx.serialization: keep generated serializers for @Serializable classes.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keep,includedescriptorclasses class com.wallx.visionex.player.**$$serializer { *; }
-keepclassmembers class com.wallx.visionex.player.** {
    *** Companion;
}
-keepclasseswithmembers class com.wallx.visionex.player.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# OkHttp platform warnings
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
