use std::io::{Read, Write};
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

/// True if a plain HTTP GET to localhost:port`path` returns 200. Used for backend
/// readiness: an open TCP port only means uvicorn bound the socket, NOT that it's
/// answering yet — gating on a real 200 avoids the cold-start race where the UI loads
/// and fires its (no-retry) layer fetches before the backend actually serves.
fn http_ok(port: u16, path: &str) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    // HTTP/1.0 + Connection: close so the server closes the socket after replying.
    let req = format!("GET {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    // Status line looks like "HTTP/1.1 200 OK".
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/") && head.contains(" 200")
}

/// Block until an HTTP GET to `path` returns 200 (the service is actually serving), or
/// `timeout` elapses.
fn wait_for_http(label: &str, port: u16, path: &str, timeout: Duration) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if http_ok(port, path) {
            log::info!("{label} serving on :{port}{path}");
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    log::warn!("{label} not serving :{port}{path} after {timeout:?}; continuing anyway");
}

/// Repo root, resolved relative to this crate (frontend/src-tauri -> ../..). Assumes the
/// repo layout is present on disk; a relocatable bundled-app path (Stage 2) is future work.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Absolute path to the `docker` CLI. A Finder-launched .app inherits a minimal PATH that
/// usually omits Homebrew's /opt/homebrew/bin (and /usr/local/bin), so a bare "docker" isn't
/// found — the stack would silently fail to start. Probe the common install locations first,
/// then fall back to "docker" (found when launched from a terminal).
fn docker_bin() -> String {
    for p in ["/opt/homebrew/bin/docker", "/usr/local/bin/docker", "/usr/bin/docker"] {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    "docker".to_string()
}

/// PATH for the docker child process: prepend the common CLI dirs so docker's own lookups
/// (the compose plugin, credential helpers) resolve even under a minimal GUI PATH.
fn docker_path_env() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{inherited}")
}

/// Bring up the ENTIRE local stack (Postgres + TileServer + the FastAPI backend) defined in
/// docker-compose.yml, so the user runs nothing by hand and the app needs no host Python/venv.
/// `up -d` is idempotent and (re)builds the backend image as needed. Requires the Docker daemon.
///
/// Services are left running on exit on purpose: persistent infra (restart: unless-stopped,
/// data volume) shared with other dev work. Returns true if the command ran successfully.
fn start_docker_services() -> bool {
    let root = repo_root();
    match Command::new(docker_bin())
        .args(["compose", "up", "-d"])
        .current_dir(&root)
        .env("PATH", docker_path_env())
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
                // Gate on a real 200 (not just the open port): on a cold start uvicorn
                // binds :8000 before it can answer, and the frontend's layer fetches have
                // no retry — so wait until /health actually responds, or the map loads empty.
                wait_for_http("Backend", BACKEND_PORT, "/health", Duration::from_secs(90));
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
