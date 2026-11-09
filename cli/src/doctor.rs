//! `bvl doctor`: CLI-local diagnosis of config, managed folder, proxy, extension and a round trip.
use crate::embed::{self, EMBEDDED_EXT_VERSION};
use crate::{addr, connect_raw, dir, ensure_proxy, load, recv, send, shutdown, Config, VERSION};
use anyhow::Result;
use serde_json::{json, Value};
use std::net::TcpStream;
use std::time::{Duration, Instant};

const MIN_BROWSER: u32 = 127;

#[derive(Clone, Copy, PartialEq)]
enum St {
    Pass,
    Warn,
    Fail,
    Skip,
    Fixed,
}
impl St {
    fn name(self) -> &'static str {
        match self {
            St::Pass => "pass",
            St::Warn => "warn",
            St::Fail => "fail",
            St::Skip => "skip",
            St::Fixed => "fixed",
        }
    }
    fn mark(self) -> &'static str {
        match self {
            St::Pass => "✓",
            St::Warn => "!",
            St::Fail => "✗",
            St::Skip => "-",
            St::Fixed => "✓",
        }
    }
}

struct Check {
    name: &'static str,
    st: St,
    msg: String,
    fix: Option<String>,
}
struct Report(Vec<Check>);
impl Report {
    fn add(&mut self, name: &'static str, st: St, msg: impl Into<String>, fix: Option<&str>) {
        self.0.push(Check {
            name,
            st,
            msg: msg.into(),
            fix: fix.map(String::from),
        });
    }
}

struct Opts {
    fix: bool,
    quick: bool,
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn config(r: &mut Report, o: &Opts) -> Option<Config> {
    let path = dir().join("config.json");
    if !path.is_file() {
        r.add(
            "config",
            St::Fail,
            format!("{} does not exist", path.display()),
            Some("run `bvl setup`"),
        );
        return None;
    }
    let Some(c) = load() else {
        r.add(
            "config",
            St::Fail,
            format!("{} is unreadable or has no secret", path.display()),
            Some("run `bvl setup` (keeps nothing from the broken file) or `bvl pair <code>`"),
        );
        return None;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).map_or(0o600, |m| m.permissions().mode() & 0o777);
        if mode & 0o077 != 0 {
            if o.fix && std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).is_ok() {
                r.add(
                    "config",
                    St::Fixed,
                    format!("{} had mode {mode:o}; set to 600", path.display()),
                    None,
                );
            } else {
                r.add(
                    "config",
                    St::Fail,
                    format!("{} has mode {mode:o}; it holds the pairing secret", path.display()),
                    Some(&format!("chmod 600 {} (or `bvl doctor --fix`)", path.display())),
                );
            }
            return Some(c);
        }
    }
    let _ = o;
    r.add(
        "config",
        St::Pass,
        format!("{} (port {})", path.display(), c.port),
        None,
    );
    Some(c)
}

fn managed(r: &mut Report, c: &Config, o: &Opts) {
    let root = embed::ext_dir();
    if !root.is_dir() {
        r.add(
            "managed folder",
            St::Pass,
            "not used (no managed extension folder; e.g. a development build is loaded unpacked)",
            None,
        );
        return;
    }
    let read = |f: &str| -> Option<Value> { serde_json::from_slice(&std::fs::read(root.join(f)).ok()?).ok() };
    let mut problems = vec![];
    match read(embed::PAIRING) {
        None => problems.push("pairing.json is missing or unreadable".to_string()),
        Some(p) if p["secret"].as_str() != Some(c.secret.as_str()) || p["port"].as_u64() != Some(c.port.into()) => {
            problems.push("pairing.json doesn't match config.json (secret or port)".into());
        }
        Some(_) => {}
    }
    let ver = read("manifest.json").and_then(|m| m["version"].as_str().map(String::from));
    match (&ver, EMBEDDED_EXT_VERSION) {
        (None, _) => problems.push("manifest.json is missing or unreadable".into()),
        (Some(v), Some(e)) if v != e => problems.push(format!("extension files are v{v}, this bvl bundles v{e}")),
        _ => {}
    }
    if problems.is_empty() {
        r.add(
            "managed folder",
            St::Pass,
            format!("{} (extension v{})", root.display(), ver.unwrap_or_default()),
            None,
        );
        return;
    }
    let msg = problems.join("; ");
    if o.fix && EMBEDDED_EXT_VERSION.is_some() {
        match embed::write_managed(&c.secret, c.port) {
            Ok(_) => {
                r.add(
                    "managed folder",
                    St::Fixed,
                    format!("{msg}; rewrote {}", root.display()),
                    Some("reload the extension in the browser if it keeps the old files"),
                );
                return;
            }
            Err(e) => {
                r.add(
                    "managed folder",
                    St::Fail,
                    format!("{msg}; rewrite failed: {e:#}"),
                    None,
                );
                return;
            }
        }
    }
    r.add(
        "managed folder",
        St::Fail,
        msg,
        Some("run `bvl doctor --fix` (rewrites the folder), then reload the extension"),
    );
}

/// Version number at the end of e.g. "Google Chrome 157" / "Chrome/157.0.1".
fn browser_major(s: &str) -> Option<u32> {
    s.rsplit([' ', '/']).find_map(|w| w.split('.').next()?.parse().ok())
}

struct Proxy {
    version: String,
    pending: u64,
    ext: Value,
}

/// Connect, authenticate and read `status`. Err = (message, port reachable).
fn probe(c: &Config) -> Result<Proxy, (String, bool)> {
    let up = TcpStream::connect_timeout(&addr(c.port), Duration::from_millis(500)).is_ok();
    if !up {
        return Err((format!("nothing is listening on 127.0.0.1:{}", c.port), false));
    }
    let (mut ws, version) = connect_raw(c).map_err(|e| (format!("{e:#}"), true))?;
    send(&mut ws, json!({"t":"status"})).map_err(|e| (format!("{e:#}"), true))?;
    let s = recv(&mut ws).map_err(|e| (format!("{e:#}"), true))?;
    Ok(Proxy {
        version,
        pending: s["proxy"]["pending"].as_u64().unwrap_or(0),
        ext: s["ext"].clone(),
    })
}

fn proxy_and_ext(r: &mut Report, c: &Config, o: &Opts) -> Option<Proxy> {
    let mut p = probe(c);
    if let Err((_, false)) = p {
        if o.quick {
            r.add(
                "proxy",
                St::Warn,
                format!("not running on 127.0.0.1:{} (--quick: not started)", c.port),
                Some("any bvl command starts it"),
            );
            r.add("extension", St::Skip, "needs a running proxy", None);
            return None;
        }
        // Like every other command, doctor starts the proxy on demand so the extension can connect.
        if let Err(e) = ensure_proxy(c) {
            r.add(
                "proxy",
                St::Fail,
                format!("could not start: {e:#}"),
                Some("see proxy.log in the config dir"),
            );
            r.add("extension", St::Skip, "needs a running proxy", None);
            return None;
        }
        p = probe(c);
    }
    let mut p = match p {
        Ok(p) => p,
        Err((m, _)) => {
            r.add(
                "proxy",
                St::Fail,
                m,
                Some(&format!(
                    "port {} may be taken by another program, or the proxy was started with a different secret: try `bvl stop`, use BVL_PORT/`bvl pair <code> --port N`, or re-run `bvl setup`",
                    c.port
                )),
            );
            r.add("extension", St::Skip, "needs a working proxy", None);
            return None;
        }
    };
    if p.version == VERSION {
        r.add("proxy", St::Pass, format!("v{} on port {}", p.version, c.port), None);
    } else if o.fix && p.pending == 0 && shutdown(c) && ensure_proxy(c).is_ok() {
        match probe(c) {
            Ok(n) => {
                r.add(
                    "proxy",
                    St::Fixed,
                    format!("was v{}, restarted as v{}", p.version, n.version),
                    None,
                );
                p = n;
            }
            Err((m, _)) => {
                r.add("proxy", St::Fail, format!("restart failed: {m}"), None);
                return None;
            }
        }
    } else if p.pending > 0 {
        r.add(
            "proxy",
            St::Warn,
            format!(
                "v{} differs from bvl v{VERSION} and is busy with {} request(s)",
                p.version, p.pending
            ),
            Some("wait for them to finish, then `bvl doctor --fix`; use one bvl version at a time"),
        );
    } else {
        r.add(
            "proxy",
            St::Warn,
            format!("v{} differs from bvl v{VERSION}", p.version),
            Some("run `bvl doctor --fix` (or `bvl stop`; the next command restarts it)"),
        );
    }

    // The extension may need a moment to reconnect to a freshly started proxy.
    if !o.quick {
        for _ in 0..30 {
            if p.ext.is_object() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
            match probe(c) {
                Ok(n) => p = n,
                Err(_) => break,
            }
        }
    }
    extension(r, &p);
    Some(p)
}

fn extension(r: &mut Report, p: &Proxy) {
    let Some(e) = p.ext.as_object() else {
        r.add(
            "extension",
            St::Fail,
            "not connected to the proxy",
            Some("open the browser with the Browser Valet extension enabled; if it was never installed or paired, run `bvl setup`; check the popup for errors"),
        );
        return;
    };
    let ver = e.get("extVersion").and_then(Value::as_str).unwrap_or("?");
    let browser = e.get("browser").and_then(Value::as_str).unwrap_or("unknown browser");
    let managed = e.get("managed").and_then(Value::as_bool).unwrap_or(false);
    let mut issues = vec![];
    let mut st = St::Pass;
    let mut fix = None;
    if ver != VERSION {
        st = St::Warn;
        issues.push(format!("extension v{ver} differs from bvl v{VERSION}"));
        fix = Some(if managed {
            "the managed extension updates itself when it reconnects; if not, reload it at the browser's extensions page"
        } else {
            "rebuild/reload the unpacked extension (or run `bvl setup` for the managed one)"
        });
    }
    match browser_major(browser) {
        Some(v) if v < MIN_BROWSER => {
            st = St::Fail;
            issues.push(format!("browser is version {v}, but {MIN_BROWSER}+ is required"));
            fix = Some("update the browser");
        }
        None => {
            if st == St::Pass {
                st = St::Warn;
            }
            issues.push("browser version unknown".into());
        }
        _ => {}
    }
    let mut msg = format!("{browser}, extension v{ver}{}", if managed { " (managed)" } else { "" });
    if !issues.is_empty() {
        msg = format!("{msg}; {}", issues.join("; "));
    }
    r.add("extension", st, msg, fix);
}

fn round_trip(c: &Config) -> std::result::Result<Duration, String> {
    let start = Instant::now();
    let req = json!({
        "argv": ["help"], "cwd": ".", "tmp": std::env::temp_dir().to_string_lossy(),
        "sep": std::path::MAIN_SEPARATOR.to_string(),
        "platform": match std::env::consts::OS { "macos" => "macos", "windows" => "windows", _ => "linux" },
        "session": "default",
    });
    let (mut ws, _) = connect_raw(c).map_err(|e| format!("{e:#}"))?;
    ws.get_ref()
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|e| e.to_string())?;
    send(&mut ws, json!({"t":"req","req":req})).map_err(|e| format!("{e:#}"))?;
    loop {
        let m = recv(&mut ws).map_err(|e| format!("{e:#}"))?;
        match m["t"].as_str() {
            Some("res") => {
                return if m["res"]["exitCode"].as_i64().unwrap_or(0) == 0 {
                    Ok(start.elapsed())
                } else {
                    Err(m["res"]["stderr"]
                        .as_str()
                        .unwrap_or("request failed")
                        .trim()
                        .to_string())
                }
            }
            Some("error") => return Err(m["error"].as_str().unwrap_or("proxy error").to_string()),
            _ => {}
        }
    }
}

fn trip(r: &mut Report, c: &Config, o: &Opts, p: Option<Proxy>) {
    let Some(p) = p else {
        r.add("round trip", St::Skip, "needs a working proxy", None);
        return;
    };
    if o.quick {
        r.add("round trip", St::Skip, "--quick", None);
        return;
    }
    if !p.ext.is_object() {
        r.add("round trip", St::Skip, "needs a connected extension", None);
        return;
    }
    match round_trip(c) {
        Ok(d) => r.add(
            "round trip",
            St::Pass,
            format!("`help` answered in {} ms", d.as_millis()),
            None,
        ),
        Err(e) => {
            let idle = probe(c).is_ok_and(|n| n.pending == 0);
            if o.fix && idle && shutdown(c) && ensure_proxy(c).is_ok() {
                // The extension reconnects to the new proxy on its own; give it a moment, then retry once.
                std::thread::sleep(Duration::from_secs(2));
                if let Ok(d) = round_trip(c) {
                    r.add(
                        "round trip",
                        St::Fixed,
                        format!(
                            "failed ({e}); restarted the proxy, `help` answered in {} ms",
                            d.as_millis()
                        ),
                        None,
                    );
                    return;
                }
            }
            r.add(
                "round trip",
                St::Fail,
                e,
                Some("run `bvl doctor --fix` to restart the proxy; if it persists, reload the extension"),
            );
        }
    }
}

pub fn run(args: &[String]) -> Result<i32> {
    let has = |f: &str| args.iter().any(|a| a == f);
    let o = Opts {
        fix: has("--fix"),
        quick: has("--quick"),
    };
    let mut r = Report(vec![]);
    match config(&mut r, &o) {
        None => {
            for n in ["managed folder", "proxy", "extension", "round trip"] {
                r.add(n, St::Skip, "needs a valid config", None);
            }
        }
        Some(c) => {
            managed(&mut r, &c, &o);
            let p = proxy_and_ext(&mut r, &c, &o);
            trip(&mut r, &c, &o, p);
        }
    }
    let failed = r.0.iter().any(|c| c.st == St::Fail);
    if has("--json") {
        let checks: Vec<Value> =
            r.0.iter()
                .map(|c| {
                    let mut v = json!({"name":c.name,"status":c.st.name(),"message":c.msg});
                    if let Some(f) = &c.fix {
                        v["fix"] = f.clone().into();
                    }
                    v
                })
                .collect();
        println!("{}", json!({"version":VERSION,"ok":!failed,"checks":checks}));
    } else {
        for c in &r.0 {
            println!("{} {}: {}", c.st.mark(), c.name, c.msg);
            if let (Some(f), true) = (&c.fix, c.st != St::Pass) {
                println!("    fix: {f}");
            }
        }
        println!("{}", if failed { "Problems found." } else { "All good." });
    }
    Ok(i32::from(failed))
}
