use std::sync::Mutex;
use tauri::Manager;
use tauri::tray::TrayIconId;

struct TrayState(Mutex<TrayIconId>);

#[tauri::command]
fn set_tray_badge(app: tauri::AppHandle, has_unread: bool) -> Result<(), String> {
  let state = app.state::<TrayState>();
  let tray_id = state.0.lock().map_err(|e| e.to_string())?.clone();

  let icon_data: &[u8] = if has_unread {
    &include_bytes!("../icons/32x32-badge.png")[..]
  } else {
    &include_bytes!("../icons/32x32.png")[..]
  };
  let icon = tauri::image::Image::from_bytes(icon_data).map_err(|e| e.to_string())?;

  if let Some(tray) = app.tray_by_id(&tray_id) {
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![set_tray_badge])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Desktop background notification polling
      // Keeps the webview alive and checking notifications even when minimized to tray
      #[cfg(desktop)]
      {
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

      // Build system tray (desktop only)
      #[cfg(desktop)]
      {
        use tauri::tray::{TrayIconBuilder, MouseButton, MouseButtonState};

        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
          .expect("Failed to load tray icon");
        let tray_id: TrayIconId = "main-tray".into();

        let tray = TrayIconBuilder::new()
          .id(tray_id.clone())
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

        // Build context menu
        let menu = tauri::menu::MenuBuilder::new(app)
          .item(&tauri::menu::MenuItemBuilder::with_id("show", "Show Flaxia").build(app)?)
          .item(&tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?)
          .build()?;
        tray.menu(&menu).build(app)?;

        // Store tray ID for badge updates
        app.manage(TrayState(Mutex::new(tray_id)));
      }

      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
