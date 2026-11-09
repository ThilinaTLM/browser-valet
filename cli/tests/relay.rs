//! Integration tests: run `bctl proxy` as a child process (temp BCTL_CONFIG_DIR, free port) and talk to it
//! with fake extension / CLI clients.
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::net::TcpStream;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
use tungstenite::{client::IntoClientRequest, Message, WebSocket};

const SECRET: &str = "test-secret";
const EXT_ORIGIN: &str = "chrome-extension://fekhggniifjffgnkljlblgfcoolaonbm";
type Ws = WebSocket<TcpStream>;

struct Proxy {
    child: Child,
    port: u16,
    dir: std::path::PathBuf,
}
impl Drop for Proxy {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

#[allow(clippy::zombie_processes)]
fn start(extra: &[&str]) -> Proxy {
    // Picking a free port is racy across parallel tests: retry if our proxy died (e.g. port taken).
    for _ in 0..5 {
        if let Some(p) = try_start(extra) {
            return p;
        }
    }
    panic!("proxy did not start");
}

#[allow(clippy::zombie_processes)]
fn try_start(extra: &[&str]) -> Option<Proxy> {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let dir = std::env::temp_dir().join(format!("bctl-test-{}-{port}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.json"),
        json!({"secret":SECRET,"port":port}).to_string(),
    )
    .unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_bctl"))
        .arg("proxy")
        .args(extra)
        .env("BCTL_CONFIG_DIR", &dir)
        .env("BCTL_EXT_WAIT_MS", "400")
        .env_remove("BCTL_PORT")
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut p = Proxy { child, port, dir };
    for _ in 0..100 {
        if p.child.try_wait().unwrap().is_some() {
            return None;
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            std::thread::sleep(Duration::from_millis(30));
            if p.child.try_wait().unwrap().is_none() {
                return Some(p);
            }
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn mac(msg: &str) -> String {
    let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(SECRET.as_bytes()).unwrap();
    m.update(msg.as_bytes());
    hex::encode(m.finalize().into_bytes())
}
fn recv(ws: &mut Ws) -> Value {
    loop {
        if let Message::Text(t) = ws.read().expect("read") {
            return serde_json::from_str(t.as_str()).unwrap();
        }
    }
}
fn send(ws: &mut Ws, v: Value) {
    ws.send(Message::text(v.to_string())).unwrap();
}

/// Full handshake; Err(text) if rejected at upgrade or by an `error` message.
fn try_connect(port: u16, role: &str, origin: Option<&str>, secret_mac_ok: bool) -> Result<Ws, String> {
    let info = json!({"browser":"Test Chrome 1","extVersion":"9.9.9"});
    try_connect_info(port, role, origin, secret_mac_ok, info)
}
fn try_connect_info(
    port: u16,
    role: &str,
    origin: Option<&str>,
    secret_mac_ok: bool,
    info: Value,
) -> Result<Ws, String> {
    let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut req = format!("ws://127.0.0.1:{port}/").into_client_request().unwrap();
    if let Some(o) = origin {
        req.headers_mut().insert("origin", o.parse().unwrap());
    }
    let (mut ws, _) = tungstenite::client(req, s).map_err(|e| e.to_string())?;
    let np = recv(&mut ws)["nonce"].as_str().unwrap().to_string();
    let nc = "abcd".to_string();
    let mut m = mac(&format!("bctl1|client|{role}|{np}|{nc}"));
    if !secret_mac_ok {
        m = "00".repeat(32);
    }
    send(
        &mut ws,
        json!({"t":"auth","role":role,"nonce":nc,"mac":m,"version":"t","info":info}),
    );
    let w = recv(&mut ws);
    if w["t"] == "error" {
        return Err(w["error"].as_str().unwrap().to_string());
    }
    assert_eq!(w["t"], "welcome");
    assert_eq!(w["mac"], mac(&format!("bctl1|server|{role}|{nc}|{np}")));
    Ok(ws)
}
fn cli(p: &Proxy) -> Ws {
    try_connect(p.port, "cli", None, true).unwrap()
}
fn ext(p: &Proxy) -> Ws {
    try_connect(p.port, "ext", Some(EXT_ORIGIN), true).unwrap()
}
fn status(p: &Proxy) -> Value {
    let mut c = cli(p);
    send(&mut c, json!({"t":"status"}));
    recv(&mut c)
}
fn wait_exit(p: &mut Proxy, secs: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if p.child.try_wait().unwrap().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn handshake_and_status() {
    let p = start(&[]);
    let s = status(&p);
    assert_eq!(s["proxy"]["port"], p.port);
    assert_eq!(s["proxy"]["idleTimeoutSecs"], 600);
    assert!(s["ext"].is_null());
    let _e = ext(&p);
    assert_eq!(
        status(&p)["ext"],
        json!({"browser":"Test Chrome 1","extVersion":"9.9.9"})
    );
}

#[test]
fn rejects_bad_mac_origin_and_role() {
    let p = start(&[]);
    assert!(try_connect(p.port, "cli", None, false)
        .unwrap_err()
        .contains("authentication failed"));
    assert!(try_connect(p.port, "cli", Some("https://evil.example"), true)
        .unwrap_err()
        .contains("403"));
    assert!(try_connect(p.port, "ext", Some("https://evil.example"), true)
        .unwrap_err()
        .contains("403"));
    assert!(try_connect(p.port, "ext", None, true)
        .unwrap_err()
        .contains("authentication failed"));
    assert!(try_connect(p.port, "cli", Some(EXT_ORIGIN), true).is_err());
    // Only the pinned extension ID may be an ext.
    for o in [
        "chrome-extension://abc",
        "chrome-extension://fekhggniifjffgnkljlblgfcoolaonbmx",
    ] {
        assert!(try_connect(p.port, "ext", Some(o), true).unwrap_err().contains("403"));
    }
}

#[test]
fn relays_request_events_and_response() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{"argv":["x"]}}));
    let r = recv(&mut e);
    assert_eq!((r["t"].as_str(), &r["req"]["argv"]), (Some("req"), &json!(["x"])));
    let id = r["id"].clone();
    send(&mut e, json!({"t":"event","id":id,"stderr":"waiting\n"}));
    send(&mut e, json!({"t":"res","id":id,"res":{"exitCode":0,"stdout":"ok\n"}}));
    assert_eq!(recv(&mut c), json!({"t":"event","stderr":"waiting\n"}));
    assert_eq!(recv(&mut c), json!({"t":"res","res":{"exitCode":0,"stdout":"ok\n"}}));
}

#[test]
fn ext_disconnect_yields_error_res() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    recv(&mut e);
    drop(e);
    let r = recv(&mut c);
    assert_eq!(r["res"]["exitCode"], 1);
    assert!(r["res"]["stderr"]
        .as_str()
        .unwrap()
        .contains("browser extension disconnected"));
    assert_eq!(r["res"]["code"], "not_connected");
}

#[test]
fn cli_disconnect_sends_cancel() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let id = recv(&mut e)["id"].clone();
    drop(c);
    assert_eq!(recv(&mut e), json!({"t":"cancel","id":id}));
}

/// Reads the next message with a short timeout; None if nothing arrives.
fn try_recv(ws: &mut Ws, ms: u64) -> Option<Value> {
    ws.get_ref().set_read_timeout(Some(Duration::from_millis(ms))).unwrap();
    let r = loop {
        match ws.read() {
            Ok(Message::Text(t)) => break Some(serde_json::from_str(t.as_str()).unwrap()),
            Ok(_) => {}
            Err(_) => break None,
        }
    };
    ws.get_ref().set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    r
}

#[test]
fn failed_write_to_cli_cancels_once_and_clears_pending() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let id = recv(&mut e)["id"].clone();
    assert_eq!(status(&p)["proxy"]["pending"], 1);
    // Kill the CLI socket without a close handshake, then make the proxy write to it.
    c.get_ref().shutdown(std::net::Shutdown::Both).ok();
    drop(c);
    for _ in 0..3 {
        send(&mut e, json!({"t":"event","id":id,"stderr":"x\n"}));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(recv(&mut e), json!({"t":"cancel","id":id}));
    assert!(try_recv(&mut e, 300).is_none(), "cancel sent twice");
    assert_eq!(status(&p)["proxy"]["pending"], 0);
}

#[test]
fn completed_request_is_not_cancelled() {
    let p = start(&[]);
    let mut e = ext(&p);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"req","req":{}}));
    let id = recv(&mut e)["id"].clone();
    send(&mut e, json!({"t":"res","id":id,"res":{"exitCode":0}}));
    assert_eq!(recv(&mut c)["t"], "res");
    drop(c);
    assert!(try_recv(&mut e, 300).is_none());
    assert_eq!(status(&p)["proxy"]["pending"], 0);
}

#[test]
fn shutdown_fails_pending_requests_and_cancels_in_extension() {
    let mut p = start(&[]);
    let mut e = ext(&p);
    let mut c1 = cli(&p);
    let mut c2 = cli(&p);
    send(&mut c1, json!({"t":"req","req":{}}));
    send(&mut c2, json!({"t":"req","req":{}}));
    let mut ids = vec![recv(&mut e)["id"].clone(), recv(&mut e)["id"].clone()];
    let mut s = cli(&p);
    send(&mut s, json!({"t":"shutdown"}));
    assert_eq!(recv(&mut s)["t"], "ok");
    for c in [&mut c1, &mut c2] {
        let r = recv(c);
        assert_eq!(r["res"]["exitCode"], 1);
        assert!(r["res"]["stderr"].as_str().unwrap().contains("shutting down"));
    }
    let mut cancelled = vec![];
    for _ in 0..2 {
        let m = recv(&mut e);
        assert_eq!(m["t"], "cancel");
        cancelled.push(m["id"].clone());
    }
    ids.sort_by_key(|v| v.as_u64());
    cancelled.sort_by_key(|v| v.as_u64());
    assert_eq!(ids, cancelled);
    assert!(wait_exit(&mut p, 5));
}

#[test]
fn newer_cli_does_not_restart_a_busy_proxy() {
    // Fake proxy of another version that reports one request in flight; the CLI must not send `shutdown`.
    let d = tmpdir("busy");
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::fs::write(d.join("config.json"), json!({"secret":SECRET,"port":port}).to_string()).unwrap();
    let t = std::thread::spawn(move || {
        let mut seen = vec![];
        l.set_nonblocking(false).unwrap();
        // Serve connections until the CLI exits (it connects, asks status, then gives up).
        let (s, _) = loop {
            let c = l.accept().unwrap();
            c.0.set_nonblocking(false).unwrap();
            if c.0.peek(&mut [0u8; 1]).is_ok_and(|n| n > 0) {
                break c;
            }
        };
        let mut ws = tungstenite::accept(s).unwrap();
        send(&mut ws, json!({"t":"challenge","nonce":"aa"}));
        let a = recv(&mut ws);
        let nc = a["nonce"].as_str().unwrap();
        send(
            &mut ws,
            json!({"t":"welcome","mac":mac(&format!("bctl1|server|cli|{nc}|aa")),"version":"0.0.0-old"}),
        );
        while let Ok(Message::Text(m)) = ws.read() {
            let v: Value = serde_json::from_str(m.as_str()).unwrap();
            seen.push(v["t"].as_str().unwrap().to_string());
            if v["t"] == "status" {
                send(
                    &mut ws,
                    json!({"t":"status","proxy":{"version":"0.0.0-old","pending":1},"ext":null}),
                );
            }
        }
        seen
    });
    let o = Command::new(env!("CARGO_BIN_EXE_bctl"))
        .arg("tabs")
        .env("BCTL_CONFIG_DIR", &d)
        .env("BCTL_PORT", port.to_string())
        .output()
        .unwrap();
    let seen = t.join().unwrap();
    assert_eq!(o.status.code(), Some(1));
    let err = String::from_utf8_lossy(&o.stderr);
    assert!(err.contains("busy with 1 request"), "{err}");
    assert_eq!(seen, ["status"]);
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn no_extension_errors_after_wait() {
    let p = start(&[]);
    let mut c = cli(&p);
    let t = Instant::now();
    send(&mut c, json!({"t":"req","req":{}}));
    let r = recv(&mut c);
    assert!(t.elapsed() >= Duration::from_millis(350));
    assert_eq!(r["res"]["exitCode"], 1);
    assert!(r["res"]["stderr"].as_str().unwrap().contains("not connected"));
    assert_eq!(r["res"]["code"], "not_connected");
}

#[test]
fn idle_timeout_exits() {
    let mut p = start(&["--idle-timeout", "1"]);
    assert!(wait_exit(&mut p, 5));
}

#[test]
fn shutdown_exits() {
    let mut p = start(&[]);
    let mut c = cli(&p);
    send(&mut c, json!({"t":"shutdown"}));
    assert_eq!(recv(&mut c)["t"], "ok");
    assert!(wait_exit(&mut p, 5));
}

fn bctl(p: &Proxy, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bctl"))
        .args(args)
        .env("BCTL_CONFIG_DIR", &p.dir)
        .env("BCTL_PORT", p.port.to_string())
        .output()
        .unwrap()
}

#[test]
fn cli_binary_end_to_end() {
    let p = start(&[]);
    let mut e = ext(&p);
    let out = p.dir.join("sub/dir/f.txt");
    let path = out.to_string_lossy().to_string();
    let t = std::thread::spawn(move || {
        let r = recv(&mut e);
        assert_eq!(r["req"]["argv"], json!(["echo", "hi"]));
        assert_eq!(r["req"]["session"], "default");
        let id = r["id"].clone();
        send(&mut e, json!({"t":"event","id":id,"stderr":"progress\n"}));
        let files = json!([{"path":path,"base64":"aGVsbG8="}]);
        send(
            &mut e,
            json!({"t":"res","id":id,"res":{"exitCode":3,"stdout":"out","stderr":"err","files":files}}),
        );
        e
    });
    let o = bctl(&p, &["echo", "hi"]);
    let _e = t.join().unwrap();
    assert_eq!(o.status.code(), Some(3));
    assert_eq!(o.stdout, b"out");
    assert_eq!(String::from_utf8_lossy(&o.stderr), "progress\nerr");
    assert_eq!(std::fs::read(&out).unwrap(), b"hello");
    let s = bctl(&p, &["status"]);
    let s = String::from_utf8_lossy(&s.stdout).to_string();
    assert!(s.contains("extension: Test Chrome 1 (extension v9.9.9)"), "{s}");
}

#[test]
fn cli_binary_unpaired_and_bad_server_mac() {
    let p = start(&[]);
    std::fs::remove_file(p.dir.join("config.json")).unwrap();
    let o = bctl(&p, &["tabs"]);
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).starts_with("Not paired."));

    // Fake server that answers auth with a wrong welcome MAC.
    std::fs::write(p.dir.join("config.json"), json!({"secret":SECRET}).to_string()).unwrap();
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let t = std::thread::spawn(move || {
        // The CLI's liveness probe connects first without speaking WebSocket; skip it.
        let mut ws = loop {
            if let Ok(ws) = tungstenite::accept(l.accept().unwrap().0) {
                break ws;
            }
        };
        send(&mut ws, json!({"t":"challenge","nonce":"aa"}));
        recv(&mut ws);
        send(&mut ws, json!({"t":"welcome","mac":"00","version":"x"}));
    });
    let o = Command::new(env!("CARGO_BIN_EXE_bctl"))
        .arg("tabs")
        .env("BCTL_CONFIG_DIR", &p.dir)
        .env("BCTL_PORT", port.to_string())
        .output()
        .unwrap();
    t.join().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("server authentication failed"));
}

// ---- managed extension updates, skills, setup ----

fn embedded() -> bool {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../extension/dist/manifest.json")
        .is_file()
}
fn ext_with(p: &Proxy, info: Value) -> Ws {
    try_connect_info(p.port, "ext", Some(EXT_ORIGIN), true, info).unwrap()
}
/// True if the next message the ext receives is a relayed request (i.e. no `update` was sent before it).
fn no_update_before_req(p: &Proxy, e: &mut Ws) -> bool {
    let mut c = cli(p);
    send(&mut c, json!({"t":"req","req":{}}));
    recv(e)["t"] == "req"
}

#[test]
fn managed_old_ext_gets_update_and_folder() {
    let p = start(&[]);
    let mut e = ext_with(&p, json!({"browser":"T","extVersion":"0.0.1","managed":true}));
    let folder = p.dir.join("extension");
    if !embedded() {
        assert!(no_update_before_req(&p, &mut e));
        return;
    }
    let u = recv(&mut e);
    assert_eq!(u, json!({"t":"update","version":env!("CARGO_PKG_VERSION")}));
    assert!(folder.join("manifest.json").is_file());
    assert!(!folder.join("background.js.map").exists());
    let pairing: Value = serde_json::from_slice(&std::fs::read(folder.join("pairing.json")).unwrap()).unwrap();
    assert_eq!(pairing, json!({"secret":SECRET,"port":p.port}));
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(folder.join("pairing.json")).unwrap().permissions())
            & 0o777,
        0o600
    );
}

#[test]
fn managed_update_removes_stale_files_but_keeps_pairing() {
    if !embedded() {
        return;
    }
    let p = start(&[]);
    let folder = p.dir.join("extension");
    std::fs::create_dir_all(folder.join("old")).unwrap();
    std::fs::write(folder.join("old/stale.js"), "x").unwrap();
    std::fs::write(folder.join("pairing.json"), "{}").unwrap();
    let mut e = ext_with(&p, json!({"browser":"T","extVersion":"0.0.1","managed":true}));
    assert_eq!(recv(&mut e)["t"], "update");
    assert!(!folder.join("old").exists());
    assert!(std::fs::read_to_string(folder.join("pairing.json"))
        .unwrap()
        .contains(SECRET));
}

#[test]
fn unmanaged_or_current_ext_gets_no_update() {
    let p = start(&[]);
    let mut e = ext_with(&p, json!({"browser":"T","extVersion":"0.0.1","managed":false}));
    assert!(no_update_before_req(&p, &mut e));
    assert!(!p.dir.join("extension").exists());
    let mut e = ext_with(
        &p,
        json!({"browser":"T","extVersion":env!("CARGO_PKG_VERSION"),"managed":true}),
    );
    assert!(no_update_before_req(&p, &mut e));
    assert!(!p.dir.join("extension").exists());
}

fn run_bctl(dir: &std::path::Path, home: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_bctl"))
        .args(args)
        .env("BCTL_CONFIG_DIR", dir)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("BCTL_PORT")
        .output()
        .unwrap()
}
fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("bctl-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok();
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn skills_list_get_path_install() {
    let d = tmpdir("skills");
    let home = d.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let cfg = d.join("cfg");
    let out = |a: &[&str]| {
        let o = run_bctl(&cfg, &home, a);
        assert!(o.status.success(), "{a:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string()
    };
    assert!(out(&["skills"]).starts_with("core\t"));
    assert_eq!(out(&["skills"]), out(&["skills", "list"]));
    let core = out(&["skills", "get", "core"]);
    assert!(core.starts_with("---\nname: core\n") && core.contains("bctl setup"));
    let r = out(&["skills", "get", "core", "--ref", "commands"]);
    assert!(r.contains("snapshot"));
    assert!(out(&["skills", "get", "core", "--full"]).contains(&r));
    assert!(!run_bctl(&cfg, &home, &["skills", "get", "nope"]).status.success());
    let path = out(&["skills", "path", "core"]);
    assert!(std::path::Path::new(path.trim()).join("SKILL.md").is_file());
    assert!(std::path::Path::new(path.trim())
        .join("references/commands.md")
        .is_file());

    out(&["skills", "install"]);
    let stub = std::fs::read_to_string(home.join(".agents/skills/bctl/SKILL.md")).unwrap();
    assert!(stub.contains("name: bctl") && stub.contains("bctl skills get core"));
    assert!(!home.join(".claude").exists());
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    out(&["skills", "install"]);
    assert!(home.join(".claude/skills/bctl/SKILL.md").is_file());
    out(&["skills", "install", "--dir", d.join("custom").to_str().unwrap()]);
    assert!(d.join("custom/bctl/SKILL.md").is_file());
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn setup_writes_folder_and_pairing() {
    let d = tmpdir("setup");
    let o = run_bctl(&d, &d, &["setup", "--no-open", "--no-wait"]);
    if !embedded() {
        assert!(!o.status.success());
        assert!(String::from_utf8_lossy(&o.stderr).contains("doesn't include the extension"));
        return;
    }
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let cfg: Value = serde_json::from_slice(&std::fs::read(d.join("config.json")).unwrap()).unwrap();
    let pairing: Value = serde_json::from_slice(&std::fs::read(d.join("extension/pairing.json")).unwrap()).unwrap();
    assert_eq!(cfg["secret"].as_str().unwrap().len(), 43);
    assert_eq!(pairing, cfg);
    assert!(d.join("extension/manifest.json").is_file());
    // Idempotent: keeps the secret.
    assert!(run_bctl(&d, &d, &["setup", "--no-open", "--no-wait"]).status.success());
    let cfg2: Value = serde_json::from_slice(&std::fs::read(d.join("config.json")).unwrap()).unwrap();
    assert_eq!(cfg, cfg2);
    // unpair removes pairing.json
    run_bctl(&d, &d, &["unpair"]);
    assert!(!d.join("extension/pairing.json").exists());
    std::fs::remove_dir_all(&d).ok();
}

// ---- doctor ----

fn doctor(dir: &std::path::Path, port: u16, args: &[&str]) -> (Value, i32) {
    let o = Command::new(env!("CARGO_BIN_EXE_bctl"))
        .arg("doctor")
        .args(args)
        .arg("--json")
        .env("BCTL_CONFIG_DIR", dir)
        .env("BCTL_PORT", port.to_string())
        .output()
        .unwrap();
    let v: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}: {}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    });
    (v, o.status.code().unwrap())
}
fn check<'a>(v: &'a Value, name: &str) -> &'a Value {
    v["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
}
fn chmod(path: &std::path::Path, _mode: u32) {
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(_mode)).unwrap();
    let _ = path;
}
/// Fake extension that answers every request with exit code 0 until its socket closes.
fn answering_ext(p: &Proxy, info: Value) -> std::thread::JoinHandle<()> {
    let mut e = ext_with(p, info);
    std::thread::spawn(move || {
        while let Ok(Message::Text(t)) = e.read() {
            let r: Value = serde_json::from_str(t.as_str()).unwrap();
            if r["t"] == "req" {
                assert_eq!(r["req"]["argv"], json!(["help"]));
                send(
                    &mut e,
                    json!({"t":"res","id":r["id"],"res":{"exitCode":0,"stdout":"help\n"}}),
                );
            }
        }
    })
}

#[test]
fn doctor_all_green_with_extension() {
    let p = start(&[]);
    chmod(&p.dir.join("config.json"), 0o600);
    let info = json!({"browser":"Google Chrome 150","extVersion":env!("CARGO_PKG_VERSION"),"managed":false});
    let _t = answering_ext(&p, info);
    let (v, code) = doctor(&p.dir, p.port, &[]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["ok"], true);
    for n in ["config", "managed folder", "proxy", "extension", "round trip"] {
        assert_eq!(check(&v, n)["status"], "pass", "{n}: {v}");
    }
    assert!(check(&v, "round trip")["message"].as_str().unwrap().contains(" ms"));
    // Text output uses marks and ends with a summary.
    let o = bctl(&p, &["doctor", "--quick"]);
    let s = String::from_utf8_lossy(&o.stdout);
    assert!(s.contains("✓ proxy:") && s.ends_with("All good.\n"), "{s}");
}

#[test]
fn doctor_reports_missing_extension_and_old_browser() {
    let p = start(&[]);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(code, 1);
    assert_eq!(check(&v, "proxy")["status"], "pass");
    assert_eq!(check(&v, "extension")["status"], "fail");
    assert!(check(&v, "extension")["message"]
        .as_str()
        .unwrap()
        .contains("not connected"));
    assert_eq!(check(&v, "round trip")["status"], "skip");

    let info = json!({"browser":"Google Chrome 120","extVersion":env!("CARGO_PKG_VERSION"),"managed":false});
    let _t = answering_ext(&p, info);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(code, 1);
    assert!(
        check(&v, "extension")["message"].as_str().unwrap().contains("127"),
        "{v}"
    );
}

#[test]
fn doctor_warns_on_extension_version_mismatch() {
    let p = start(&[]);
    chmod(&p.dir.join("config.json"), 0o600);
    let info = json!({"browser":"Google Chrome 150","extVersion":"0.0.1","managed":false});
    let _t = answering_ext(&p, info);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(code, 0);
    assert_eq!(check(&v, "extension")["status"], "warn");
    assert!(check(&v, "extension")["fix"].is_string());
}

#[test]
fn doctor_without_config_fails_and_skips_the_rest() {
    let d = tmpdir("doctor-nocfg");
    let (v, code) = doctor(&d, 1, &[]);
    assert_eq!(code, 1);
    assert_eq!(check(&v, "config")["status"], "fail");
    assert_eq!(check(&v, "proxy")["status"], "skip");
    std::fs::remove_dir_all(&d).ok();
}

#[test]
fn doctor_quick_does_not_start_a_proxy() {
    let d = tmpdir("doctor-quick");
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::write(d.join("config.json"), json!({"secret":SECRET,"port":port}).to_string()).unwrap();
    chmod(&d.join("config.json"), 0o600);
    let (v, code) = doctor(&d, port, &["--quick"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(check(&v, "proxy")["status"], "warn");
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    std::fs::remove_dir_all(&d).ok();
}

#[cfg(unix)]
#[test]
fn doctor_config_permissions_and_fix() {
    let p = start(&[]);
    let cfg = p.dir.join("config.json");
    chmod(&cfg, 0o644);
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!((code, check(&v, "config")["status"].as_str()), (1, Some("fail")));
    let (v, _) = doctor(&p.dir, p.port, &["--quick", "--fix"]);
    assert_eq!(check(&v, "config")["status"], "fixed");
    let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&cfg).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn doctor_managed_folder_mismatch_and_fix() {
    let p = start(&[]);
    chmod(&p.dir.join("config.json"), 0o600);
    let folder = p.dir.join("extension");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("manifest.json"), json!({"version":"0.0.1"}).to_string()).unwrap();
    std::fs::write(
        folder.join("pairing.json"),
        json!({"secret":"other","port":p.port}).to_string(),
    )
    .unwrap();
    let (v, code) = doctor(&p.dir, p.port, &["--quick"]);
    assert_eq!(
        (code, check(&v, "managed folder")["status"].as_str()),
        (1, Some("fail"))
    );
    assert!(check(&v, "managed folder")["message"]
        .as_str()
        .unwrap()
        .contains("pairing.json"));
    let (v, _) = doctor(&p.dir, p.port, &["--quick", "--fix"]);
    if embedded() {
        assert_eq!(check(&v, "managed folder")["status"], "fixed");
        let pairing: Value = serde_json::from_slice(&std::fs::read(folder.join("pairing.json")).unwrap()).unwrap();
        assert_eq!(pairing, json!({"secret":SECRET,"port":p.port}));
        assert_eq!(doctor(&p.dir, p.port, &["--quick"]).0["checks"][1]["status"], "pass");
    } else {
        assert_eq!(check(&v, "managed folder")["status"], "fail");
    }
}

#[test]
fn doctor_detects_a_squatter_on_the_port() {
    let d = tmpdir("doctor-squat");
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::fs::write(d.join("config.json"), json!({"secret":SECRET,"port":port}).to_string()).unwrap();
    chmod(&d.join("config.json"), 0o600);
    let t = std::thread::spawn(move || {
        let mut ws = loop {
            if let Ok(ws) = tungstenite::accept(l.accept().unwrap().0) {
                break ws;
            }
        };
        send(&mut ws, json!({"t":"challenge","nonce":"aa"}));
        recv(&mut ws);
        send(&mut ws, json!({"t":"welcome","mac":"00","version":"x"}));
    });
    let (v, code) = doctor(&d, port, &["--quick"]);
    t.join().unwrap();
    assert_eq!(code, 1);
    assert_eq!(check(&v, "proxy")["status"], "fail");
    assert!(check(&v, "proxy")["message"]
        .as_str()
        .unwrap()
        .contains("server authentication failed"));
    std::fs::remove_dir_all(&d).ok();
}
