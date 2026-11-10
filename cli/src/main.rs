//! bvl: thin CLI + relay proxy for Browser Valet (see ../docs/architecture/protocol.md).
//!
//! Env: BVL_PORT (port), BVL_SESSION, BVL_IDLE_TIMEOUT (proxy), BVL_EXT_WAIT_MS (proxy; test hook),
//! BVL_CONFIG_DIR (replaces `<config_dir>/browser-valet`), BVL_DATA_DIR (replaces the data and state dirs;
//! defaults to BVL_CONFIG_DIR when only that is set, so tests stay isolated).
mod doctor;
mod embed;
mod proxy;
mod setup;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_PORT: u16 = 47823;
const TIMEOUT: Duration = Duration::from_secs(600);
pub type Ws = WebSocket<TcpStream>;

fn hmac(secret: &str, msg: &str) -> Hmac<Sha256> {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes()).expect("any key length");
    m.update(msg.as_bytes());
    m
}
pub fn mac(secret: &str, msg: &str) -> String {
    hex::encode(hmac(secret, msg).finalize().into_bytes())
}
/// Constant-time MAC check.
pub fn verify(secret: &str, msg: &str, tag: &str) -> bool {
    hex::decode(tag).is_ok_and(|t| hmac(secret, msg).verify_slice(&t).is_ok())
}
pub fn nonce() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("os randomness");
    hex::encode(b)
}
pub fn log(msg: &str) {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    eprintln!("[{t}] {msg}");
}

// ---- config ----

pub struct Config {
    pub secret: String,
    pub port: u16,
}
fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|d| !d.is_empty()).map(PathBuf::from)
}
fn app_dir(base: Option<PathBuf>) -> PathBuf {
    base.unwrap_or_else(|| ".".into()).join("browser-valet")
}
/// Settings: `config.json` (`dirs::config_dir()`).
pub fn config_dir() -> PathBuf {
    env_dir("BVL_CONFIG_DIR").unwrap_or_else(|| app_dir(dirs::config_dir()))
}
fn data_override() -> Option<PathBuf> {
    env_dir("BVL_DATA_DIR").or_else(|| env_dir("BVL_CONFIG_DIR"))
}
/// Generated files: the managed extension folder and skills (`dirs::data_local_dir()`: Local, not
/// Roaming, on Windows, because the browser loads the folder from this machine).
pub fn data_dir() -> PathBuf {
    data_override().unwrap_or_else(|| app_dir(dirs::data_local_dir()))
}
/// Logs: `proxy.log` (`$XDG_STATE_HOME` on Linux, the data dir elsewhere).
pub fn state_dir() -> PathBuf {
    data_override().unwrap_or_else(|| app_dir(dirs::state_dir().or_else(dirs::data_local_dir)))
}
pub fn log_path() -> PathBuf {
    state_dir().join("proxy.log")
}
pub fn env_port() -> Option<u16> {
    std::env::var("BVL_PORT").ok()?.parse().ok()
}
/// Port precedence: BVL_PORT > config.json > default.
pub fn load() -> Option<Config> {
    let v: Value = serde_json::from_slice(&std::fs::read(config_dir().join("config.json")).ok()?).ok()?;
    let port = env_port()
        .or(v["port"].as_u64().and_then(|p| p.try_into().ok()))
        .unwrap_or(DEFAULT_PORT);
    Some(Config {
        secret: v["secret"].as_str()?.to_string(),
        port,
    })
}
pub fn save(c: &Config) -> Result<()> {
    std::fs::create_dir_all(config_dir())?;
    let path = config_dir().join("config.json");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(&path)?
        .write_all(json!({"secret":c.secret,"port":c.port}).to_string().as_bytes())?;
    #[cfg(unix)]
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(())
}

// ---- client ----

pub(crate) fn addr(port: u16) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], port))
}
pub fn recv(ws: &mut Ws) -> Result<Value> {
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => return Ok(serde_json::from_str(t.as_str())?),
            Ok(Message::Close(_)) => bail!("connection closed by proxy"),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                bail!("timed out waiting for the proxy")
            }
            Err(e) => bail!("connection error: {e}"),
        }
    }
}
pub fn send(ws: &mut Ws, v: Value) -> Result<()> {
    Ok(ws.send(Message::text(v.to_string()))?)
}

/// Connect as role `cli`; if the proxy runs a different bvl version and is idle, restart it from this binary (once).
pub fn connect(c: &Config) -> Result<Ws> {
    let (ws, v) = connect_raw(c)?;
    if v == VERSION {
        return Ok(ws);
    }
    // Never kill a proxy that is serving requests (possibly for another bvl version): report instead.
    let mut ws = ws;
    if send(&mut ws, json!({"t":"status"})).is_ok() {
        let busy = recv(&mut ws).map_or(0, |s| s["proxy"]["pending"].as_u64().unwrap_or(0));
        if busy > 0 {
            bail!(
                "the running proxy (v{v}) is busy with {busy} request(s), and this bvl is v{VERSION}; not restarting it. \
                 Wait for them to finish or run `bvl stop`, and use one bvl version at a time"
            );
        }
    }
    drop(ws);
    eprintln!("bvl: restarting the proxy (v{v} -> v{VERSION})");
    if !shutdown(c) {
        return Ok(connect_raw(c)?.0);
    }
    for _ in 0..20 {
        if TcpStream::connect_timeout(&addr(c.port), Duration::from_millis(200)).is_err() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    ensure_proxy(c)?;
    Ok(connect_raw(c)?.0)
}

/// Connect and mutually authenticate as role `cli`; also returns the proxy's version.
pub(crate) fn connect_raw(c: &Config) -> Result<(Ws, String)> {
    let s = TcpStream::connect_timeout(&addr(c.port), Duration::from_secs(3))?;
    s.set_read_timeout(Some(Duration::from_secs(10)))?;
    let (mut ws, _) = tungstenite::client(format!("ws://127.0.0.1:{}/", c.port), s)
        .map_err(|e| anyhow!("websocket handshake failed: {e}"))?;
    let np = recv(&mut ws)?["nonce"].as_str().context("bad challenge")?.to_string();
    let nc = nonce();
    let m = mac(&c.secret, &format!("bctl1|client|cli|{np}|{nc}"));
    send(
        &mut ws,
        json!({"t":"auth","role":"cli","nonce":nc,"mac":m,"version":VERSION}),
    )?;
    let w = recv(&mut ws)?;
    match w["t"].as_str() {
        Some("welcome")
            if verify(
                &c.secret,
                &format!("bctl1|server|cli|{nc}|{np}"),
                w["mac"].as_str().unwrap_or(""),
            ) =>
        {
            Ok((ws, w["version"].as_str().unwrap_or("").to_string()))
        }
        Some("welcome") => bail!(
            "server authentication failed: bad welcome MAC (is something else listening on port {}?)",
            c.port
        ),
        Some("error") => bail!("{}", w["error"].as_str().unwrap_or("proxy error")),
        _ => bail!("unexpected reply from proxy"),
    }
}

/// Start `bvl proxy` detached (log in proxy.log) unless something already accepts connections.
pub fn ensure_proxy(c: &Config) -> Result<()> {
    let up = || TcpStream::connect_timeout(&addr(c.port), Duration::from_millis(500)).is_ok();
    if up() {
        return Ok(());
    }
    std::fs::create_dir_all(state_dir())?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(log_path())?;
    let mut cmd = std::process::Command::new(std::env::current_exe()?);
    cmd.arg("proxy")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    cmd.spawn().context("starting proxy")?;
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if up() {
            return Ok(());
        }
    }
    bail!("proxy did not start; see {}", log_path().display())
}

/// Ask a running proxy to exit. Returns false if none was reachable / auth failed.
pub(crate) fn shutdown(c: &Config) -> bool {
    let Ok((mut ws, _)) = connect_raw(c) else { return false };
    let ok = send(&mut ws, json!({"t":"shutdown"})).is_ok() && recv(&mut ws).is_ok();
    std::thread::sleep(Duration::from_millis(200)); // let it release the port
    ok
}

fn paired() -> Config {
    load().unwrap_or_else(|| {
        eprintln!("Not paired. Run `bvl setup` to install the browser extension and pair.");
        std::process::exit(1)
    })
}

const HELP: &str = "bvl local commands:
  setup [--browser chrome|edge|brave|chromium] [--no-open] [--no-wait]
                             install the browser extension (load it once) and pair automatically
  skills [list]              list agent skills; `skills get core` prints the usage guide (read it first!)
  skills get <name> [--full] [--ref <ref>]   print a skill (+ all / one reference)
  skills path [name]         write skills to the config dir and print the path
  skills install [--dir D]   install a stub `bvl` skill for Claude Code / other agents
  pair <secret> [--port N]   pair manually with a code (normally `setup` does this)
  unpair                     forget the secret and stop the proxy
  status [--json]            show proxy and extension connection
  doctor [--json] [--quick] [--fix]   diagnose config, extension folder, proxy, extension, round trip
  proxy [--idle-timeout S] [--port N]   run the relay in the foreground
  stop                       stop the background proxy
  version                    print version
All other commands are forwarded to the browser extension.
New here? Run `bvl skills get core`.";

/// The `--json` error envelope for failures that happen before the extension answers
/// (same shape as the extension's, see automation.md).
fn json_error(msg: &str, code: &str) -> String {
    json!({"success": false, "data": null, "error": msg, "code": code}).to_string()
}

fn forward(argv: Vec<String>) -> Result<i32> {
    let json_out = argv.iter().any(|a| a == "--json");
    if json_out && load().is_none() {
        println!(
            "{}",
            json_error(
                "Not paired. Run `bvl setup` to install the browser extension and pair.",
                "not_paired"
            )
        );
        return Ok(1);
    }
    match forward_inner(argv) {
        Err(e) if json_out => {
            println!("{}", json_error(&format!("{e:#}"), "not_connected"));
            Ok(1)
        }
        r => r,
    }
}

fn forward_inner(argv: Vec<String>) -> Result<i32> {
    let json_out = argv.iter().any(|a| a == "--json");
    let helpish = matches!(argv.first().map(String::as_str), None | Some("help" | "--help" | "-h"));
    if helpish && load().is_none() {
        println!("{HELP}\n\nNot paired. Run `bvl setup` to install the browser extension and pair.");
        return Ok(1);
    }
    let c = paired();
    let stdin = if argv.iter().any(|a| a == "--stdin") {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s)?;
        Some(s)
    } else {
        None
    };
    let mut ws = match ensure_proxy(&c).and_then(|_| connect(&c)) {
        Ok(ws) => ws,
        Err(e) if helpish => {
            println!("{HELP}\n\nCould not reach the extension: {e:#}");
            return Ok(1);
        }
        Err(e) => return Err(e),
    };
    let mut req = json!({
        "argv": argv,
        "cwd": std::env::current_dir()?.to_string_lossy(),
        "tmp": std::env::temp_dir().to_string_lossy(),
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "platform": match std::env::consts::OS { "macos" => "macos", "windows" => "windows", _ => "linux" },
        "session": std::env::var("BVL_SESSION").unwrap_or_else(|_| "default".into()),
    });
    if let Some(s) = stdin {
        req["stdin"] = s.into();
    }
    send(&mut ws, json!({"t":"req","req":req}))?;
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let left = deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1));
        ws.get_ref().set_read_timeout(Some(left))?;
        let m = recv(&mut ws)?;
        match m["t"].as_str() {
            Some("event") => eprint!("{}", m["stderr"].as_str().unwrap_or("")),
            Some("res") => return finish(&m["res"], json_out),
            Some("error") => bail!("{}", m["error"].as_str().unwrap_or("proxy error")),
            _ => {}
        }
    }
}

fn finish(res: &Value, json_out: bool) -> Result<i32> {
    let mut code = res["exitCode"].as_i64().unwrap_or(0) as i32;
    for f in res["files"].as_array().into_iter().flatten() {
        let path = PathBuf::from(f["path"].as_str().unwrap_or(""));
        let write = || -> Result<()> {
            let data = base64::engine::general_purpose::STANDARD.decode(f["base64"].as_str().unwrap_or(""))?;
            if let Some(p) = path.parent() {
                std::fs::create_dir_all(p)?;
            }
            Ok(std::fs::write(&path, data)?)
        };
        if let Err(e) = write() {
            eprintln!("failed to write {}: {e}", path.display());
            code = if code == 0 { 1 } else { code };
        }
    }
    let mut o = std::io::stdout();
    // The proxy answers for an unreachable extension with a bare message; keep `--json` parseable.
    if res["code"].as_str().is_some() && res["stdout"].as_str().unwrap_or("").is_empty() && json_out {
        let msg = res["stderr"].as_str().unwrap_or("").trim_end();
        writeln!(
            o,
            "{}",
            json_error(msg, res["code"].as_str().unwrap_or("not_connected"))
        )?;
        o.flush()?;
        return Ok(code);
    }
    o.write_all(res["stdout"].as_str().unwrap_or("").as_bytes())?;
    o.flush()?;
    eprint!("{}", res["stderr"].as_str().unwrap_or(""));
    Ok(code)
}

fn status(json_out: bool) -> Result<i32> {
    let c = paired();
    ensure_proxy(&c)?;
    let mut ws = connect(&c)?;
    send(&mut ws, json!({"t":"status"}))?;
    let v = recv(&mut ws)?;
    if json_out {
        println!("{v}");
        return Ok(0);
    }
    let p = &v["proxy"];
    let idle = match p["idleTimeoutSecs"].as_u64() {
        Some(0) | None => "disabled".to_string(),
        Some(s) => format!("{s}s"),
    };
    println!(
        "proxy:     v{}, pid {}, port {}, idle timeout {idle}",
        p["version"].as_str().unwrap_or("?"),
        p["pid"],
        p["port"]
    );
    match v["ext"].as_object() {
        Some(e) => {
            let ver = e.get("extVersion").and_then(Value::as_str).unwrap_or("?");
            let managed = e.get("managed").and_then(Value::as_bool).unwrap_or(false);
            println!(
                "extension: {} (extension v{ver})",
                e.get("browser").and_then(Value::as_str).unwrap_or("unknown browser"),
            );
            println!("managed:   {}", if managed { "yes" } else { "no" });
            if let Some(emb) = embed::EMBEDDED_EXT_VERSION.filter(|emb| *emb != ver) {
                println!(
                    "note:      extension v{ver} differs from the version bundled with this bvl (v{emb}); {}",
                    if managed {
                        "it will update automatically"
                    } else {
                        "reload the unpacked extension / rebuild it"
                    }
                );
            }
        }
        None => println!("extension: not connected"),
    }
    Ok(0)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn local(args: Vec<String>) -> Result<i32> {
    match args.first().map(String::as_str) {
        Some("pair") => {
            let secret = args
                .get(1)
                .filter(|s| !s.starts_with("--"))
                .context("usage: bvl pair <secret> [--port N]")?
                .clone();
            // Pairing codes are 32 random bytes, base64url (43 chars); reject anything else early.
            if secret.len() < 32
                || !secret
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                bail!("that doesn't look like a pairing code; copy it from the Browser Valet extension popup");
            }
            let port = match flag(&args, "--port") {
                Some(p) => p.parse().context("invalid --port")?,
                None => env_port().unwrap_or(DEFAULT_PORT),
            };
            // A running proxy keeps the old secret in memory, so ask it to exit first (authenticated with
            // the OLD config). If that fails (no proxy / old secret already wrong) there is nothing to stop
            // or it can't be stopped from here; it will exit on its idle timeout.
            let stopped = load().is_some_and(|old| shutdown(&old));
            if embed::ext_dir().is_dir() {
                embed::write_pairing(&secret, port)?;
            }
            save(&Config { secret, port })?;
            println!("Paired. Run `bvl status` to check the connection.");
            if !stopped && TcpStream::connect_timeout(&addr(port), Duration::from_millis(300)).is_ok() {
                println!("Note: a proxy with the previous secret is still running; run `bvl stop` or wait for it to exit when idle.");
            }
            Ok(0)
        }
        Some("unpair") => {
            if let Some(c) = load() {
                shutdown(&c);
            }
            let _ = std::fs::remove_file(config_dir().join("config.json"));
            let _ = std::fs::remove_file(embed::ext_dir().join(embed::PAIRING));
            println!("Unpaired.");
            Ok(0)
        }
        Some("stop") => {
            println!(
                "{}",
                if load().is_some_and(|c| shutdown(&c)) {
                    "Proxy stopped."
                } else {
                    "Proxy not running."
                }
            );
            Ok(0)
        }
        Some("setup") => setup::run(&args),
        Some("skills") => embed::skills(&args),
        Some("doctor") => doctor::run(&args),
        Some("status") => status(args.iter().any(|a| a == "--json")),
        Some("proxy") => {
            let c = paired();
            let idle = flag(&args, "--idle-timeout").or_else(|| std::env::var("BVL_IDLE_TIMEOUT").ok());
            let idle = idle.map_or(Ok(600), |s| s.parse()).context("invalid idle timeout")?;
            let port = flag(&args, "--port")
                .map_or(Ok(c.port), |p| p.parse())
                .context("invalid --port")?;
            proxy::run(c.secret, port, idle)?;
            Ok(0)
        }
        Some("version" | "--version") => {
            println!("bvl {VERSION}");
            Ok(0)
        }
        _ => forward(args),
    }
}

fn main() {
    match local(std::env::args().skip(1).collect()) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("bvl: {e:#}");
            std::process::exit(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_error_has_the_extension_envelope() {
        let v: Value = serde_json::from_str(&json_error("boom", "not_connected")).unwrap();
        assert_eq!(
            v,
            json!({"success": false, "data": null, "error": "boom", "code": "not_connected"})
        );
    }
}
