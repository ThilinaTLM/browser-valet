//! bctl: thin CLI + relay proxy for Browser Bridge (see ../docs/architecture/protocol.md).
//!
//! Env: BCTL_PORT (port), BCTL_SESSION, BCTL_IDLE_TIMEOUT (proxy), BCTL_EXT_WAIT_MS (proxy; test hook),
//! BCTL_CONFIG_DIR (replaces `<config_dir>/browser-bridge`; used by tests).
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
pub fn dir() -> PathBuf {
    match std::env::var_os("BCTL_CONFIG_DIR") {
        Some(d) => d.into(),
        None => dirs::config_dir().unwrap_or_else(|| ".".into()).join("browser-bridge"),
    }
}
pub fn env_port() -> Option<u16> {
    std::env::var("BCTL_PORT").ok()?.parse().ok()
}
/// Port precedence: BCTL_PORT > config.json > default.
pub fn load() -> Option<Config> {
    let v: Value = serde_json::from_slice(&std::fs::read(dir().join("config.json")).ok()?).ok()?;
    let port = env_port()
        .or(v["port"].as_u64().and_then(|p| p.try_into().ok()))
        .unwrap_or(DEFAULT_PORT);
    Some(Config {
        secret: v["secret"].as_str()?.to_string(),
        port,
    })
}
pub fn save(c: &Config) -> Result<()> {
    std::fs::create_dir_all(dir())?;
    let path = dir().join("config.json");
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

fn addr(port: u16) -> SocketAddr {
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

/// Connect as role `cli`; if the proxy runs a different bctl version, restart it from this binary (once).
pub fn connect(c: &Config) -> Result<Ws> {
    let (ws, v) = connect_raw(c)?;
    if v == VERSION {
        return Ok(ws);
    }
    drop(ws);
    eprintln!("bctl: restarting the proxy (v{v} -> v{VERSION})");
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
fn connect_raw(c: &Config) -> Result<(Ws, String)> {
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

/// Start `bctl proxy` detached (log in proxy.log) unless something already accepts connections.
pub fn ensure_proxy(c: &Config) -> Result<()> {
    let up = || TcpStream::connect_timeout(&addr(c.port), Duration::from_millis(500)).is_ok();
    if up() {
        return Ok(());
    }
    std::fs::create_dir_all(dir())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir().join("proxy.log"))?;
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
    bail!("proxy did not start; see {}", dir().join("proxy.log").display())
}

/// Ask a running proxy to exit. Returns false if none was reachable / auth failed.
fn shutdown(c: &Config) -> bool {
    let Ok((mut ws, _)) = connect_raw(c) else { return false };
    let ok = send(&mut ws, json!({"t":"shutdown"})).is_ok() && recv(&mut ws).is_ok();
    std::thread::sleep(Duration::from_millis(200)); // let it release the port
    ok
}

fn paired() -> Config {
    load().unwrap_or_else(|| {
        eprintln!("Not paired. Run `bctl setup` to install the browser extension and pair.");
        std::process::exit(1)
    })
}

const HELP: &str = "bctl local commands:
  setup [--browser chrome|edge|brave|chromium] [--no-open] [--no-wait]
                             install the browser extension (load it once) and pair automatically
  skills [list]              list agent skills; `skills get core` prints the usage guide (read it first!)
  skills get <name> [--full] [--ref <ref>]   print a skill (+ all / one reference)
  skills path [name]         write skills to the config dir and print the path
  skills install [--dir D]   install a stub `bctl` skill for Claude Code / other agents
  pair <secret> [--port N]   pair manually with a code (normally `setup` does this)
  unpair                     forget the secret and stop the proxy
  status [--json]            show proxy and extension connection
  proxy [--idle-timeout S] [--port N]   run the relay in the foreground
  stop                       stop the background proxy
  version                    print version
All other commands are forwarded to the browser extension.
New here? Run `bctl skills get core`.";

fn forward(argv: Vec<String>) -> Result<i32> {
    let helpish = matches!(argv.first().map(String::as_str), None | Some("help" | "--help" | "-h"));
    if helpish && load().is_none() {
        println!("{HELP}\n\nNot paired. Run `bctl setup` to install the browser extension and pair.");
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
        "session": std::env::var("BCTL_SESSION").unwrap_or_else(|_| "default".into()),
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
            Some("res") => return finish(&m["res"]),
            Some("error") => bail!("{}", m["error"].as_str().unwrap_or("proxy error")),
            _ => {}
        }
    }
}

fn finish(res: &Value) -> Result<i32> {
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
                    "note:      extension v{ver} differs from the version bundled with this bctl (v{emb}); {}",
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
                .context("usage: bctl pair <secret> [--port N]")?
                .clone();
            // Pairing codes are 32 random bytes, base64url (43 chars); reject anything else early.
            if secret.len() < 32
                || !secret
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                bail!("that doesn't look like a pairing code; copy it from the Browser Bridge extension popup");
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
            println!("Paired. Run `bctl status` to check the connection.");
            if !stopped && TcpStream::connect_timeout(&addr(port), Duration::from_millis(300)).is_ok() {
                println!("Note: a proxy with the previous secret is still running; run `bctl stop` or wait for it to exit when idle.");
            }
            Ok(0)
        }
        Some("unpair") => {
            if let Some(c) = load() {
                shutdown(&c);
            }
            let _ = std::fs::remove_file(dir().join("config.json"));
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
        Some("status") => status(args.iter().any(|a| a == "--json")),
        Some("proxy") => {
            let c = paired();
            let idle = flag(&args, "--idle-timeout").or_else(|| std::env::var("BCTL_IDLE_TIMEOUT").ok());
            let idle = idle.map_or(Ok(600), |s| s.parse()).context("invalid idle timeout")?;
            let port = flag(&args, "--port")
                .map_or(Ok(c.port), |p| p.parse())
                .context("invalid --port")?;
            proxy::run(c.secret, port, idle)?;
            Ok(0)
        }
        Some("version" | "--version") => {
            println!("bctl {VERSION}");
            Ok(0)
        }
        _ => forward(args),
    }
}

fn main() {
    match local(std::env::args().skip(1).collect()) {
        Ok(code) => std::process::exit(code),
        Err(e) => {
            eprintln!("bctl: {e:#}");
            std::process::exit(1)
        }
    }
}
