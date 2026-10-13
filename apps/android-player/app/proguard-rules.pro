# kotlinx.serialization: keep generated serializers for @Serializable classes.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keep,includedescriptorclasses class com.wallx.play.**$$serializer { *; }
-keepclassmembers class com.wallx.play.** {
    *** Companion;
}
-keepclasseswithmembers class com.wallx.play.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# OkHttp platform warnings
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
