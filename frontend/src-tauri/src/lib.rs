use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Ports the local stack listens on (must match docker-compose.yml + the frontend's
/// VITE_API_BASE / VITE_TILE_BASE defaults).
const BACKEND_PORT: u16 = 8000; // FastAPI (now a Docker service — Phase 3b)
const DB_PORT: u16 = 1776; // Postgres/PostGIS (compose maps host 1776 -> container 5432)
const TILES_PORT: u16 = 8080; // TileServer GL

/// The images the distributable ships, paired with their bundled tarball filenames.
/// Used only in packaged mode (first-run `docker load`); dev builds these via compose.
const BUNDLE_IMAGES: [(&str, &str); 3] = [
    ("prospector-db:local", "db.tar.gz"),
    ("prospector-backend:local", "backend.tar.gz"),
    ("maptiler/tileserver-gl:latest", "tileserver.tar.gz"),
];

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

/// Repo root, resolved relative to this crate (frontend/src-tauri -> ../..). The DEV
/// stack directory (build-based docker-compose.yml + live source). The packaged app
/// uses the bundled copy instead — see `stack_dir`.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// The directory the stack is launched from — the one holding docker-compose.yml.
///   * Packaged app (release): `<Resources>/bundle` (the self-contained offline bundle),
///     detected by its compose file being present.
///   * Dev (debug): the repo root (build-based compose + live source tree).
///
/// Gated on a release build rather than merely "does bundle/ exist", because Tauri also
/// stages resources into `target/<profile>/bundle/` next to the binary. Under `tauri dev`
/// that copy would otherwise be found and dev would wrongly switch onto the dist compose
/// (`pull_policy: never`, no `build:`) instead of the live repo compose.
fn stack_dir(app: &tauri::App) -> PathBuf {
    if !cfg!(debug_assertions) {
        if let Ok(res) = app.path().resource_dir() {
            let bundled = res.join("bundle");
            if bundled.join("docker-compose.yml").exists() {
                return bundled;
            }
        }
    }
    repo_root()
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

/// A docker subcommand run silently (stdout/stderr discarded), returning success only.
fn docker_ok(args: &[&str]) -> bool {
    Command::new(docker_bin())
        .args(args)
        .env("PATH", docker_path_env())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// True if the Docker daemon is reachable (`docker info` succeeds only when it's up).
fn docker_running() -> bool {
    docker_ok(&["info"])
}

/// A native macOS alert (via osascript) — no extra Tauri plugin/deps. Used to tell a
/// fresh-machine user that Docker Desktop is required. Blocks until they click OK.
fn alert(title: &str, message: &str) {
    let script = format!(
        "display dialog \"{}\" with title \"{}\" buttons {{\"OK\"}} default button \"OK\" with icon caution",
        message.replace('\\', "\\\\").replace('"', "\\\""),
        title.replace('\\', "\\\\").replace('"', "\\\""),
    );
    let _ = Command::new("osascript").args(["-e", &script]).status();
}

/// A non-blocking macOS notification (via osascript) — used to reassure the user during
/// the one-time first-run image load, which otherwise looks like a hang.
fn notify(message: &str) {
    let script = format!(
        "display notification \"{}\" with title \"Prospector's Compass\"",
        message.replace('\\', "\\\\").replace('"', "\\\""),
    );
    let _ = Command::new("osascript").args(["-e", &script]).status();
}

/// First-run provisioning (packaged mode only): `docker load` any bundled image that
/// isn't present yet. Offline — never touches a registry. Idempotent: once an image is
/// loaded it's skipped on every later launch. Returns false if a load fails.
/// In dev there's no `images/` dir, so this is a no-op (compose builds the images).
fn ensure_images_loaded(stack_dir: &Path) -> bool {
    let images_dir = stack_dir.join("images");
    if !images_dir.exists() {
        return true; // dev mode: images are built by `compose up`, not loaded
    }
    let mut announced = false;
    for (image, file) in BUNDLE_IMAGES {
        if docker_ok(&["image", "inspect", image]) {
            continue; // already loaded
        }
        if !announced {
            notify("First-time setup: loading data (this takes a minute or two)…");
            announced = true;
        }
        let tar = images_dir.join(file);
        log::info!("docker load -i {}", tar.display());
        let ok = Command::new(docker_bin())
            .args(["load", "-i"])
            .arg(&tar)
            .env("PATH", docker_path_env())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            log::error!("docker load failed for {}", tar.display());
            return false;
        }
    }
    true
}

/// Bring up the ENTIRE local stack (Postgres + TileServer + the FastAPI backend) defined in
/// `stack_dir`'s docker-compose.yml, so the user runs nothing by hand. `up -d` is idempotent.
/// Requires the Docker daemon. On first run against an empty data volume, Postgres restores
/// the bundled seed DB automatically.
///
/// Services are left running on exit on purpose (restart: unless-stopped + persistent data
/// volume). Returns true if the command ran successfully.
fn start_docker_services(stack_dir: &Path) -> bool {
    match Command::new(docker_bin())
        .args(["compose", "up", "-d"])
        .current_dir(stack_dir)
        .env("PATH", docker_path_env())
        .status()
    {
        Ok(status) if status.success() => {
            log::info!("docker compose up -d: local stack (db + tiles + backend) is up");
            true
        }
        Ok(status) => {
            log::error!("docker compose up -d exited with {status} — is the Docker daemon running?");
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

            let dir = stack_dir(app);
            log::info!("stack dir: {}", dir.display());

            // Docker is the one hard prerequisite on the target machine. If it isn't
            // running, tell the user plainly (native alert) rather than opening to a
            // broken, empty map. We still continue so the window opens; once they start
            // Docker and relaunch, provisioning proceeds normally.
            if !docker_running() {
                alert(
                    "Docker Desktop is required",
                    "Prospector's Compass runs its map data in Docker.\n\nInstall Docker Desktop from docker.com (one-time), make sure it's running, then reopen this app.",
                );
            } else {
                // Packaged first run: load the bundled images once (offline). Then bring
                // the stack up. On first run Postgres restores the seed DB, so give it a
                // longer window; the backend image may also be booting for the first time.
                if ensure_images_loaded(&dir) && start_docker_services(&dir) {
                    wait_for_port("Postgres", DB_PORT, Duration::from_secs(90));
                    wait_for_port("Tiles", TILES_PORT, Duration::from_secs(20));
                    // Gate on a real 200 (not just the open port): on a cold start uvicorn
                    // binds :8000 before it can answer, and the frontend's layer fetches have
                    // no retry — so wait until /health actually responds, or the map loads empty.
                    wait_for_http("Backend", BACKEND_PORT, "/health", Duration::from_secs(120));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
