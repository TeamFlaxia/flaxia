use open::that;
use tauri::{Runtime, plugin::{Builder as PluginBuilder, TauriPlugin}};

fn external_nav_plugin<R: Runtime>() -> TauriPlugin<R> {
  PluginBuilder::new("flaxia")
    .on_navigation(|_webview, url| {
      if url.scheme() == "http" || url.scheme() == "https" {
        let host = url.host_str().unwrap_or("");
        let allowed = [
          "127.0.0.1",
          "localhost",
          "flaxia.app",
          "sandbox.flaxia.app",
        ];
        if !allowed.contains(&host) {
          let _ = that(url.as_str());
          return false;
        }
      }
      true
    })
    .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(external_nav_plugin())
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
