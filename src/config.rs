use std::{fs, io, path::PathBuf};

pub const DEFAULT_PORT: u16 = 47823;

pub fn port() -> u16 {
    std::env::var("BCTL_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("browser-bridge")
}

pub fn log_path() -> PathBuf {
    config_dir().join("daemon.log")
}

/// Shared secret between CLI, daemon and extension. Created on first use (mode 0600).
pub fn token() -> io::Result<String> {
    let dir = config_dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join("token");
    if let Ok(t) = fs::read_to_string(&path) {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let mut buf = [0u8; 24];
    getrandom::getrandom(&mut buf).map_err(|e| io::Error::other(e.to_string()))?;
    let token: String = buf.iter().map(|b| format!("{b:02x}")).collect();

    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(&path)?.write_all(token.as_bytes())?;
    Ok(token)
}
