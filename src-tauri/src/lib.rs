use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![])
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

        // Build context menu
        let menu = tauri::menu::MenuBuilder::new(app)
          .item(&tauri::menu::MenuItemBuilder::with_id("show", "Show Flaxia").build(app)?)
          .item(&tauri::menu::MenuItemBuilder::with_id("quit", "Quit").build(app)?)
          .build()?;
        tray.menu(&menu).build(app)?;
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
