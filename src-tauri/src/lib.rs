use std::sync::Mutex;
use tauri::Manager;

struct TrayState(Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>>);

/// JS の refreshNotificationBadges から呼ばれる: トレイアイコン即時更新
/// ビルド時に生成したバッジ付き PNG に切り替えるだけ (ランタイムの画像加工なし)
#[tauri::command]
fn set_notification_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
  eprintln!("set_notification_count({})", count);
  if let Some(tray_state) = app.try_state::<TrayState>() {
    let guard = tray_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = guard.as_ref() {
      // ツールチップ更新
      let tip = if count > 0 {
        format!("Flaxia ({} unread)", count)
      } else {
        "Flaxia".into()
      };
      let _ = tray.set_tooltip(Some(&tip));

      // ビルド時に含めた PNG を切り替える — ランタイムの RGBA 操作は一切しない
      let icon_bytes: &[u8] = if count > 0 {
        include_bytes!("../icons/32x32-badge.png")
      } else {
        include_bytes!("../icons/32x32.png")
      };
      let icon = tauri::image::Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;
      tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![set_notification_count])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Desktop: tray + background polling
      #[cfg(desktop)]
      {
        use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState};

        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
          .expect("Failed to load tray icon");
        let tray = TrayIconBuilder::new()
          .icon(icon)
          .tooltip("Flaxia")
          .show_menu_on_left_click(false)
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
            let show_window = |tray: &tauri::tray::TrayIcon| {
              if let Some(window) = tray.app_handle().get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            };
            match event {
              tauri::tray::TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
              } => show_window(tray),
              tauri::tray::TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
              } => show_window(tray),
              _ => {}
            }
          });

        let menu = tauri::menu::MenuBuilder::new(app)
          .item(&tauri::menu::MenuItemBuilder::with_id("show", "Show Flaxia").build(app)?)
          .item(&tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?)
          .build()?;
        let tray = tray.menu(&menu).build(app)?;

        app.manage(TrayState(Mutex::new(Some(tray))));

        // Background thread: triggers JS poll (tray update is done inside the command)
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          loop {
            std::thread::sleep(std::time::Duration::from_secs(15));
            if let Some(window) = handle.get_webview_window("main") {
              let _ = window.eval("window.__tauriDesktopPoll?.()");
            }
          }
        });
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
