package com.cascade.invisibleworker

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
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
}

class AppFilesPackage : ReactPackage {
  override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> = listOf(AppFilesModule(ctx))
  override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
