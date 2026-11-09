//! `bctl setup`: write the managed extension folder, open the browser's extensions page, wait for the connection.
use crate::embed::{self, EMBEDDED_EXT_VERSION, NO_EXT};
use crate::{connect, ensure_proxy, load, recv, save, send, Config, DEFAULT_PORT};
use anyhow::{bail, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn new_secret() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("os randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn detached(cmd: &mut Command) -> bool {
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, 0x0800_0000 | 0x0000_0200);
    cmd.spawn().is_ok()
}

/// Best effort: launch the browser at its extensions page.
fn open_browser(browser: &str, url: &str) -> bool {
    match std::env::consts::OS {
        "macos" => {
            let app = match browser {
                "edge" => "Microsoft Edge",
                "brave" => "Brave Browser",
                "chromium" => "Chromium",
                _ => "Google Chrome",
            };
            detached(Command::new("open").args(["-a", app, url]))
        }
        "windows" => {
            let exe = match browser {
                "edge" => "msedge",
                "brave" => "brave",
                "chromium" => "chromium",
                _ => "chrome",
            };
            detached(Command::new("cmd").args(["/c", "start", "", exe, url]))
        }
        _ => {
            let exes: &[&str] = match browser {
                "edge" => &["microsoft-edge", "microsoft-edge-stable"],
                "brave" => &["brave-browser", "brave"],
                "chromium" => &["chromium", "chromium-browser"],
                _ => &["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
            };
            exes.iter().any(|e| detached(Command::new(e).arg(url)))
        }
    }
}

/// Best effort: put `text` on the clipboard.
fn clipboard(text: &str) -> bool {
    let cands: &[&[&str]] = &[
        &["pbcopy"],
        &["clip"],
        &["wl-copy"],
        &["xclip", "-selection", "clipboard"],
        &["xsel", "-b"],
    ];
    for c in cands {
        let Ok(mut ch) = Command::new(c[0])
            .args(&c[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        if let Some(mut i) = ch.stdin.take() {
            let _ = i.write_all(text.as_bytes());
        }
        if ch.wait().is_ok_and(|s| s.success()) {
            return true;
        }
    }
    false
}

/// Extension info from a running proxy (does not start one).
fn ext_info(c: &Config) -> Option<Value> {
    let mut ws = connect(c).ok()?;
    send(&mut ws, json!({"t":"status"})).ok()?;
    let v = recv(&mut ws).ok()?;
    v["ext"].is_object().then(|| v["ext"].clone())
}
fn up_to_date(e: &Value) -> bool {
    e["managed"] == true && e["extVersion"].as_str() == EMBEDDED_EXT_VERSION
}

pub fn run(args: &[String]) -> Result<i32> {
    let Some(ver) = EMBEDDED_EXT_VERSION else {
        bail!("{NO_EXT}")
    };
    let browser = flag(args, "--browser").unwrap_or_else(|| "chrome".into());
    let scheme = match browser.as_str() {
        "chrome" | "chromium" => "chrome",
        "edge" => "edge",
        "brave" => "brave",
        b => bail!("unknown --browser '{b}' (chrome | edge | brave | chromium)"),
    };
    let c = match load() {
        Some(c) => c,
        None => {
            let c = Config {
                secret: new_secret(),
                port: crate::env_port().unwrap_or(DEFAULT_PORT),
            };
            save(&c)?;
            c
        }
    };
    let path = embed::write_managed(&c.secret, c.port)?;
    let shown = path.display().to_string();
    println!("Extension v{ver} written to {shown}");

    if let Some(e) = ext_info(&c).filter(up_to_date) {
        println!(
            "✓ Already connected: {} (extension v{ver}). Nothing more to do.",
            e["browser"].as_str().unwrap_or("browser")
        );
        println!("Next: `bctl skills install` to teach your agents about bctl.");
        return Ok(0);
    }

    let url = format!("{scheme}://extensions");
    let opened = !args.iter().any(|a| a == "--no-open") && open_browser(&browser, &url);
    let copied = clipboard(&shown);
    println!("\nLoad the extension once (it updates itself afterwards):");
    println!(
        "  1. Open {url}{}",
        if opened {
            " (opened for you)"
        } else {
            " in your browser"
        }
    );
    println!("  2. Turn on \"Developer mode\" (top right)");
    println!("  3. Click \"Load unpacked\"");
    println!(
        "  4. Select this folder: {shown}{}",
        if copied { "  (copied to clipboard)" } else { "" }
    );

    if !args.iter().any(|a| a == "--no-wait") {
        println!("\nWaiting for the extension to connect (Ctrl-C to stop)…");
        ensure_proxy(&c)?;
        let end = Instant::now() + Duration::from_secs(300);
        let mut said_update = false;
        while Instant::now() < end {
            if let Some(e) = ext_info(&c) {
                if up_to_date(&e) {
                    println!(
                        "✓ Connected: {} (extension v{ver})",
                        e["browser"].as_str().unwrap_or("browser")
                    );
                    println!("\nNext: `bctl skills install` to teach your agents about bctl.");
                    return Ok(0);
                }
                if !said_update {
                    said_update = true;
                    println!(
                        "Extension connected (v{}); updating…",
                        e["extVersion"].as_str().unwrap_or("?")
                    );
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        println!("Timed out waiting for the extension; run `bctl status` after loading it.");
        return Ok(1);
    }
    println!("\nThen run `bctl status` to check. For agents: `bctl skills install`.");
    Ok(0)
}
