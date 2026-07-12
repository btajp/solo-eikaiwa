use std::fmt::Write as _;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

fn main() {
  let target = std::env::var("TARGET").expect("TARGET must be set for a Cargo build script");
  let sidecar = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set"))
    .join("binaries")
    .join(format!("solo-server-{target}"));
  println!("cargo:rerun-if-changed={}", sidecar.display());
  let bytes = std::fs::read(&sidecar)
    .unwrap_or_else(|e| panic!("failed to read bundled sidecar {}: {e}", sidecar.display()));
  let digest = Sha256::digest(bytes);
  let mut build_id = String::with_capacity(64);
  for byte in digest {
    write!(&mut build_id, "{byte:02x}").expect("writing to String cannot fail");
  }
  println!("cargo:rustc-env=SOLO_EIKAIWA_SIDECAR_BUILD_ID={build_id}");
  tauri_build::build()
}
