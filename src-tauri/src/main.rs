// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(output) = std::env::args().find_map(|arg| arg.strip_prefix("--data-self-test=").map(str::to_owned)) {
        std::process::exit(match history_clipboard_lib::data_self_test(output) {
            Ok(()) => 0,
            Err(_) => 1,
        });
    }
    history_clipboard_lib::run();
}
