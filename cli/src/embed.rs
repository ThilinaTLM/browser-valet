//! Embedded extension + skills: the managed extension folder, and the `skills` command.
use crate::{dir, VERSION};
use anyhow::{bail, Context, Result};
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};

mod data {
    include!(concat!(env!("OUT_DIR"), "/embedded.rs"));
}
use data::{EXT_FILES, SKILL_FILES};

/// Version of the extension embedded in this binary (None when built without extension/dist).
pub const EMBEDDED_EXT_VERSION: Option<&str> = data::EXT_VERSION;
pub const PAIRING: &str = "pairing.json";
pub const NO_EXT: &str =
    "this bctl build doesn't include the extension; build it with `cd extension && pnpm build` and rebuild bctl";

pub fn ext_dir() -> PathBuf {
    dir().join("extension")
}

/// Write a secret file (mode 0600 on unix).
fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)?.write_all(data)?;
    #[cfg(unix)]
    std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(())
}

pub fn write_pairing(secret: &str, port: u16) -> Result<()> {
    write_private(
        &ext_dir().join(PAIRING),
        json!({"secret":secret,"port":port}).to_string().as_bytes(),
    )
}

fn write_files(root: &Path, files: &[(&str, &[u8])]) -> Result<()> {
    for (rel, data) in files {
        let p = root.join(rel);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(&p, data).with_context(|| format!("writing {}", p.display()))?;
    }
    Ok(())
}

/// Remove files under `root` that aren't in `keep` (relative, '/'-separated) or are `pairing.json` at the top.
fn remove_stale(root: &Path, dir: &Path, keep: &[&str]) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if p.is_dir() {
            remove_stale(root, &p, keep);
            std::fs::remove_dir(&p).ok(); // only succeeds when empty
        } else if rel != PAIRING && !keep.contains(&rel.as_str()) {
            std::fs::remove_file(&p).ok();
        }
    }
}

/// (Re)write the managed extension folder: embedded files + fresh pairing.json; stale files removed.
pub fn write_managed(secret: &str, port: u16) -> Result<PathBuf> {
    if EMBEDDED_EXT_VERSION.is_none() {
        bail!("{NO_EXT}");
    }
    let root = ext_dir();
    std::fs::create_dir_all(&root)?;
    write_files(&root, EXT_FILES)?;
    let keep: Vec<&str> = EXT_FILES.iter().map(|f| f.0).collect();
    remove_stale(&root, &root, &keep);
    write_pairing(secret, port)?;
    Ok(root)
}

// ---- skills ----

fn skill_names() -> Vec<&'static str> {
    let mut v: Vec<&str> = SKILL_FILES.iter().filter_map(|(p, _)| p.split('/').next()).collect();
    v.dedup();
    v
}
fn skill_file(name: &str, rel: &str) -> Option<&'static [u8]> {
    let want = format!("{name}/{rel}");
    SKILL_FILES.iter().find(|(p, _)| *p == want).map(|f| f.1)
}
fn skill_text(name: &str, rel: &str) -> Option<String> {
    skill_file(name, rel).map(|b| String::from_utf8_lossy(b).into_owned())
}
fn description(md: &str) -> String {
    md.lines()
        .skip(1)
        .take_while(|l| l.trim() != "---")
        .find_map(|l| l.strip_prefix("description:"))
        .map(|d| d.trim().to_string())
        .unwrap_or_default()
}
fn references(name: &str) -> Vec<(&'static str, &'static [u8])> {
    let pre = format!("{name}/references/");
    SKILL_FILES
        .iter()
        .filter(|(p, _)| p.starts_with(&pre))
        .map(|(p, d)| (&p[pre.len()..], *d))
        .collect()
}

/// Write skills to `<config dir>/skills/<name>/` (refreshing when the bctl version changed).
fn materialize(only: Option<&str>) -> Result<PathBuf> {
    let root = dir().join("skills");
    let stamp = root.join(".version");
    let fresh = std::fs::read_to_string(&stamp).is_ok_and(|v| v.trim() == VERSION);
    for name in skill_names() {
        let target = root.join(name);
        if fresh && target.is_dir() {
            continue;
        }
        if target.is_dir() {
            std::fs::remove_dir_all(&target).ok();
        }
        let pre = format!("{name}/");
        let files: Vec<(&str, &[u8])> = SKILL_FILES
            .iter()
            .filter(|(p, _)| p.starts_with(&pre))
            .map(|(p, d)| (*p, *d))
            .collect();
        write_files(&root, &files)?;
    }
    std::fs::create_dir_all(&root)?;
    std::fs::write(&stamp, VERSION)?;
    Ok(match only {
        Some(n) => root.join(n),
        None => root,
    })
}

const STUB: &str = "---
name: bctl
description: Drive the user's real, logged-in Chrome with the `bctl` CLI (Browser Bridge). Use when a task needs the user's actual browser session (logins, cookies, open tabs) rather than a fresh test browser.
allowed-tools: Bash(bctl:*)
---

# bctl

Controls the user's real Chrome through the Browser Bridge extension.

Before using it, run `bctl skills get core` and follow that guide (it is versioned with the
installed `bctl`). Full command reference: `bctl skills get core --ref commands`.
";

pub fn skills(args: &[String]) -> Result<i32> {
    let rest: Vec<&String> = args.iter().skip(1).collect();
    let has = |f: &str| rest.iter().any(|a| *a == f);
    let opt = |f: &str| {
        rest.iter()
            .position(|a| *a == f)
            .and_then(|i| rest.get(i + 1))
            .map(|s| s.as_str())
    };
    match args.get(1).map(String::as_str) {
        None | Some("list") => {
            for n in skill_names() {
                println!("{n}\t{}", description(&skill_text(n, "SKILL.md").unwrap_or_default()));
            }
        }
        Some("get") => {
            let name = rest
                .get(1)
                .filter(|a| !a.starts_with("--"))
                .context("usage: bctl skills get <name> [--full] [--ref <ref>]")?;
            let name = name.as_str();
            if let Some(r) = opt("--ref") {
                let Some(t) = skill_text(name, &format!("references/{r}.md")) else {
                    let avail: Vec<_> = references(name)
                        .iter()
                        .map(|r| r.0.trim_end_matches(".md").to_string())
                        .collect();
                    bail!("no reference '{r}' in skill '{name}' (available: {})", avail.join(", "));
                };
                print!("{t}");
            } else {
                let Some(t) = skill_text(name, "SKILL.md") else {
                    bail!("unknown skill '{name}' (see `bctl skills list`)");
                };
                print!("{t}");
                if has("--full") {
                    for (p, d) in references(name) {
                        print!("\n\n<!-- references/{p} -->\n\n{}", String::from_utf8_lossy(d));
                    }
                }
            }
        }
        Some("path") => {
            let name = rest.get(1).filter(|a| !a.starts_with("--")).map(|s| s.as_str());
            if let Some(n) = name {
                if !skill_names().contains(&n) {
                    bail!("unknown skill '{n}' (see `bctl skills list`)");
                }
            }
            println!("{}", materialize(name)?.display());
        }
        Some("install") => {
            let targets: Vec<PathBuf> = match opt("--dir") {
                Some(d) => vec![PathBuf::from(d).join("bctl")],
                None => {
                    let home = dirs::home_dir().context("cannot determine home directory")?;
                    let mut t = Vec::new();
                    if home.join(".claude").is_dir() {
                        t.push(home.join(".claude/skills/bctl"));
                    }
                    t.push(home.join(".agents/skills/bctl"));
                    t
                }
            };
            for t in targets {
                std::fs::create_dir_all(&t)?;
                std::fs::write(t.join("SKILL.md"), STUB)?;
                println!("Installed bctl skill: {}", t.join("SKILL.md").display());
            }
        }
        Some(x) => bail!("unknown skills subcommand '{x}' (list | get <name> | path [name] | install)"),
    }
    Ok(0)
}
