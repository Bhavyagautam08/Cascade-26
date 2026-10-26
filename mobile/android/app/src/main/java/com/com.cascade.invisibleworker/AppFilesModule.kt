package com.cascade.invisibleworker

import android.util.Base64
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Where this app's files live, asked from Android itself (no fixed path): the model files copied over USB
 * sit in getExternalFilesDir(null)/models, i.e. Android/data/<package>/files/models. Readable by the app
 * without any storage permission.
 */
class AppFilesModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AppFiles"

  override fun getConstants(): Map<String, Any?> = mapOf(
    "externalFilesDir" to reactApplicationContext.getExternalFilesDir(null)?.absolutePath,
    "filesDir" to reactApplicationContext.filesDir.absolutePath,
    "cacheDir" to reactApplicationContext.cacheDir.absolutePath,
  )

  /** Size in bytes, or -1 if the file isn't there. */
  @ReactMethod
  fun fileSize(path: String, promise: Promise) {
    val f = File(path)
    promise.resolve(if (f.isFile) f.length().toDouble() else -1.0)
  }

  @ReactMethod
  fun deleteFile(path: String, promise: Promise) {
    promise.resolve(File(path).delete())
  }

  @ReactMethod
  fun writeWav(path: String, chunks: ReadableArray, sampleRate: Int, promise: Promise) {
    if (sampleRate <= 0) {
      promise.reject("INVALID_SAMPLE_RATE", "sample rate must be positive")
      return
    }
    try {
      val pcm = ByteArrayOutputStream()
      for (index in 0 until chunks.size()) {
        val encoded = chunks.getString(index) ?: throw IllegalArgumentException("audio chunk $index is empty")
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        if (pcm.size().toLong() + bytes.size > 16L * 1024 * 1024) {
          throw IllegalArgumentException("recording exceeds the 16 MiB limit")
        }
        pcm.write(bytes)
      }
      if (pcm.size() == 0) throw IllegalArgumentException("recording contains no audio")

      val audio = pcm.toByteArray()
      val wav = ByteArrayOutputStream(audio.size + 44)
      fun writeIntLE(value: Int) {
        wav.write(value and 0xff)
        wav.write((value shr 8) and 0xff)
        wav.write((value shr 16) and 0xff)
        wav.write((value shr 24) and 0xff)
      }
      fun writeShortLE(value: Int) {
        wav.write(value and 0xff)
        wav.write((value shr 8) and 0xff)
      }
      wav.write("RIFF".toByteArray(Charsets.US_ASCII))
      writeIntLE(audio.size + 36)
      wav.write("WAVEfmt ".toByteArray(Charsets.US_ASCII))
      writeIntLE(16)
      writeShortLE(1)
      writeShortLE(1)
      writeIntLE(sampleRate)
      writeIntLE(sampleRate * 2)
      writeShortLE(2)
      writeShortLE(16)
      wav.write("data".toByteArray(Charsets.US_ASCII))
      writeIntLE(audio.size)
      wav.write(audio)

      val file = File(path)
      file.parentFile?.mkdirs()
      file.writeBytes(wav.toByteArray())
      promise.resolve(file.absolutePath)
    } catch (e: Exception) {
      promise.reject("WRITE_WAV_FAILED", e.message, e)
    }
  }
}

class AppFilesPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AppFilesModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
