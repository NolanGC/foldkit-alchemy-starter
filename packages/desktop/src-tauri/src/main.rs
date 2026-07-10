// The shell is intentionally empty: the whole app (Foldkit UI, auth, chat)
// lives in the webview and talks to the Cloudflare worker over HTTP, exactly
// as the web build does. Native commands/plugins get added here only when a
// capability has no web equivalent.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
