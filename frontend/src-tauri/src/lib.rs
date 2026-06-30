use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

/// Ports the local stack listens on (must match docker-compose.yml + the frontend's
/// VITE_API_BASE / VITE_TILE_BASE defaults).
const BACKEND_PORT: u16 = 8000; // FastAPI (now a Docker service — Phase 3b)
const DB_PORT: u16 = 1776; // Postgres/PostGIS (compose maps host 1776 -> container 5432)
const TILES_PORT: u16 = 8080; // TileServer GL

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
/// repo layout is present on disk; a relocatable bundled-app path (Stage 2) is future work.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Bring up the ENTIRE local stack (Postgres + TileServer + the FastAPI backend) defined in
/// docker-compose.yml, so the user runs nothing by hand and the app needs no host Python/venv.
/// `up -d` is idempotent and (re)builds the backend image as needed. Requires the Docker daemon.
///
/// Services are left running on exit on purpose: persistent infra (restart: unless-stopped,
/// data volume) shared with other dev work. Returns true if the command ran successfully.
fn start_docker_services() -> bool {
    let root = repo_root();
    match Command::new("docker")
        .args(["compose", "up", "-d"])
        .current_dir(&root)
        .status()
    {
        Ok(status) if status.success() => {
            log::info!("docker compose up -d: local stack (db + tiles + backend) is up");
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

            // Phase 3b: the whole stack — including the now-containerized backend — comes up
            // via Docker. Wait for each service before showing the UI (the frontend fetches
            // with no retry). Backend gets a generous timeout because `up -d` may build its
            // image on first run.
            if start_docker_services() {
                wait_for_port("Postgres", DB_PORT, Duration::from_secs(30));
                wait_for_port("Tiles", TILES_PORT, Duration::from_secs(20));
                wait_for_port("Backend", BACKEND_PORT, Duration::from_secs(60));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
