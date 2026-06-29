use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// Port the FastAPI backend listens on (matches the frontend's VITE_API_BASE default).
const BACKEND_PORT: u16 = 8000;

/// Holds the FastAPI backend child process so we can stop it when the app exits.
/// `None` means we did not start it (it was already running, or the spawn failed),
/// in which case we must NOT kill it on exit — we did not own it.
struct Backend(Mutex<Option<Child>>);

/// True if something is already listening on the backend port.
fn backend_already_running() -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, BACKEND_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Path to the backend directory, resolved relative to this crate
/// (frontend/src-tauri -> ../../backend). This assumes the repo layout is present on
/// disk; bundling a standalone binary with an embedded Python is a later phase.
fn backend_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("backend")
}

/// Start the FastAPI backend as a child process, unless one is already listening.
/// Returns the child only if WE started it.
fn spawn_backend() -> Option<Child> {
    if backend_already_running() {
        log::info!("Backend already listening on :{BACKEND_PORT} — using the existing one");
        return None;
    }

    let dir = backend_dir();
    // Invoke the venv's Python directly (not `uv run`) so the spawned process IS uvicorn:
    // that makes it a single child we can cleanly kill on exit, with no PATH lookup.
    let python = dir.join(".venv").join("bin").join("python");

    match Command::new(&python)
        .args([
            "-m",
            "uvicorn",
            "prospector.main:app",
            "--port",
            &BACKEND_PORT.to_string(),
        ])
        .current_dir(&dir)
        .spawn()
    {
        Ok(child) => {
            log::info!(
                "Started FastAPI backend (pid {}) via {}",
                child.id(),
                python.display()
            );
            Some(child)
        }
        Err(e) => {
            log::error!("Failed to start backend via {}: {e}", python.display());
            None
        }
    }
}

/// Block until the backend answers on its port, or `timeout` elapses. The frontend
/// fetches with no retry, so we wait here to avoid a "could not load" flash on first paint.
fn wait_until_ready(timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if backend_already_running() {
            log::info!("Backend is ready on :{BACKEND_PORT}");
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    log::warn!("Backend not ready after {timeout:?}; loading UI anyway");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Phase 2: auto-start the local FastAPI backend so the user never runs uvicorn
            // by hand. (Tiles + Postgres still come from `docker compose up -d` — Phase 3.)
            let child = spawn_backend();
            if child.is_some() {
                wait_until_ready(Duration::from_secs(15));
            }
            app.manage(Backend(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Stop the backend we started when the app is closing.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(backend) = app_handle.try_state::<Backend>() {
                    if let Some(mut child) = backend.0.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                        log::info!("Stopped FastAPI backend on exit");
                    }
                }
            }
        });
}
