use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// Ports the local stack listens on (must match docker-compose.yml + the frontend's
/// VITE_API_BASE / VITE_TILE_BASE defaults).
const BACKEND_PORT: u16 = 8000; // FastAPI
const DB_PORT: u16 = 1776; // Postgres/PostGIS (compose maps host 1776 -> container 5432)
const TILES_PORT: u16 = 8080; // TileServer GL

/// Holds the FastAPI backend child process so we can stop it when the app exits.
/// `None` means we did not start it (it was already running, or the spawn failed),
/// in which case we must NOT kill it on exit — we did not own it.
struct Backend(Mutex<Option<Child>>);

/// True if something is already listening on `port` on localhost.
fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Block until `port` accepts a connection, or `timeout` elapses.
fn wait_for_port(label: &str, port: u16, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if port_open(port) {
            log::info!("{label} ready on :{port}");
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    log::warn!("{label} not ready on :{port} after {timeout:?}; continuing anyway");
}

/// Repo root, resolved relative to this crate (frontend/src-tauri -> ../..). Assumes the
/// repo layout is present on disk; packaging a standalone app is a later phase.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn backend_dir() -> PathBuf {
    repo_root().join("backend")
}

/// Bring up the local Docker stack (Postgres + TileServer) defined in docker-compose.yml,
/// so the user does not run `docker compose up -d` by hand. `up -d` is idempotent, so this
/// is safe whether or not the containers are already running. Requires the Docker daemon.
///
/// We intentionally do NOT stop these on exit: they are persistent infra
/// (restart: unless-stopped, with a data volume) shared with other dev work.
///
/// Returns true if the `docker compose up -d` command ran successfully.
fn start_docker_services() -> bool {
    let root = repo_root();
    match Command::new("docker")
        .args(["compose", "up", "-d"])
        .current_dir(&root)
        .status()
    {
        Ok(status) if status.success() => {
            log::info!("docker compose up -d: local services are up");
            true
        }
        Ok(status) => {
            log::error!(
                "docker compose up -d exited with {status} — is the Docker daemon running?"
            );
            false
        }
        Err(e) => {
            log::error!("Could not run `docker compose` ({e}) — is Docker installed and on PATH?");
            false
        }
    }
}

/// Start the FastAPI backend as a child process, unless one is already listening.
/// Returns the child only if WE started it.
fn spawn_backend() -> Option<Child> {
    if port_open(BACKEND_PORT) {
        log::info!("Backend already listening on :{BACKEND_PORT} — using the existing one");
        return None;
    }

    let dir = backend_dir();
    // Invoke the venv's Python directly (not `uv run`) so the spawned process IS uvicorn:
    // a single child we can cleanly kill on exit, with no PATH lookup.
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

            // Phase 3a: bring up the Docker stack (Postgres + tiles) first, and wait for
            // it — the backend needs the database. Only wait if Docker actually started;
            // a stopped daemon should not freeze the window on dead ports.
            if start_docker_services() {
                wait_for_port("Postgres", DB_PORT, Duration::from_secs(30));
                wait_for_port("Tiles", TILES_PORT, Duration::from_secs(20));
            }

            // Phase 2: auto-start the FastAPI backend. Wait for it before showing the UI,
            // because the frontend fetches with no retry and would flash "could not load".
            let child = spawn_backend();
            if child.is_some() {
                wait_for_port("Backend", BACKEND_PORT, Duration::from_secs(15));
            }
            app.manage(Backend(Mutex::new(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Stop the backend we started when the app is closing. (Docker services are
            // left running on purpose — see start_docker_services.)
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
