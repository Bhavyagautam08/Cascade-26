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

  // --- one-time model download ------------------------------------------------------------------------
  private val cancelled = java.util.concurrent.ConcurrentHashMap<String, Boolean>()

  private fun emit(id: String, state: String, bytes: Long, total: Long) {
    reactApplicationContext
      .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("modelDownload", Arguments.createMap().apply {
        putString("id", id)
        putString("state", state)
        putDouble("bytes", bytes.toDouble())
        putDouble("total", total.toDouble())
      })
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  /**
   * Download `url` to `path` once: resumes a broken download from `path`.part (HTTP Range), refuses when the
   * phone has too little space, and only renames the file into place after its SHA-256 matches `sha256`.
   * Progress goes to JS as "modelDownload" events. Runs on its own thread.
   */
  @ReactMethod
  fun download(id: String, url: String, path: String, sha256: String, size: Double, promise: Promise) {
    cancelled[id] = false
    Thread {
      val target = File(path)
      val part = File("$path.part")
      try {
        target.parentFile?.mkdirs()
        val total = size.toLong()
        var have = if (part.isFile) part.length() else 0L
        if (have > total) { part.delete(); have = 0L }
        val free = android.os.StatFs(target.parentFile!!.absolutePath).availableBytes
        if (free < total - have + 200L * 1024 * 1024) {
          throw IllegalStateException("phone mein jagah kam hai: ${(total - have) / 1_000_000} MB chahiye, ${free / 1_000_000} MB khali hai")
        }
        if (have < total) {
          val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
          conn.connectTimeout = 30_000
          conn.readTimeout = 60_000
          conn.instanceFollowRedirects = true
          if (have > 0) conn.setRequestProperty("Range", "bytes=$have-")
          val code = conn.responseCode
          val append = code == 206
          if (code != 200 && code != 206) throw IllegalStateException("server ne $code diya ($url)")
          if (!append) have = 0L
          conn.inputStream.use { input ->
            java.io.FileOutputStream(part, append).use { out ->
              val buf = ByteArray(1 shl 20)
              var last = 0L
              while (true) {
                if (cancelled[id] == true) throw java.util.concurrent.CancellationException("roka gaya")
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                have += n
                val now = System.currentTimeMillis()
                if (now - last > 500) { emit(id, "downloading", have, total); last = now }
              }
            }
          }
          if (have != total) throw IllegalStateException("download adhoora raha: $have / $total bytes; phir se dabaiye, wahin se shuru hoga")
        }
        emit(id, "verifying", have, total)
        val md = java.security.MessageDigest.getInstance("SHA-256")
        part.inputStream().use { input ->
          val buf = ByteArray(1 shl 20)
          while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (!got.equals(sha256, ignoreCase = true)) {
          part.delete()
          throw IllegalStateException("file kharab aayi (checksum $got, chahiye $sha256); dobara download karein")
        }
        if (target.exists()) target.delete()
        if (!part.renameTo(target)) throw IllegalStateException("file ko ${target.name} naam nahi de paaye")
        emit(id, "done", total, total)
        promise.resolve(target.absolutePath)
      } catch (e: java.util.concurrent.CancellationException) {
        emit(id, "paused", part.length(), size.toLong())
        promise.reject("CANCELLED", "download roka gaya; dobara dabane par wahin se shuru hoga")
      } catch (e: Exception) {
        emit(id, "error", if (part.isFile) part.length() else 0L, size.toLong())
        promise.reject("DOWNLOAD_FAILED", e.message ?: e.toString(), e)
      }
    }.start()
  }

  @ReactMethod
  fun cancelDownload(id: String) {
    cancelled[id] = true
  }

  /** Bytes already downloaded into `path`.part (to show resumable progress). */
  @ReactMethod
  fun partialSize(path: String, promise: Promise) {
    val f = File("$path.part")
    promise.resolve(if (f.isFile) f.length().toDouble() else 0.0)
  }

  /** Why Android ended this app's previous run (a native crash, killed for memory, swiped away...). */
  @ReactMethod
  fun lastExit(promise: Promise) {
    if (Build.VERSION.SDK_INT < 30) {
      promise.resolve(null)
      return
    }
    try {
      val am = reactApplicationContext.getSystemService(android.app.ActivityManager::class.java)
      val info = am.getHistoricalProcessExitReasons(reactApplicationContext.packageName, 0, 1).firstOrNull()
      if (info == null) {
        promise.resolve(null)
        return
      }
      val reason = when (info.reason) {
        android.app.ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
        android.app.ApplicationExitInfo.REASON_CRASH -> "crash"
        android.app.ApplicationExitInfo.REASON_ANR -> "anr"
        android.app.ApplicationExitInfo.REASON_LOW_MEMORY -> "low_memory"
        android.app.ApplicationExitInfo.REASON_SIGNALED -> "signaled"
        android.app.ApplicationExitInfo.REASON_USER_REQUESTED -> "user_requested"
        android.app.ApplicationExitInfo.REASON_EXIT_SELF -> "exit_self"
        else -> "other_${info.reason}"
      }
      promise.resolve(Arguments.createMap().apply {
        putString("reason", reason)
        putString("description", info.description ?: "")
        putDouble("timestamp", info.timestamp.toDouble())
        putDouble("pssKb", info.pss.toDouble())
      })
    } catch (e: Exception) {
      promise.reject("NO_EXIT_INFO", "could not read why the app last stopped: ${e.message}", e)
    }
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
