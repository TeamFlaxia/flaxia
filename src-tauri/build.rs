fn main() {
  tauri_build::build();
  // Allow cfg(target_os = "android") and cfg(target_os = "ios") in lib.rs
  println!("cargo::rustc-check-cfg=cfg(android)");
  println!("cargo::rustc-check-cfg=cfg(ios)");
}
