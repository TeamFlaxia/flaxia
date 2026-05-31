use tauri::Manager;

/// Get the device's push notification token from native platform (FCM).
/// On Android, reads the token from the FCMService via JNI.
/// On desktop, push is not available — returns an error.
#[tauri::command]
fn get_push_token(_app: tauri::AppHandle) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    use jni::objects::JString;
    use jni::JavaVM;

    let vm_ptr = ndk_context::android_context().vm() as *mut jni::sys::JavaVM;
    let vm = unsafe { JavaVM::from_raw(vm_ptr) }
      .map_err(|e| format!("JNI: failed to get JavaVM: {e}"))?;
    let mut env = vm.attach_current_thread()
      .map_err(|e| format!("JNI: failed to attach thread: {e}"))?;

    let class = env.find_class("app/flaxia/app/FCMService")
      .map_err(|e| format!("JNI: failed to find FCMService class: {e}"))?;
    let result = env.call_static_method(
      class,
      "getPushToken",
      "()Ljava/lang/String;",
      &[],
    ).map_err(|e| format!("JNI: failed to call getPushToken: {e}"))?;

    let token: JString = result.l()
      .map_err(|_| "JNI: getPushToken returned non-string".to_string())?
      .into();

    if token.is_null() {
      return Err("Push token not available yet".to_string());
    }

    let rust_str: String = env.get_string(&token)
      .map_err(|e| format!("JNI: failed to read token string: {e}"))?
      .into();

    if rust_str.is_empty() {
      return Err("Push token not available yet".to_string());
    }
    Ok(rust_str)
  }
  #[cfg(not(target_os = "android"))]
  {
    Err("Push notifications are only supported on Android".to_string())
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![get_push_token])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Build system tray (desktop only)
      #[cfg(desktop)]
      {
        use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState};

        let tray = TrayIconBuilder::new()
          .tooltip("Flaxia")
          .on_menu_event(|app, event| {
            match event.id.as_ref() {
              "show" => {
                if let Some(window) = app.get_webview_window("main") {
                  let _ = window.show();
                  let _ = window.set_focus();
                }
              }
              "quit" => {
                app.exit(0);
              }
              _ => {}
            }
          })
          .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
              button: MouseButton::Left,
              button_state: MouseButtonState::Up,
              ..
            } = event {
              if let Some(window) = tray.app_handle().get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
          });

        // Build context menu
        let menu = tauri::menu::MenuBuilder::new(app)
          .item(&tauri::menu::MenuItemBuilder::with_id("show", "Show Flaxia").build(app)?)
          .item(&tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?)
          .build()?;
        tray.menu(&menu).build(app)?;
      }

      Ok(())
    })
    .on_window_event(|_window, event| {
      if let tauri::WindowEvent::CloseRequested { api: _, .. } = event {
        // On desktop, minimize to tray instead of closing
        #[cfg(desktop)]
        {
          let _ = window.hide();
          api.prevent_close();
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
