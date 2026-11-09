//! Embeds ../extension/dist and ./skills into the binary (generated tables in OUT_DIR).
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(root, &p, out);
        } else if p.extension().is_none_or(|x| x != "map") {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            out.push((rel, p));
        }
    }
}

fn table(name: &str, root: &Path) -> String {
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort();
    println!("cargo:rerun-if-changed={}", root.display());
    let mut s = format!("pub static {name}: &[(&str, &[u8])] = &[\n");
    for (rel, p) in files {
        let abs = p.canonicalize().unwrap();
        println!("cargo:rerun-if-changed={}", abs.display());
        writeln!(s, "    ({rel:?}, include_bytes!({:?})),", abs.to_string_lossy()).unwrap();
    }
    s.push_str("];\n");
    s
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest_dir.join("../extension/dist");
    let skills = manifest_dir.join("skills");
    let mut code = String::new();

    if dist.join("manifest.json").is_file() {
        let m: serde_json::Value = serde_json::from_slice(&std::fs::read(dist.join("manifest.json")).unwrap())
            .expect("extension/dist/manifest.json is not valid JSON");
        let v = m["version"].as_str().expect("manifest.json has no version");
        let want = std::env::var("CARGO_PKG_VERSION").unwrap();
        assert!(
            v == want,
            "extension/dist/manifest.json version {v} != bctl version {want}; rebuild the extension (cd extension && pnpm build)"
        );
        code += &table("EXT_FILES", &dist);
        writeln!(code, "pub const EXT_VERSION: Option<&str> = Some({v:?});").unwrap();
    } else {
        println!("cargo:warning=extension/dist not found: this bctl build won't include the extension (cd extension && pnpm build)");
        println!("cargo:rerun-if-changed={}", dist.display());
        code += "pub static EXT_FILES: &[(&str, &[u8])] = &[];\npub const EXT_VERSION: Option<&str> = None;\n";
    }
    code += &table("SKILL_FILES", &skills);

    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("embedded.rs");
    std::fs::write(out, code).unwrap();
    println!("cargo:rerun-if-changed=build.rs");
}
