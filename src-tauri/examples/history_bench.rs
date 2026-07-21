use std::{
    fs,
    hint::black_box,
    io::{self, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{TimeZone, Utc};
use quickpaste_lib::history_benchmark::{
    self, CapacityPolicy, ClipboardFile, CollectionScope, HistoryItem, HistoryMutation,
    HistoryQuery,
};
use rusqlite::{params, Connection};

const DATASET_SIZE: usize = 10_000;
const WARMUP_QUERIES: usize = 100;
const MEASURED_QUERIES: usize = 1_000;
const P95_LIMIT: Duration = Duration::from_millis(50);
const SHORT_QUERY_P95_LIMIT: Duration = P95_LIMIT;
const QUERY_MIX: &str = "latest|chinese|pinyin|initials|nfkc+and|ocr|file|kind+source+fts|collection+pinned|multi-in+fts|unfiled|cursor|short-query-sample-set";
const SHORT_QUERY_SAMPLE_SET: &str =
    "han-1|han-2|ascii-1|ascii-2|literal-percent|literal-underscore|short-and|short+fts";
const SHORT_QUERY_SAMPLES: [&str; 8] = ["火", "火箭", "h", "hj", "%", "_", "火 箭", "火 alpha"];
const ONE_PIXEL_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

struct TemporaryDatabase {
    directory: Option<PathBuf>,
}

impl TemporaryDatabase {
    fn create() -> Result<Self, String> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_nanos();
        for attempt in 0..100_u32 {
            let directory = std::env::temp_dir().join(format!(
                "quickpaste-history-bench-{}-{nonce}-{attempt}",
                std::process::id()
            ));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        directory: Some(directory),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("无法创建唯一的历史基准临时目录".into())
    }

    fn database_path(&self) -> PathBuf {
        self.directory
            .as_ref()
            .expect("temporary directory must exist")
            .join("history.sqlite3")
    }

    fn cleanup(&mut self) -> Result<(), String> {
        let Some(directory) = self.directory.clone() else {
            return Ok(());
        };
        let database = directory.join("history.sqlite3");
        let mut first_error = None;
        for path in database_companions(&database) {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    first_error
                        .get_or_insert_with(|| format!("无法清理 {}: {error}", path.display()));
                }
            }
        }
        if let Err(error) = fs::remove_dir(&directory) {
            if error.kind() != io::ErrorKind::NotFound {
                first_error
                    .get_or_insert_with(|| format!("无法清理 {}: {error}", directory.display()));
            }
        }
        if !directory.exists() {
            self.directory = None;
            Ok(())
        } else {
            Err(first_error.unwrap_or_else(|| format!("临时目录仍然存在: {}", directory.display())))
        }
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn database_companions(database: &Path) -> Vec<PathBuf> {
    ["", "-wal", "-shm", "-journal"]
        .into_iter()
        .map(|suffix| {
            let mut path = database.as_os_str().to_os_string();
            path.push(suffix);
            PathBuf::from(path)
        })
        .collect()
}

fn canonical_timestamp(index: usize) -> String {
    let millis = 1_750_000_000_000_i64 + i64::try_from(index / 20).expect("bounded index") * 1_000;
    Utc.timestamp_millis_opt(millis)
        .single()
        .expect("benchmark timestamp")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn base_item(index: usize, kind: &str) -> HistoryItem {
    let copied_at = canonical_timestamp(index);
    HistoryItem {
        id: format!("bench-{index:05}"),
        kind: kind.into(),
        title: format!("QuickPaste benchmark {index}"),
        content: format!("deterministic alpha beta content {index}"),
        source_app: ["Microsoft Word", "Edge", "Explorer", "Visual Studio Code"][index % 4].into(),
        source_app_icon: None,
        copied_at: copied_at.clone(),
        updated_at: copied_at,
        pinned: index % 17 == 0,
        permanent: false,
        collection_id: match index % 4 {
            0 => Some("work".into()),
            1 => Some("personal".into()),
            _ => None,
        },
        search_terms: Vec::new(),
        ocr_text: None,
        ocr_status: None,
        image_hash: None,
        match_source: None,
        color: None,
        dimensions: None,
        formats: vec!["text".into()],
        omitted_formats: Vec::new(),
        payload_loaded: true,
        html: None,
        rtf_base64: None,
        image_url: None,
        files: Vec::new(),
    }
}

fn representative_item(index: usize) -> HistoryItem {
    match index % 6 {
        0 => {
            let mut item = base_item(index, "text");
            item.title = format!("火箭计划 ＡＢＣ {index}");
            item.content = format!("中文检索 alpha beta 发布批次 {index}");
            item.search_terms = vec!["huojian".into(), "hj".into()];
            item
        }
        1 => {
            let mut item = base_item(index, "code");
            item.title = format!("Rust helper {index}");
            item.content = format!("fn benchmark_{index}() {{ println!(\"alpha\"); }}");
            item.source_app = "Visual Studio Code".into();
            item
        }
        2 => {
            let mut item = base_item(index, "link");
            item.title = format!("QuickPaste docs {index}");
            item.content = format!("https://example.com/docs/{index}?query=beta");
            item.source_app = "Edge".into();
            item
        }
        3 => {
            let mut item = base_item(index, "image");
            item.title = format!("票据图片 {index}");
            item.content = format!("clipboard image {index}");
            item.source_app = "Snipping Tool".into();
            item.formats = vec!["image".into()];
            item.image_url = Some(format!("data:image/png;base64,{ONE_PIXEL_PNG_BASE64}"));
            item.ocr_text = Some(format!("发票号码 invoice-{index}"));
            item.ocr_status = Some("completed".into());
            item.image_hash = Some(format!("{index:064x}"));
            item.dimensions = Some("1x1".into());
            item
        }
        4 => {
            let mut item = base_item(index, "file");
            item.title = format!("季度报表 {index}");
            item.content = "文件剪贴板".into();
            item.source_app = "Explorer".into();
            item.formats = vec!["files".into()];
            item.files = vec![ClipboardFile {
                path: format!(r"C:\Bench\季度报表-{index}.xlsx"),
                name: format!("季度报表-{index}.xlsx"),
                extension: Some("xlsx".into()),
                size: Some(4_096 + index as u64),
                modified_at: Some(canonical_timestamp(index)),
                directory: false,
                exists: true,
            }];
            item
        }
        _ => {
            let mut item = base_item(index, "text");
            item.title = format!("富文本发布说明 {index}");
            item.content = format!("rich alpha 发布内容 {index}");
            item.source_app = "Microsoft Word".into();
            item.formats = vec!["text".into(), "html".into(), "rtf".into()];
            item.html = Some(format!("<p>rich <strong>{index}</strong></p>"));
            item.rtf_base64 = Some(STANDARD.encode(format!("{{\\rtf1 rich {index}}}")));
            item
        }
    }
}

fn benchmark_query(index: usize, second_page_cursor: &str) -> HistoryQuery {
    let mut query = HistoryQuery {
        limit: [20, 50, 100, 200][index % 4],
        ..HistoryQuery::default()
    };
    match index % 12 {
        0 => {}
        1 => query.text = "火箭".into(),
        2 => query.text = "huojian".into(),
        3 => query.text = "hj".into(),
        4 => query.text = "ＡＢＣ alpha".into(),
        5 => query.text = "发票号码".into(),
        6 => query.text = "季度报表".into(),
        7 => {
            query.kinds = vec!["code".into()];
            query.source_apps = vec!["Visual Studio Code".into()];
            query.text = "alpha".into();
        }
        8 => {
            query.collection = CollectionScope::Collection { id: "work".into() };
            query.pinned = Some(true);
        }
        9 => {
            query.kinds = vec!["link".into(), "text".into()];
            query.source_apps = vec!["Edge".into(), "Microsoft Word".into()];
            query.text = "beta".into();
        }
        10 => {
            query.collection = CollectionScope::Unfiled {};
            query.kinds = vec!["file".into(), "image".into()];
        }
        _ => {
            query.limit = 100;
            query.cursor = Some(second_page_cursor.into());
        }
    }
    query
}

fn percentile(samples: &[Duration], percentile: f64) -> Duration {
    let index = ((samples.len() as f64 * percentile).ceil() as usize).saturating_sub(1);
    samples[index]
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}

fn run() -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err(
            "history_bench 必须通过 cargo run --release --example history_bench 运行".into(),
        );
    }

    let mut temporary = TemporaryDatabase::create()?;
    let database_path = temporary.database_path();
    let mut database = Connection::open(&database_path).map_err(|error| error.to_string())?;
    history_benchmark::initialize(&mut database)?;
    let image_fixture = STANDARD
        .decode(ONE_PIXEL_PNG_BASE64)
        .map_err(|error| format!("1x1 PNG fixture base64 无效: {error}"))?;
    let image_fixture =
        image::load_from_memory_with_format(&image_fixture, image::ImageFormat::Png)
            .map_err(|error| format!("1x1 PNG fixture 无效: {error}"))?;
    if image_fixture.width() != 1 || image_fixture.height() != 1 {
        return Err("PNG fixture 必须是 1x1".into());
    }
    for (id, name, sort_order) in [("work", "工作", 0_i64), ("personal", "个人", 1_i64)] {
        database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES (?1, ?2, '2025-06-15T00:00:00.000Z', '2025-06-15T00:00:00.000Z', ?3)",
                params![id, name, sort_order],
            )
            .map_err(|error| error.to_string())?;
    }

    let setup_started = Instant::now();
    let items = (0..DATASET_SIZE)
        .map(representative_item)
        .collect::<Vec<_>>();
    history_benchmark::apply(
        &mut database,
        HistoryMutation {
            upserts: items,
            delete_ids: Vec::new(),
            policy: CapacityPolicy::default(),
        },
    )?;
    let (records, projections) = database
        .query_row(
            "SELECT (SELECT COUNT(*) FROM clips), (SELECT COUNT(*) FROM clip_search)",
            [],
            |row| Ok((row.get::<_, usize>(0)?, row.get::<_, usize>(1)?)),
        )
        .map_err(|error| error.to_string())?;
    if records != DATASET_SIZE || projections != DATASET_SIZE {
        return Err(format!(
            "基准数据不完整: records={records}, projections={projections}"
        ));
    }
    database
        .execute(
            "INSERT INTO clip_search_fts(clip_search_fts) VALUES ('integrity-check')",
            [],
        )
        .map_err(|error| error.to_string())?;
    let setup_duration = setup_started.elapsed();
    println!(
        "dataset={DATASET_SIZE} kinds=text/code/link/image/file/rich duplicate_timestamps=20 warmups={WARMUP_QUERIES} samples={MEASURED_QUERIES} query_mix={QUERY_MIX} setup_ms={:.3}",
        milliseconds(setup_duration)
    );
    io::stdout().flush().map_err(|error| error.to_string())?;

    let cursor = history_benchmark::query(
        &database,
        HistoryQuery {
            limit: 100,
            ..HistoryQuery::default()
        },
    )?
    .next_cursor
    .ok_or_else(|| "基准数据不足以生成第二页游标".to_owned())?;

    for index in 0..WARMUP_QUERIES {
        black_box(history_benchmark::query(
            &database,
            benchmark_query(index, &cursor),
        )?);
    }
    let mut samples = Vec::with_capacity(MEASURED_QUERIES);
    for index in 0..MEASURED_QUERIES {
        let started = Instant::now();
        let page = history_benchmark::query(&database, benchmark_query(index, &cursor))?;
        samples.push(started.elapsed());
        black_box(page);
    }
    samples.sort_unstable();
    let p50 = percentile(&samples, 0.50);
    let p95 = percentile(&samples, 0.95);
    let p99 = percentile(&samples, 0.99);

    println!(
        "p50_ms={:.3} p95_ms={:.3} p99_ms={:.3} threshold_ms={:.3}",
        milliseconds(p50),
        milliseconds(p95),
        milliseconds(p99),
        milliseconds(P95_LIMIT)
    );
    io::stdout().flush().map_err(|error| error.to_string())?;
    if p95 > P95_LIMIT {
        return Err(format!(
            "历史搜索 p95 {:.3}ms 超过 {:.3}ms",
            milliseconds(p95),
            milliseconds(P95_LIMIT)
        ));
    }

    for index in 0..WARMUP_QUERIES {
        black_box(history_benchmark::query(
            &database,
            HistoryQuery {
                text: SHORT_QUERY_SAMPLES[index % SHORT_QUERY_SAMPLES.len()].into(),
                limit: 50,
                ..HistoryQuery::default()
            },
        )?);
    }
    let mut short_samples = Vec::with_capacity(MEASURED_QUERIES);
    for index in 0..MEASURED_QUERIES {
        let started = Instant::now();
        let page = history_benchmark::query(
            &database,
            HistoryQuery {
                text: SHORT_QUERY_SAMPLES[index % SHORT_QUERY_SAMPLES.len()].into(),
                limit: 50,
                ..HistoryQuery::default()
            },
        )?;
        short_samples.push(started.elapsed());
        black_box(page);
    }
    short_samples.sort_unstable();
    let short_p50 = percentile(&short_samples, 0.50);
    let short_p95 = percentile(&short_samples, 0.95);
    let short_p99 = percentile(&short_samples, 0.99);
    println!(
        "short_query_sample_set={SHORT_QUERY_SAMPLE_SET} p50_ms={:.3} p95_ms={:.3} p99_ms={:.3} threshold_ms={:.3}",
        milliseconds(short_p50),
        milliseconds(short_p95),
        milliseconds(short_p99),
        milliseconds(SHORT_QUERY_P95_LIMIT)
    );
    io::stdout().flush().map_err(|error| error.to_string())?;
    if short_p95 > SHORT_QUERY_P95_LIMIT {
        return Err(format!(
            "历史短词搜索 p95 {:.3}ms 超过 {:.3}ms",
            milliseconds(short_p95),
            milliseconds(SHORT_QUERY_P95_LIMIT)
        ));
    }

    drop(database);
    temporary.cleanup()?;
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("history benchmark failed: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn benchmark_mix_names_the_dedicated_short_query_sample_set() {
        assert!(QUERY_MIX.contains("short-query-sample-set"));
        assert_eq!(
            SHORT_QUERY_SAMPLE_SET.split('|').count(),
            SHORT_QUERY_SAMPLES.len()
        );
        assert!(SHORT_QUERY_P95_LIMIT <= P95_LIMIT);
    }
}
