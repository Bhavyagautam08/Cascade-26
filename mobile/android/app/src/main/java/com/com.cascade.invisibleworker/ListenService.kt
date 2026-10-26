package com.cascade.invisibleworker

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the always-on mic alive all day: Android stops giving audio to an app that is not in front unless a
 * foreground service of type "microphone" runs, and lets the CPU sleep with the screen off unless a wake lock
 * is held. The listening itself (audio, cutting, Whisper) stays in the app; this only keeps it allowed and
 * awake, and shows the vendor an ongoing notification that the phone is listening.
 */
class ListenService : Service() {
  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Hisaab sun raha hai", NotificationManager.IMPORTANCE_LOW))
    }
    val open = PendingIntent.getActivity(
      this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    val notification = builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("Hisaab sun raha hai")
      .setContentText("Len-den ki baatein likh raha hai. Awaaz save nahi hoti. Band karne ke liye app kholein.")
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    else startForeground(ID, notification)
    if (wake == null) {
      wake = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cascade:listen").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wake?.release()
    wake = null
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    super.onDestroy()
  }

  companion object {
    const val CHANNEL = "listening"
    const val ID = 4587
  }
}
