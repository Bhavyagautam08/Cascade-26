package com.cascade.invisibleworker

import android.content.Intent
import android.os.Build
import android.util.Base64
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface

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

/** The always-on mic's foreground service, and this phone's own local addresses (for finding family phones). */
class DeviceModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "Device"

  @ReactMethod
  fun startListening(promise: Promise) {
    try {
      val intent = Intent(reactApplicationContext, ListenService::class.java)
      if (Build.VERSION.SDK_INT >= 26) reactApplicationContext.startForegroundService(intent) else reactApplicationContext.startService(intent)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("LISTEN_SERVICE_FAILED", "Android did not allow the listening service: ${e.message}", e)
    }
  }

  @ReactMethod
  fun stopListening(promise: Promise) {
    promise.resolve(reactApplicationContext.stopService(Intent(reactApplicationContext, ListenService::class.java)))
  }

  /** Private IPv4 addresses of the interfaces that are up (Wi-Fi, or this phone's own hotspot), with their prefix. */
  @ReactMethod
  fun localAddresses(promise: Promise) {
    try {
      val out = Arguments.createArray()
      for (nif in NetworkInterface.getNetworkInterfaces()) {
        if (!nif.isUp || nif.isLoopback) continue
        for (a in nif.interfaceAddresses) {
          val ip = a.address
          if (ip !is Inet4Address || !ip.isSiteLocalAddress) continue
          out.pushMap(Arguments.createMap().apply {
            putString("address", ip.hostAddress)
            putInt("prefix", a.networkPrefixLength.toInt())
            putString("interface", nif.name)
          })
        }
      }
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("NO_ADDRESSES", "could not read this phone's network addresses: ${e.message}", e)
    }
  }
}

class AppFilesPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AppFilesModule(ctx), DeviceModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
