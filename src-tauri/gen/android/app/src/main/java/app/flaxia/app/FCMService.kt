package app.flaxia.app

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging service for push notifications on Android.
 *
 * Requirements (before this will work):
 * 1. Place google-services.json in src-tauri/gen/android/app/
 * 2. Enable FCM Cloud Messaging in the Firebase Console
 * 3. Build with `npm run tauri:build:android`
 *
 * The FCM token is stored in a companion object so the Rust layer can
 * retrieve it via JNI (getPushToken). The frontend registers the token
 * with the Flaxia API server through the [`get_push_token`] Rust command.
 */
class FCMService : FirebaseMessagingService() {

  companion object {
    private const val TAG = "FlaxiaFCM"
    private var currentToken: String? = null

    /**
     * JNI‑accessible entry point for the Rust command [`get_push_token`].
     * Returns the most recent FCM registration token, or null if none yet.
     */
    @JvmStatic
    fun getPushToken(): String? = currentToken
  }

  override fun onNewToken(token: String) {
    Log.d(TAG, "New FCM token: ${token.take(20)}...")
    currentToken = token
  }

  override fun onMessageReceived(message: RemoteMessage) {
    Log.d(TAG, "Message received: ${message.notification?.title}")

    // Data‑only messages can be handled here if needed.
    // Notification payloads are displayed automatically by the system.
  }
}
