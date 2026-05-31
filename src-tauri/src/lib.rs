use std::sync::Mutex;
use tauri::Manager;

struct TrayState(Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>>);

/// JSの refreshNotificationBadges から呼ばれる: トレイアイコン即時更新
#[tauri::command]
fn set_notification_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
  eprintln!("set_notification_count({})", count);
  if let Some(tray_state) = app.try_state::<TrayState>() {
    let guard = tray_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(tray) = guard.as_ref() {
      let tip = if count > 0 {
        format!("Flaxia ({} unread)", count)
      } else {
        "Flaxia".into()
      };
      let _ = tray.set_tooltip(Some(&tip));

      // Decode base icon, draw red dot in top-right if unread > 0
      let base = include_bytes!("../icons/32x32.png");
      let base_img = tauri::image::Image::from_bytes(base).map_err(|e| e.to_string())?;
      let (w, h) = (base_img.width(), base_img.height());
      let mut rgba = base_img.rgba().to_vec();

      if count > 0 {
        let cx = w as i32 - 8;
        let cy = 8i32;
        let r = 6i32;
        for py in (cy - r)..=cy + r {
          for px in (cx - r)..=cx + r {
            let dx = px - cx;
            let dy = py - cy;
            if dx * dx + dy * dy <= r * r {
              let idx = (py as u32 * w + px as u32) as usize * 4;
              if idx + 3 < rgba.len() {
                rgba[idx] = 255;
                rgba[idx + 1] = 0;
                rgba[idx + 2] = 0;
                rgba[idx + 3] = 255;
              }
            }
          }
        }
      }

      let icon = tauri::image::Image::new_owned(rgba, w, h);
      tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    }
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
            std::thread::sleep(std::time::Duration::from_secs(30));
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
