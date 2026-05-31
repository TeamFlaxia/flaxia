package app.flaxia.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

class KeepAliveService : Service() {
    companion object {
        const val CHANNEL_KEEPALIVE = "flaxia_keepalive"
        const val CHANNEL_NOTIFICATIONS = "flaxia_notifications"
        const val NOTIF_ID_KEEPALIVE = 1
        const val API_BASE = "https://flaxia.app"
        private var lastUnreadCount = 0
    }

    private var pollingThread: Thread? = null
    @Volatile private var running = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        lastUnreadCount = 0
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID_KEEPALIVE, keepAliveNotification(0))
        if (!running) {
            running = true
            pollingThread = Thread { pollingLoop() }.apply { name = "flaxia-poll"; start() }
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running = false
        pollingThread?.interrupt()
        super.onDestroy()
    }

    private fun pollingLoop() {
        while (running) {
            try {
                checkNotifications()
            } catch (_: Exception) { }
            for (i in 0 until 30) {
                if (!running) return
                try { Thread.sleep(1000) } catch (_: InterruptedException) { return }
            }
        }
    }

    private fun checkNotifications() {
        val cookies = CookieManager.getInstance().getCookie(API_BASE)
        if (cookies.isNullOrBlank()) {
            updateKeepAlive(0)
            return
        }

        val url = URL("$API_BASE/api/notifications")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "GET"
        conn.setRequestProperty("Cookie", cookies)
        conn.connectTimeout = 10000
        conn.readTimeout = 10000

        try {
            if (conn.responseCode != 200) {
                updateKeepAlive(0)
                return
            }

            val response = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
            val json = JSONObject(response)
            val unreadCount = json.optInt("unread_count", 0)

            updateKeepAlive(unreadCount)

            if (unreadCount > lastUnreadCount && unreadCount > 0) {
                val arr = json.optJSONArray("notifications")
                if (arr != null && arr.length() > 0) {
                    showNotification(arr.getJSONObject(0))
                }
            }
            lastUnreadCount = unreadCount
        } finally {
            conn.disconnect()
        }
    }

    private fun showNotification(notif: JSONObject) {
        val type = notif.optString("type", "")
        val postId = notif.optString("post_id", "")
        val preview = notif.optString("post_text_preview", "")

        var actorName = ""
        if (notif.has("actor") && !notif.isNull("actor")) {
            val actor = notif.getJSONObject("actor")
            actorName = actor.optString("display_name", actor.optString("username", ""))
        }

        val title = when (type) {
            "reply" -> if (actorName.isNotEmpty()) "$actorName さんが返信" else "返信がありました"
            "mention" -> if (actorName.isNotEmpty()) "$actorName さんがメンション" else "メンションがありました"
            "fresh" -> if (actorName.isNotEmpty()) "$actorName さんの新着" else "新着投稿"
            "ap_follow" -> if (actorName.isNotEmpty()) "$actorName さんがフォロー" else "フォローされました"
            "ap_like" -> if (actorName.isNotEmpty()) "$actorName さんがいいね" else "いいねされました"
            "ap_announce" -> if (actorName.isNotEmpty()) "$actorName さんがブースト" else "ブーストされました"
            "poll_ended" -> "投票が終了"
            else -> "Flaxia"
        }

        val body = preview.ifBlank { "通知を確認してください" }

        val intent = Intent(this, MainActivity::class.java).apply {
            if (postId.isNotBlank()) putExtra("post_id", postId)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pi = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val mgr = getSystemService(NotificationManager::class.java)
        mgr.notify(
            System.currentTimeMillis().toInt(),
            Notification.Builder(this, CHANNEL_NOTIFICATIONS)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setPriority(Notification.PRIORITY_HIGH)
                .build()
        )
    }

    private fun keepAliveNotification(count: Int): Notification {
        val text = if (count > 0) "未読 $count" else "同期中"
        return Notification.Builder(this, CHANNEL_KEEPALIVE)
            .setContentTitle("Flaxia")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_popup_reminder)
            .setOngoing(true)
            .setPriority(Notification.PRIORITY_MIN)
            .build()
    }

    private fun updateKeepAlive(count: Int) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_ID_KEEPALIVE, keepAliveNotification(count))
    }

    private fun createNotificationChannels() {
        val mgr = getSystemService(NotificationManager::class.java)
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_KEEPALIVE, "Flaxia バックグラウンド", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Flaxia がバックグラウンドで動作中"
            }
        )
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_NOTIFICATIONS, "Flaxia 通知", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "新着通知"
                enableVibration(true)
            }
        )
    }
}
