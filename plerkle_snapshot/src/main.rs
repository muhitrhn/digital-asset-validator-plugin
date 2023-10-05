use solana_snapshot_etl::{
    archived::ArchiveSnapshotExtractor, parallel::AppendVecConsumer, SnapshotExtractor,
};
use tracing::info;

use crate::plugin::{load_plugin, GeyserDumper};

mod app_tracing;
pub mod config;
pub mod error;
pub mod plugin;

#[tokio::main]
async fn main() {
    match run().await {
        Ok(_) => {
            println!("Done!")
        }
        Err(e) => {
            println!("Error: {}", e);
        }
    }
}

async fn run() -> Result<(), error::SnappError> {
    let c = config::extract_config()?;
    app_tracing::enable_tracing(c.clone());
    let resp = reqwest::blocking::get(c.snapshot_url.to_string())
    .map_err(|p| {
        error::SnappError::SnapshotDownloadError {
            msg: p.to_string(),
        }
    })?;
    let mut loader = ArchiveSnapshotExtractor::from_reader(resp)?;
    info!("Streaming snapshot from HTTP");
    let plugin = unsafe {
        load_plugin(&c.plugin_config_path.to_string())
        .map_err(|p| {
            error::SnappError::PluginLoadError {
                msg: "Failed to load plugin".to_string(),
            }
        })?
    };
    assert!(
        plugin.account_data_notifications_enabled(),
        "Geyser plugin does not accept account data notifications"
    );
    let mut dumper = GeyserDumper::new(plugin);
    for append_vec in loader.iter() {
        let av = append_vec?;
        dumper.on_append_vec(av).unwrap();
    }
    drop(dumper);
    Ok(())
}
