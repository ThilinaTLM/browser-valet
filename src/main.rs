mod config;
mod daemon;

use anyhow::{bail, Context, Result};
use base64::Engine;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, thread::sleep, time::Duration};

#[derive(Parser)]
#[command(name = "bctl", version, about = "Control your real browser via the Browser Bridge extension")]
struct Cli {
    /// Target tab id (defaults to the tab selected with `bctl use`, else the active tab)
    #[arg(long, global = true)]
    tab: Option<i64>,
    /// Print raw JSON results
    #[arg(long, global = true)]
    json: bool,
    /// Command timeout in seconds
    #[arg(long, global = true, default_value_t = 30)]
    timeout: u64,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the local relay daemon in the foreground (auto-started by other commands)
    Daemon {
        #[arg(long)]
        port: Option<u16>,
    },
    /// Stop the background daemon
    Stop,
    /// Show daemon / extension connection status
    Status,
    /// Print the pairing token to paste into the extension popup
    Token,

    /// List open tabs (* marks the current target tab)
    Tabs,
    /// Select the tab subsequent commands act on (`active` = the currently focused tab)
    Use { tab: String },
    /// Open a URL in a new tab and make it the current tab
    Open {
        url: String,
        /// Open in the background without focusing it
        #[arg(long)]
        bg: bool,
    },
    /// Navigate the current tab
    Goto { url: String },
    Back,
    Forward,
    Reload,
    /// Close a tab (default: current tab)
    Close { id: Option<i64> },

    /// Accessibility snapshot with element refs (@e1, @e2, ...)
    Snapshot {
        /// Only interactive elements (flat list)
        #[arg(short, long)]
        interactive: bool,
        /// Max tree depth
        #[arg(short, long)]
        depth: Option<u32>,
    },
    /// Click an element (ref like @e3 or a CSS selector)
    Click {
        target: String,
        #[arg(long)]
        double: bool,
        #[arg(long)]
        right: bool,
    },
    /// Hover an element
    Hover { target: String },
    /// Clear an input and fill it with text
    Fill { target: String, text: String },
    /// Type text with key events (into the focused element, or --into a target)
    Type {
        text: String,
        #[arg(long)]
        into: Option<String>,
    },
    /// Press a key or chord, e.g. Enter, Tab, Control+a, Shift+ArrowDown
    Press { key: String },
    /// Choose an option in a <select> by value or label
    Select { target: String, value: String },
    /// Scroll the page: up|down|left|right [pixels]
    Scroll { direction: String, amount: Option<i64> },
    /// Scroll an element into view
    #[command(name = "scrollintoview")]
    ScrollIntoView { target: String },
    /// Read data: text|html|value|title|url [target]
    Get { what: String, target: Option<String> },
    /// Evaluate JavaScript in the page (awaits promises)
    Eval { js: String },
    /// Save a PNG screenshot
    Screenshot {
        path: Option<PathBuf>,
        #[arg(long)]
        full: bool,
    },
    /// Wait for: <ms> | <target> to appear | --text | --url | --load
    Wait {
        target: Option<String>,
        #[arg(long)]
        text: Option<String>,
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        load: bool,
    },
    /// Detach the debugger from the current tab (removes the "being debugged" bar)
    Detach,
}

struct Client {
    base: String,
    token: String,
}

impl Client {
    fn new() -> Result<Self> {
        Ok(Self {
            base: format!("http://127.0.0.1:{}", config::port()),
            token: config::token()?,
        })
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn status(&self) -> Result<Value, ureq::Error> {
        let r = ureq::get(&format!("{}/status", self.base))
            .set("Authorization", &self.auth())
            .timeout(Duration::from_secs(2))
            .call()?;
        Ok(r.into_json().unwrap_or(Value::Null))
    }

    fn ensure_daemon(&self) -> Result<()> {
        match self.status() {
            Ok(_) => return Ok(()),
            Err(ureq::Error::Status(401, _)) => {
                bail!("daemon rejected token (another daemon with a different token on this port?)")
            }
            Err(ureq::Error::Status(code, _)) => bail!("unexpected daemon response: HTTP {code}"),
            Err(ureq::Error::Transport(_)) => {}
        }
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(config::log_path())?;
        let mut cmd = std::process::Command::new(std::env::current_exe()?);
        cmd.arg("daemon")
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        cmd.spawn().context("failed to spawn daemon")?;
        for _ in 0..50 {
            sleep(Duration::from_millis(100));
            if self.status().is_ok() {
                return Ok(());
            }
        }
        bail!("daemon failed to start; see {}", config::log_path().display())
    }

    fn send(&self, cmd: &str, args: Value, tab: Option<i64>, timeout_s: u64) -> Result<Value> {
        self.ensure_daemon()?;
        let body = json!({
            "cmd": cmd,
            "args": args,
            "tab": tab,
            "timeout_ms": timeout_s * 1000 + 2000,
            "wait_ext_ms": 15000,
        });
        let resp = ureq::post(&format!("{}/cmd", self.base))
            .set("Authorization", &self.auth())
            .timeout(Duration::from_secs(timeout_s + 25))
            .send_json(body);
        let v: Value = match resp {
            Ok(r) => r.into_json()?,
            Err(ureq::Error::Status(401, _)) => bail!("unauthorized: token mismatch with daemon"),
            Err(e) => return Err(e.into()),
        };
        if v["ok"].as_bool() == Some(true) {
            Ok(v["result"].clone())
        } else {
            bail!("{}", v["error"].as_str().unwrap_or("unknown error"))
        }
    }
}

fn print_value(v: &Value) {
    match v {
        Value::Null => println!("ok"),
        Value::String(s) => println!("{s}"),
        other => println!("{}", serde_json::to_string_pretty(other).unwrap_or_default()),
    }
}

fn run(cli: Cli) -> Result<()> {
    let timeout_ms = cli.timeout * 1000;
    let (name, args): (&str, Value) = match cli.cmd {
        Cmd::Daemon { port } => {
            let port = port.unwrap_or_else(config::port);
            return tokio::runtime::Runtime::new()?.block_on(daemon::run(port));
        }
        Cmd::Token => {
            println!("{}", config::token()?);
            return Ok(());
        }
        Cmd::Stop => {
            let c = Client::new()?;
            match ureq::post(&format!("{}/shutdown", c.base))
                .set("Authorization", &c.auth())
                .timeout(Duration::from_secs(2))
                .call()
            {
                Ok(_) => {
                    for _ in 0..30 {
                        if c.status().is_err() {
                            break;
                        }
                        sleep(Duration::from_millis(100));
                    }
                    println!("daemon stopped")
                }
                Err(ureq::Error::Transport(_)) => println!("daemon not running"),
                Err(e) => return Err(e.into()),
            }
            return Ok(());
        }
        Cmd::Status => {
            let c = Client::new()?;
            c.ensure_daemon()?;
            let s = c.status()?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&s)?);
            } else {
                println!("daemon:    running (pid {}, port {})", s["daemon"]["pid"], config::port());
                match s["extension"].as_object() {
                    Some(e) => println!(
                        "extension: connected (v{}, {})",
                        e.get("version").and_then(Value::as_str).unwrap_or("?"),
                        e.get("browser").and_then(Value::as_str).unwrap_or("?")
                    ),
                    None => println!("extension: not connected"),
                }
            }
            return Ok(());
        }
        Cmd::Tabs => ("tabs", json!({})),
        Cmd::Use { ref tab } => ("use", json!({ "tab": tab })),
        Cmd::Open { ref url, bg } => ("open", json!({ "url": url, "background": bg, "timeout_ms": timeout_ms })),
        Cmd::Goto { ref url } => ("goto", json!({ "url": url, "timeout_ms": timeout_ms })),
        Cmd::Back => ("back", json!({ "timeout_ms": timeout_ms })),
        Cmd::Forward => ("forward", json!({ "timeout_ms": timeout_ms })),
        Cmd::Reload => ("reload", json!({ "timeout_ms": timeout_ms })),
        Cmd::Close { id } => ("close", json!({ "id": id })),
        Cmd::Snapshot { interactive, depth } => ("snapshot", json!({ "interactive": interactive, "depth": depth })),
        Cmd::Click { ref target, double, right } => {
            ("click", json!({ "target": target, "double": double, "right": right }))
        }
        Cmd::Hover { ref target } => ("hover", json!({ "target": target })),
        Cmd::Fill { ref target, ref text } => ("fill", json!({ "target": target, "text": text })),
        Cmd::Type { ref text, ref into } => ("type", json!({ "text": text, "target": into })),
        Cmd::Press { ref key } => ("press", json!({ "key": key })),
        Cmd::Select { ref target, ref value } => ("select", json!({ "target": target, "value": value })),
        Cmd::Scroll { ref direction, amount } => ("scroll", json!({ "direction": direction, "amount": amount })),
        Cmd::ScrollIntoView { ref target } => ("scrollintoview", json!({ "target": target })),
        Cmd::Get { ref what, ref target } => ("get", json!({ "what": what, "target": target })),
        Cmd::Eval { ref js } => ("eval", json!({ "expression": js })),
        Cmd::Screenshot { full, .. } => ("screenshot", json!({ "full": full })),
        Cmd::Wait { ref target, ref text, ref url, load } => {
            let mut a = json!({ "timeout_ms": timeout_ms, "load": load, "text": text, "url": url });
            if let Some(t) = target {
                match t.parse::<u64>() {
                    Ok(ms) => a["ms"] = json!(ms),
                    Err(_) => a["target"] = json!(t),
                }
            }
            ("wait", a)
        }
        Cmd::Detach => ("detach", json!({})),
    };

    let client = Client::new()?;
    let result = client.send(name, args, cli.tab, cli.timeout)?;

    if cli.json {
        if let Cmd::Screenshot { .. } = cli.cmd {
            // fall through to save the file; still print path as JSON below
        } else {
            println!("{}", serde_json::to_string_pretty(&result)?);
            return Ok(());
        }
    }

    match cli.cmd {
        Cmd::Snapshot { .. } => println!("{}", result["text"].as_str().unwrap_or("")),
        Cmd::Tabs => {
            for t in result.as_array().into_iter().flatten() {
                println!(
                    "{} {:>10}  {}  {}",
                    if t["current"].as_bool() == Some(true) { "*" } else { " " },
                    t["id"],
                    t["title"].as_str().unwrap_or(""),
                    t["url"].as_str().unwrap_or("")
                );
            }
        }
        Cmd::Screenshot { path, .. } => {
            let data = result["data"].as_str().context("no screenshot data")?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
            let path = path.unwrap_or_else(|| {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                PathBuf::from(format!("screenshot-{ts}.png"))
            });
            std::fs::write(&path, bytes)?;
            if cli.json {
                println!("{}", json!({ "path": path }));
            } else {
                println!("{}", path.display());
            }
        }
        _ => print_value(&result),
    }
    Ok(())
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
