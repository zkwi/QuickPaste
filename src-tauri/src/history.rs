use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use image::{ImageFormat, ImageReader};
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde::{ser::SerializeMap, Deserialize, Serialize, Serializer};
use unicode_normalization::UnicodeNormalization;

const APPLICATION_ID: i64 = 0x5150_5354;
const SCHEMA_VERSION: i64 = 11;
const SOURCE_APP_ICON_DATA_URL_PREFIX: &str = "data:image/png;base64,";
const SOURCE_APP_ICON_PNG_MAX_BYTES: usize = 32 * 1024;
const HISTORY_DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs(2);
const HISTORY_CURSOR_MAX_UTF16: usize = 512;
const HISTORY_TIMESTAMP_MIN_MILLIS: i64 = -62_167_219_200_000;
const HISTORY_TIMESTAMP_MAX_MILLIS: i64 = 253_402_300_799_999;
const JS_MAX_SAFE_INTEGER_I64: i64 = 9_007_199_254_740_991;
const JS_MAX_SAFE_INTEGER_U64: u64 = JS_MAX_SAFE_INTEGER_I64 as u64;
const MAX_RETENTION_DAYS: i64 = 730_000;
const MAX_COLLECTION_NAME_UTF16: usize = 512;
const HISTORY_ENTITY_ID_ATTEMPTS: usize = 16;
const MAX_BATCH_TARGET_IDS: usize = 10_000;
const OCR_STORED_PNG_MAX_BYTES: i64 = 64 * 1024 * 1024;
const HISTORY_IMAGE_BLOB_MAX_BYTES: usize = 64 * 1024 * 1024;
const HISTORY_THUMBNAIL_MAX_DIMENSION: u32 = 96;
const HISTORY_THUMBNAIL_PNG_MAX_BYTES: usize = 64 * 1024;
const HISTORY_THUMBNAIL_DECODE_MAX_ALLOC_BYTES: u64 = 4 * 1024 * 1024;
const HISTORY_IMAGE_MAX_DIMENSION: u32 = 8_192;
const HISTORY_IMAGE_DECODE_MAX_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
static HISTORY_TEMPORARY_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);
const RESTORE_TOKEN_TTL: Duration = Duration::from_secs(15 * 60);
pub(crate) const HISTORY_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30);
const RESTORE_STAGING_PREFIX: &str = ".quickpaste-restore-";
const RESTORE_STAGING_SUFFIX: &str = ".sqlite3";
const HISTORY_RECOVERY_NOTICE_FILE: &str = "history-recovery-notice.json";
const HISTORY_RECOVERY_NOTICE_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub source_app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_app_icon: Option<String>,
    pub copied_at: String,
    #[serde(default)]
    pub updated_at: String,
    pub pinned: bool,
    #[serde(default)]
    pub permanent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    #[serde(default)]
    pub search_terms: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_source: Option<HistoryMatchSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<String>,
    #[serde(default)]
    pub formats: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_omitted_formats",
        serialize_with = "serialize_omitted_formats",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub omitted_formats: Vec<ClipboardFormat>,
    #[serde(default = "default_payload_loaded")]
    pub payload_loaded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtf_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(default)]
    pub files: Vec<ClipboardFile>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryMatchSource {
    None,
    Direct,
    Index,
    Ocr,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipboardFormat {
    Text,
    Html,
    Rtf,
    Image,
    Files,
    Object,
}

impl ClipboardFormat {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Html => "html",
            Self::Rtf => "rtf",
            Self::Image => "image",
            Self::Files => "files",
            Self::Object => "object",
        }
    }
}

fn canonical_omitted_formats(formats: &[ClipboardFormat]) -> Result<Vec<ClipboardFormat>, String> {
    let unique = formats.iter().copied().collect::<BTreeSet<_>>();
    if unique.len() != formats.len() {
        return Err("省略格式不能重复".into());
    }
    Ok(unique.into_iter().collect())
}

fn deserialize_omitted_formats<'de, D>(deserializer: D) -> Result<Vec<ClipboardFormat>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let formats = Vec::<ClipboardFormat>::deserialize(deserializer)?;
    canonical_omitted_formats(&formats).map_err(serde::de::Error::custom)
}

fn serialize_omitted_formats<S>(
    formats: &[ClipboardFormat],
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    canonical_omitted_formats(formats)
        .map_err(serde::ser::Error::custom)?
        .serialize(serializer)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipboardFile {
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<String>,
    pub directory: bool,
    pub exists: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryMutation {
    pub upserts: Vec<HistoryItem>,
    pub delete_ids: Vec<String>,
    pub policy: CapacityPolicy,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMutationResult {
    pub pruned_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapacityPolicy {
    pub max_records: u64,
    pub max_image_bytes: u64,
    #[serde(deserialize_with = "deserialize_required_option")]
    pub retention_days: Option<i64>,
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

const fn default_max_records() -> u64 {
    10_000
}

const fn default_payload_loaded() -> bool {
    true
}

const fn default_max_image_bytes() -> u64 {
    256 * 1024 * 1024
}

impl Default for CapacityPolicy {
    fn default() -> Self {
        Self {
            max_records: default_max_records(),
            max_image_bytes: default_max_image_bytes(),
            retention_days: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
pub enum CollectionScope {
    Any {},
    Unfiled {},
    Collection { id: String },
}

impl Default for CollectionScope {
    fn default() -> Self {
        Self::Any {}
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryQuery {
    pub text: String,
    pub kinds: Vec<String>,
    pub source_apps: Vec<String>,
    pub collection: CollectionScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permanent: Option<bool>,
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

impl Default for HistoryQuery {
    fn default() -> Self {
        Self {
            text: String::new(),
            kinds: Vec::new(),
            source_apps: Vec::new(),
            collection: CollectionScope::Any {},
            pinned: None,
            permanent: None,
            limit: 100,
            cursor: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub items: Vec<HistoryItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total_count: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingOcrQuery {
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOcrCandidate {
    pub id: String,
    pub image_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingOcrPage {
    pub items: Vec<PendingOcrCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDeleteResult {
    pub affected_count: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnippetDraft {
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub collection_id: Option<String>,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchHistoryQuery {
    pub text: String,
    pub kinds: Vec<String>,
    pub source_apps: Vec<String>,
    pub collection: CollectionScope,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub pinned: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryUpperBound {
    pub copied_at: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BatchTarget {
    Ids {
        ids: Vec<String>,
    },
    Query {
        query: BatchHistoryQuery,
        upper_bound: QueryUpperBound,
        excluded_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BatchAction {
    Move {
        #[serde(deserialize_with = "deserialize_required_option")]
        collection_id: Option<String>,
    },
    SetPinned {
        pinned: bool,
    },
    Delete {},
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub matched_count: u64,
    pub changed_count: u64,
    pub deleted_count: u64,
    pub pruned_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub shm_bytes: u64,
    pub total_physical_bytes: u64,
    pub record_count: u64,
    pub pinned_count: u64,
    pub permanent_count: u64,
    pub image_bytes: u64,
    pub rich_format_bytes: u64,
    pub file_record_count: u64,
    pub logical_bytes: u64,
    pub oldest_copied_at: Option<String>,
    pub newest_copied_at: Option<String>,
    pub max_records: u64,
    pub max_image_bytes: u64,
    pub retention_days: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum BackupResult {
    Cancelled {},
    Saved {},
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PreparedRestoreResult {
    Cancelled {},
    Prepared {
        token: String,
        current_count: u64,
        incoming_count: u64,
        schema_version: i64,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RestoreResult {
    Restored {
        imported_count: u64,
        schema_version: i64,
        policy: CapacityPolicy,
        stats: StorageStats,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DiscardRestoreResult {
    Discarded {},
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryReason {
    Corrupt,
    NotADatabase,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryReadOnlyReason {
    Busy,
    PermissionDenied,
    Io,
    DiskFull,
    Incompatible,
    QuarantineFailed,
    FreshDatabaseFailed,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum HistoryHealthState {
    Healthy,
    Recovered {
        reason: RecoveryReason,
        quarantine_path: String,
    },
    ReadOnly {
        reason: HistoryReadOnlyReason,
    },
    FreshDatabaseFailed {
        recovery_reason: RecoveryReason,
        quarantine_path: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryHealth(HistoryHealthState);

impl HistoryHealth {
    fn healthy() -> Self {
        Self(HistoryHealthState::Healthy)
    }

    fn recovered(reason: RecoveryReason, quarantine_path: String) -> Self {
        Self(HistoryHealthState::Recovered {
            reason,
            quarantine_path,
        })
    }

    fn read_only(reason: HistoryReadOnlyReason) -> Self {
        debug_assert_ne!(reason, HistoryReadOnlyReason::FreshDatabaseFailed);
        Self(HistoryHealthState::ReadOnly { reason })
    }

    fn fresh_database_failed(recovery_reason: RecoveryReason, quarantine_path: String) -> Self {
        Self(HistoryHealthState::FreshDatabaseFailed {
            recovery_reason,
            quarantine_path,
        })
    }
}

impl Serialize for HistoryHealth {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match &self.0 {
            HistoryHealthState::Healthy => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("status", "healthy")?;
                map.end()
            }
            HistoryHealthState::Recovered {
                reason,
                quarantine_path,
            } => {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("status", "recovered")?;
                map.serialize_entry("reason", reason)?;
                map.serialize_entry("quarantinePath", quarantine_path)?;
                map.end()
            }
            HistoryHealthState::ReadOnly { reason } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("status", "readOnlyError")?;
                map.serialize_entry("reason", reason)?;
                map.end()
            }
            HistoryHealthState::FreshDatabaseFailed {
                recovery_reason,
                quarantine_path,
            } => {
                let mut map = serializer.serialize_map(Some(4))?;
                map.serialize_entry("status", "readOnlyError")?;
                map.serialize_entry("reason", &HistoryReadOnlyReason::FreshDatabaseFailed)?;
                map.serialize_entry("recoveryReason", recovery_reason)?;
                map.serialize_entry("quarantinePath", quarantine_path)?;
                map.end()
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub sort_order: i64,
}

pub(crate) fn configure_history_database_connection(
    connection: &rusqlite::Connection,
) -> Result<(), String> {
    configure_history_database_connection_typed(connection).map_err(|error| error.to_string())
}

fn configure_history_database_connection_typed(
    connection: &rusqlite::Connection,
) -> rusqlite::Result<()> {
    connection.busy_timeout(HISTORY_DATABASE_BUSY_TIMEOUT)?;
    connection.execute_batch("PRAGMA synchronous = NORMAL;")?;
    connection.pragma_update(None, "foreign_keys", "ON")
}

struct LegacyRow {
    id: String,
    payload: String,
    image_mime: Option<String>,
    image_data: Option<Vec<u8>>,
}

struct LegacyData {
    rows: Vec<LegacyRow>,
    source_icons: Vec<(String, Vec<u8>)>,
}

#[derive(Debug)]
enum HistoryInitializationFailure {
    Sqlite(rusqlite::Error),
    Contract(String),
}

impl HistoryInitializationFailure {
    fn sqlite(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }

    fn contract(message: impl Into<String>) -> Self {
        Self::Contract(message.into())
    }

    fn open_failure(&self) -> HistoryOpenFailure {
        match self {
            Self::Sqlite(error) => classify_sqlite_error(error),
            Self::Contract(_) => HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Incompatible),
        }
    }
}

impl std::fmt::Display for HistoryInitializationFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => error.fmt(formatter),
            Self::Contract(message) => formatter.write_str(message),
        }
    }
}

impl From<rusqlite::Error> for HistoryInitializationFailure {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Debug)]
enum HistoryWriteFailure {
    Sqlite(rusqlite::Error),
    Contract(String),
}

impl std::fmt::Display for HistoryWriteFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sqlite(error) => error.fmt(formatter),
            Self::Contract(message) => formatter.write_str(message),
        }
    }
}

impl From<rusqlite::Error> for HistoryWriteFailure {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<HistoryWriteFailure> for HistoryInitializationFailure {
    fn from(failure: HistoryWriteFailure) -> Self {
        match failure {
            HistoryWriteFailure::Sqlite(error) => Self::Sqlite(error),
            HistoryWriteFailure::Contract(message) => Self::Contract(message),
        }
    }
}

fn write_contract_failure(message: impl Into<String>) -> HistoryWriteFailure {
    HistoryWriteFailure::Contract(message.into())
}

fn contract_failure(message: impl Into<String>) -> HistoryInitializationFailure {
    HistoryInitializationFailure::contract(message)
}

pub(crate) fn initialize_history_database(connection: &mut Connection) -> Result<(), String> {
    initialize_history_database_classified(connection).map_err(|failure| failure.to_string())
}

fn initialize_history_database_classified(
    connection: &mut Connection,
) -> Result<(), HistoryInitializationFailure> {
    connection
        .busy_timeout(HISTORY_DATABASE_BUSY_TIMEOUT)
        .map_err(HistoryInitializationFailure::sqlite)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(HistoryInitializationFailure::sqlite)?;
    let application_id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(HistoryInitializationFailure::sqlite)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(HistoryInitializationFailure::sqlite)?;
    if application_id == APPLICATION_ID && version == SCHEMA_VERSION {
        return Ok(());
    }
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(HistoryInitializationFailure::contract(
            "不是 QuickPaste 历史数据库",
        ));
    }
    if version > SCHEMA_VERSION {
        return Err(HistoryInitializationFailure::contract(format!(
            "历史数据库版本 {version} 高于当前版本"
        )));
    }
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        .map_err(HistoryInitializationFailure::sqlite)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(HistoryInitializationFailure::sqlite)?;
    let result = initialize_history_schema(&transaction);

    match result {
        Ok(()) => transaction
            .commit()
            .map_err(HistoryInitializationFailure::sqlite),
        Err(failure) => {
            let _ = transaction.rollback();
            Err(failure)
        }
    }
}

fn initialize_history_schema(
    transaction: &Transaction<'_>,
) -> Result<(), HistoryInitializationFailure> {
    let application_id: i64 =
        transaction.query_row("PRAGMA application_id", [], |row| row.get(0))?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(contract_failure("不是 QuickPaste 历史数据库"));
    }
    transaction.pragma_update(None, "application_id", APPLICATION_ID)?;

    let mut version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(contract_failure(format!(
            "历史数据库版本 {version} 高于当前版本"
        )));
    }

    let legacy = if version == 0 && transaction_has_table(transaction, "clipboard_items")? {
        Some(read_legacy_data(transaction)?)
    } else {
        None
    };
    if legacy.is_some() {
        transaction
            .execute_batch("DROP TABLE clipboard_items; DROP TABLE IF EXISTS source_app_icons;")?;
    }

    while version < SCHEMA_VERSION {
        match version {
            0 => migrate_to_v1(transaction)?,
            1 => migrate_to_v2(transaction)?,
            2 => migrate_to_v3(transaction)?,
            3 => migrate_to_v4(transaction)?,
            4 => migrate_to_v5(transaction)?,
            5 => migrate_to_v6(transaction)?,
            6 => migrate_to_v7(transaction)?,
            7 => migrate_to_v8(transaction)?,
            8 => migrate_to_v9(transaction)?,
            9 => migrate_to_v10(transaction)?,
            10 => migrate_to_v11(transaction)?,
            _ => {
                return Err(contract_failure(format!(
                    "不支持的历史数据库版本 {version}"
                )))
            }
        }
        version += 1;
        transaction.execute_batch(&format!("PRAGMA user_version = {version}"))?;
    }

    if let Some(legacy) = legacy {
        backfill_legacy_data(transaction, legacy)?;
    }

    Ok(())
}

fn backfill_legacy_data(
    transaction: &Transaction<'_>,
    legacy: LegacyData,
) -> Result<(), HistoryInitializationFailure> {
    for row in legacy.rows {
        let item = history_item_from_legacy(row).map_err(contract_failure)?;
        let item = normalize_history_item(item).map_err(contract_failure)?;
        validate_history_item(&item).map_err(contract_failure)?;
        let _ =
            upsert_history_item(transaction, &item).map_err(HistoryInitializationFailure::from)?;
    }
    for (source_app, icon_png) in legacy.source_icons {
        if source_app_icon_png_is_safe(&icon_png) {
            transaction.execute(
                "INSERT INTO source_app_icons(source_app, icon_png) VALUES (?1, ?2)
                 ON CONFLICT(source_app) DO UPDATE SET icon_png = excluded.icon_png",
                params![source_app, icon_png],
            )?;
        }
    }
    Ok(())
}

fn transaction_has_table(
    transaction: &Transaction<'_>,
    name: &str,
) -> Result<bool, HistoryInitializationFailure> {
    transaction
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [name],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count == 1)
        .map_err(HistoryInitializationFailure::from)
}

fn read_legacy_data(
    transaction: &Transaction<'_>,
) -> Result<LegacyData, HistoryInitializationFailure> {
    let mut statement = transaction.prepare(
        "SELECT id, payload, image_mime, image_data
             FROM clipboard_items ORDER BY position ASC, id ASC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(LegacyRow {
                id: row.get(0)?,
                payload: row.get(1)?,
                image_mime: row.get(2)?,
                image_data: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    let source_icons = if transaction_has_table(transaction, "source_app_icons")? {
        let mut statement =
            transaction.prepare("SELECT source_app, icon_png FROM source_app_icons")?;
        let icons = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        icons
    } else {
        Vec::new()
    };

    Ok(LegacyData { rows, source_icons })
}

fn migrate_to_v1(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "CREATE TABLE clips (
               id TEXT PRIMARY KEY NOT NULL,
               kind TEXT NOT NULL,
               title TEXT NOT NULL,
               plain_text TEXT NOT NULL,
               source_app TEXT NOT NULL,
               copied_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
               search_terms TEXT NOT NULL DEFAULT '[]',
               ocr_text TEXT,
               ocr_status TEXT,
               logical_bytes INTEGER NOT NULL DEFAULT 0,
               color TEXT,
               dimensions TEXT
             );",
    )?;
    Ok(())
}

fn migrate_to_v2(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "CREATE TABLE clip_formats (
               clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
               format TEXT NOT NULL CHECK(format IN ('text', 'html', 'rtf', 'image')),
               mime TEXT,
               data BLOB,
               PRIMARY KEY (clip_id, format)
             );
             CREATE TABLE clip_files (
               clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               path TEXT NOT NULL,
               name TEXT NOT NULL,
               extension TEXT,
               size INTEGER CHECK(size IS NULL OR size >= 0),
               modified_at TEXT,
               directory INTEGER NOT NULL CHECK(directory IN (0, 1)),
               exists_at_capture INTEGER NOT NULL CHECK(exists_at_capture IN (0, 1)),
               PRIMARY KEY (clip_id, ordinal)
             );",
    )?;
    Ok(())
}

fn migrate_to_v3(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "CREATE TABLE collections (
               id TEXT PRIMARY KEY NOT NULL,
               name TEXT NOT NULL UNIQUE,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL,
               sort_order INTEGER NOT NULL DEFAULT 0
             );
             ALTER TABLE clips ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0
               CHECK(permanent IN (0, 1));
             ALTER TABLE clips ADD COLUMN collection_id TEXT
               REFERENCES collections(id) ON DELETE SET NULL;",
    )?;
    Ok(())
}

fn migrate_to_v4(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "CREATE TABLE source_app_icons (
               source_app TEXT PRIMARY KEY NOT NULL,
               icon_png BLOB NOT NULL CHECK(length(icon_png) <= 32768)
             );
             CREATE INDEX clips_copied_at_id ON clips(copied_at DESC, id DESC);
             CREATE INDEX clips_unprotected_age ON clips(pinned, permanent, copied_at ASC, id ASC);
             CREATE INDEX clip_formats_image_bytes ON clip_formats(format, clip_id);",
    )?;
    Ok(())
}

fn migrate_to_v5(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "ALTER TABLE clips ADD COLUMN omitted_formats TEXT NOT NULL DEFAULT '[]';",
    )?;
    Ok(())
}

fn migrate_to_v6(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction
        .execute_batch(
            "CREATE TABLE clip_search (
               rowid INTEGER PRIMARY KEY,
               clip_id TEXT NOT NULL UNIQUE REFERENCES clips(id) ON DELETE CASCADE,
               normalized_text TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE clip_search_fts USING fts5(
               normalized_text,
               content='clip_search',
               content_rowid='rowid',
               tokenize='trigram'
             );
             CREATE TRIGGER clip_search_after_insert AFTER INSERT ON clip_search BEGIN
               INSERT INTO clip_search_fts(rowid, normalized_text)
               VALUES (new.rowid, new.normalized_text);
             END;
             CREATE TRIGGER clip_search_after_delete AFTER DELETE ON clip_search BEGIN
               INSERT INTO clip_search_fts(clip_search_fts, rowid, normalized_text)
               VALUES ('delete', old.rowid, old.normalized_text);
             END;
             CREATE TRIGGER clip_search_after_update AFTER UPDATE OF normalized_text ON clip_search BEGIN
               INSERT INTO clip_search_fts(clip_search_fts, rowid, normalized_text)
               VALUES ('delete', old.rowid, old.normalized_text);
               INSERT INTO clip_search_fts(rowid, normalized_text)
               VALUES (new.rowid, new.normalized_text);
             END;
             CREATE INDEX clips_kind_source_age
               ON clips(kind, source_app, copied_at DESC, id DESC);
             CREATE INDEX clips_source_age
               ON clips(source_app, copied_at DESC, id DESC);
             CREATE INDEX clips_pinned_age
               ON clips(pinned, copied_at DESC, id DESC);
             CREATE INDEX clips_collection_pinned_age
               ON clips(collection_id, pinned, copied_at DESC, id DESC);",
        )?;

    let mut files_by_clip = BTreeMap::<String, Vec<(String, String)>>::new();
    let mut statement = transaction
        .prepare("SELECT clip_id, path, name FROM clip_files ORDER BY clip_id, ordinal")?;
    let files = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (clip_id, path, name) in files {
        files_by_clip.entry(clip_id).or_default().push((path, name));
    }

    let mut statement = transaction.prepare(
        "SELECT id, title, plain_text, source_app, search_terms, ocr_text
             FROM clips ORDER BY id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);

    for (id, title, plain_text, source_app, search_terms, ocr_text) in rows {
        let search_terms = serde_json::from_str::<Vec<String>>(&search_terms)
            .map_err(|error| contract_failure(format!("无法迁移搜索词: {error}")))?;
        let normalized_text = build_search_projection(
            &title,
            &plain_text,
            &source_app,
            &search_terms,
            ocr_text.as_deref(),
            files_by_clip
                .get(&id)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        transaction.execute(
            "INSERT INTO clip_search(clip_id, normalized_text) VALUES (?1, ?2)",
            params![id, normalized_text],
        )?;
    }
    Ok(())
}

fn migrate_to_v7(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "CREATE TABLE history_settings (
               singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
               max_records INTEGER NOT NULL
                 CHECK(typeof(max_records) = 'integer' AND max_records >= 0),
               max_image_bytes INTEGER NOT NULL
                 CHECK(typeof(max_image_bytes) = 'integer' AND max_image_bytes >= 0),
               retention_days INTEGER
                 CHECK(retention_days IS NULL OR
                   (typeof(retention_days) = 'integer' AND retention_days >= 0)),
               revision INTEGER NOT NULL
                 CHECK(typeof(revision) = 'integer' AND revision >= 0)
             ) WITHOUT ROWID;
             INSERT INTO history_settings(
               singleton, max_records, max_image_bytes, retention_days, revision
             ) VALUES (1, 500, 268435456, 30, 0);",
    )?;
    Ok(())
}

fn migrate_to_v8(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    list_history_collections(transaction).map_err(contract_failure)?;
    transaction.execute_batch(
        "CREATE UNIQUE INDEX collections_name_binary
           ON collections(name COLLATE BINARY);
         CREATE INDEX collections_sort_order_id
           ON collections(sort_order ASC, id ASC);
         CREATE TRIGGER collections_validate_insert BEFORE INSERT ON collections
         WHEN typeof(new.name) != 'text'
           OR length(new.name) = 0
           OR typeof(new.created_at) != 'text'
           OR typeof(new.updated_at) != 'text'
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.created_at) IS NULL
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.created_at) != new.created_at
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.updated_at) IS NULL
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.updated_at) != new.updated_at
           OR new.created_at > new.updated_at
           OR typeof(new.sort_order) != 'integer'
           OR new.sort_order < -9007199254740991
           OR new.sort_order > 9007199254740991
         BEGIN
           SELECT RAISE(ABORT, 'invalid collection');
         END;
         CREATE TRIGGER collections_validate_update BEFORE UPDATE ON collections
         WHEN typeof(new.name) != 'text'
           OR length(new.name) = 0
           OR typeof(new.created_at) != 'text'
           OR typeof(new.updated_at) != 'text'
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.created_at) IS NULL
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.created_at) != new.created_at
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.updated_at) IS NULL
           OR strftime('%Y-%m-%dT%H:%M:%fZ', new.updated_at) != new.updated_at
           OR new.created_at > new.updated_at
           OR typeof(new.sort_order) != 'integer'
           OR new.sort_order < -9007199254740991
           OR new.sort_order > 9007199254740991
         BEGIN
           SELECT RAISE(ABORT, 'invalid collection');
         END;",
    )?;
    Ok(())
}

fn migrate_to_v9(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "ALTER TABLE clips ADD COLUMN image_hash TEXT
           CHECK(image_hash IS NULL OR (
             kind = 'image'
             AND typeof(image_hash) = 'text'
             AND length(image_hash) = 64
             AND image_hash NOT GLOB '*[^0-9a-f]*'
           ));
         CREATE INDEX clips_image_hash_ocr
           ON clips(image_hash, ocr_status)
           WHERE image_hash IS NOT NULL;",
    )?;

    // v1 哈希基于原始 RGBA 字节，旧记录只有编码后的 PNG，无法可靠补算。
    // 在同一迁移事务中清除旧 OCR 派生数据，保留图片正文，并同步移除 FTS 投影。
    let legacy_ocr_ids = {
        let mut statement = transaction.prepare(
            "SELECT id FROM clips WHERE ocr_status IS NOT NULL OR ocr_text IS NOT NULL ORDER BY id",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    transaction.execute(
        "UPDATE clips SET ocr_text = NULL, ocr_status = NULL
         WHERE image_hash IS NULL AND (ocr_status IS NOT NULL OR ocr_text IS NOT NULL)",
        [],
    )?;
    for id in legacy_ocr_ids {
        refresh_search_projection(transaction, &id)?;
    }
    Ok(())
}

fn migrate_to_v10(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    // v0.10 及更早版本可能使用用户配置中的英文 OCR 引擎处理中文图片。
    // 仅重排已有终态结果；从未启用 OCR 的图片保持原样，尊重用户设置。
    let stale_ocr_ids = {
        let mut statement = transaction.prepare(
            "SELECT id FROM clips
             WHERE kind = 'image' AND image_hash IS NOT NULL
               AND (ocr_text IS NOT NULL
                    OR (ocr_status IS NOT NULL AND ocr_status <> 'pending'))
             ORDER BY id",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    transaction.execute(
        "UPDATE clips SET ocr_text = NULL, ocr_status = 'pending'
         WHERE kind = 'image' AND image_hash IS NOT NULL
           AND (ocr_text IS NOT NULL
                OR (ocr_status IS NOT NULL AND ocr_status <> 'pending'))",
        [],
    )?;
    for id in stale_ocr_ids {
        refresh_search_projection(transaction, &id)?;
    }
    Ok(())
}

fn migrate_to_v11(transaction: &Transaction<'_>) -> Result<(), HistoryInitializationFailure> {
    transaction.execute_batch(
        "CREATE TABLE clip_thumbnails (
           clip_id TEXT PRIMARY KEY NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
           thumbnail_png BLOB NOT NULL CHECK(
             typeof(thumbnail_png) = 'blob'
             AND length(thumbnail_png) BETWEEN 1 AND 65536
           )
         ) WITHOUT ROWID;",
    )?;
    Ok(())
}

fn normalize_search_text(value: &str) -> String {
    value
        .nfkc()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character == '\u{03c2}' {
                '\u{03c3}'
            } else {
                character
            }
        })
        .collect::<String>()
        .split(|character: char| character.is_whitespace() || character == '\u{feff}')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_query_text(value: &str) -> String {
    normalize_search_text(value)
}

fn build_search_projection(
    title: &str,
    plain_text: &str,
    source_app: &str,
    search_terms: &[String],
    ocr_text: Option<&str>,
    files: &[(String, String)],
) -> String {
    let mut parts = vec![title, plain_text, source_app];
    parts.extend(search_terms.iter().map(String::as_str));
    if let Some(ocr_text) = ocr_text {
        parts.push(ocr_text);
    }
    for (path, name) in files {
        parts.push(path);
        parts.push(name);
    }
    normalize_search_text(&parts.join("\n"))
}

fn write_search_projection(
    transaction: &Transaction<'_>,
    clip_id: &str,
    normalized_text: &str,
) -> Result<(), HistoryWriteFailure> {
    transaction
        .execute(
            "INSERT INTO clip_search(clip_id, normalized_text) VALUES (?1, ?2)
             ON CONFLICT(clip_id) DO UPDATE SET normalized_text = excluded.normalized_text",
            params![clip_id, normalized_text],
        )
        .map(|_| ())
        .map_err(HistoryWriteFailure::from)
}

fn write_item_search_projection(
    transaction: &Transaction<'_>,
    item: &HistoryItem,
) -> Result<(), HistoryWriteFailure> {
    let files = item
        .files
        .iter()
        .map(|file| (file.path.clone(), file.name.clone()))
        .collect::<Vec<_>>();
    let normalized_text = build_search_projection(
        &item.title,
        &item.content,
        &item.source_app,
        &item.search_terms,
        item.ocr_text.as_deref(),
        &files,
    );
    write_search_projection(transaction, &item.id, &normalized_text)
}

fn refresh_search_projection(
    transaction: &Transaction<'_>,
    clip_id: &str,
) -> Result<(), HistoryWriteFailure> {
    let (title, plain_text, source_app, search_terms, ocr_text) = transaction.query_row(
        "SELECT title, plain_text, source_app, search_terms, ocr_text
             FROM clips WHERE id = ?1",
        [clip_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        },
    )?;
    let search_terms = serde_json::from_str::<Vec<String>>(&search_terms)
        .map_err(|error| write_contract_failure(format!("无法读取搜索词: {error}")))?;
    let mut statement = transaction
        .prepare("SELECT path, name FROM clip_files WHERE clip_id = ?1 ORDER BY ordinal")?;
    let files = statement
        .query_map([clip_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<(String, String)>, _>>()?;
    drop(statement);
    let normalized_text = build_search_projection(
        &title,
        &plain_text,
        &source_app,
        &search_terms,
        ocr_text.as_deref(),
        &files,
    );
    write_search_projection(transaction, clip_id, &normalized_text)
}

fn javascript_string_cmp(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn trim_query_value(value: &str) -> &str {
    value.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}')
}

fn history_id_is_cursor_safe(id: &str) -> bool {
    !id.is_empty()
        && trim_query_value(id) == id
        && !id.chars().any(char::is_control)
        && STANDARD
            .encode(format!("{}\n{id}", i64::MIN))
            .encode_utf16()
            .count()
            <= HISTORY_CURSOR_MAX_UTF16
}

pub(crate) fn normalize_history_query(mut query: HistoryQuery) -> Result<HistoryQuery, String> {
    query.text = normalize_query_text(&query.text);

    let requested_kinds = query.kinds.into_iter().collect::<BTreeSet<_>>();
    if requested_kinds
        .iter()
        .any(|kind| !matches!(kind.as_str(), "text" | "code" | "link" | "image" | "file"))
    {
        return Err("历史类型筛选无效".to_owned());
    }
    query.kinds = ["text", "code", "link", "image", "file"]
        .into_iter()
        .filter(|kind| requested_kinds.contains(*kind))
        .map(str::to_owned)
        .collect();

    query.source_apps = query
        .source_apps
        .into_iter()
        .map(|source| trim_query_value(&source).to_owned())
        .filter(|source| !source.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    query
        .source_apps
        .sort_by(|left, right| javascript_string_cmp(left, right));

    if let CollectionScope::Collection { id } = &mut query.collection {
        *id = trim_query_value(id).to_owned();
        let mut characters = id.chars();
        if id.len() > 128
            || !characters
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            || characters.any(|character| {
                !character.is_ascii_alphanumeric() && !matches!(character, '.' | '_' | ':' | '-')
            })
        {
            return Err("历史集合标识无效".to_owned());
        }
    }
    if !(1..=200).contains(&query.limit) {
        return Err("历史分页大小无效".to_owned());
    }
    if let Some(cursor) = &query.cursor {
        if cursor.is_empty()
            || trim_query_value(cursor) != cursor
            || cursor.encode_utf16().count() > HISTORY_CURSOR_MAX_UTF16
            || cursor.chars().any(char::is_control)
            || decode_cursor(cursor).is_err()
        {
            return Err("历史分页游标无效".to_owned());
        }
    }
    Ok(query)
}

fn history_item_from_legacy(row: LegacyRow) -> Result<HistoryItem, String> {
    let value: serde_json::Value = serde_json::from_str(&row.payload)
        .map_err(|error| format!("无法读取 legacy 剪贴板记录 {}: {error}", row.id))?;
    let object = value
        .as_object()
        .ok_or_else(|| format!("legacy 剪贴板记录 {} 不是对象", row.id))?;
    let content = object
        .get("content")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("legacy 剪贴板记录 {} 缺少 content", row.id))?
        .to_owned();
    let copied_at = object
        .get("copiedAt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("1970-01-01T00:00:00.000Z")
        .to_owned();
    let image_url = row.image_data.map(|data| {
        format!(
            "data:{};base64,{}",
            row.image_mime.unwrap_or_else(|| "image/png".into()),
            STANDARD.encode(data)
        )
    });
    let mut formats = object
        .get("formats")
        .and_then(serde_json::Value::as_array)
        .map(|formats| {
            formats
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if formats.is_empty() {
        formats.push(if image_url.is_some() { "image" } else { "text" }.into());
    }
    if image_url.is_some() && !formats.iter().any(|format| format == "image") {
        formats.push("image".into());
    }

    let files = object
        .get("files")
        .and_then(serde_json::Value::as_array)
        .map(|files| {
            files
                .iter()
                .cloned()
                .map(serde_json::from_value)
                .collect::<Result<Vec<ClipboardFile>, _>>()
        })
        .transpose()
        .map_err(|error| format!("无法读取 legacy 文件记录 {}: {error}", row.id))?
        .unwrap_or_default();

    Ok(HistoryItem {
        id: object
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&row.id)
            .to_owned(),
        kind: object
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(if image_url.is_some() { "image" } else { "text" })
            .to_owned(),
        title: object
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| content.chars().take(36).collect()),
        content,
        source_app: object
            .get("sourceApp")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        source_app_icon: None,
        copied_at: copied_at.clone(),
        updated_at: object
            .get("updatedAt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&copied_at)
            .to_owned(),
        pinned: object
            .get("pinned")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        permanent: object
            .get("permanent")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        collection_id: object
            .get("collectionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        search_terms: object
            .get("searchTerms")
            .and_then(serde_json::Value::as_array)
            .map(|terms| {
                terms
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        ocr_text: object
            .get("ocrText")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        ocr_status: object
            .get("ocrStatus")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        image_hash: object
            .get("imageHash")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        match_source: None,
        color: object
            .get("color")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        dimensions: object
            .get("dimensions")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        formats,
        omitted_formats: object
            .get("omittedFormats")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| format!("无法读取 legacy 省略格式 {}: {error}", row.id))?
            .unwrap_or_default(),
        payload_loaded: true,
        html: object
            .get("html")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        rtf_base64: object
            .get("rtfBase64")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        image_url,
        files,
    })
}

pub(crate) fn apply_history_mutation(
    connection: &mut Connection,
    mutation: HistoryMutation,
) -> Result<HistoryMutationResult, String> {
    initialize_history_database(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = apply_history_mutation_in_transaction(&transaction, mutation);

    match result {
        Ok((result, pending_thumbnails)) => {
            transaction.commit().map_err(|error| error.to_string())?;
            for (clip_id, thumbnail_png) in pending_thumbnails {
                let _ = connection.execute(
                    "INSERT INTO clip_thumbnails(clip_id, thumbnail_png)
                     SELECT ?1, ?2 WHERE EXISTS(
                       SELECT 1 FROM clips WHERE id = ?1 AND kind = 'image'
                     )
                     ON CONFLICT(clip_id) DO UPDATE SET thumbnail_png = excluded.thumbnail_png",
                    params![clip_id, thumbnail_png],
                );
            }
            Ok(result)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn apply_history_mutation_in_transaction(
    transaction: &Transaction<'_>,
    mutation: HistoryMutation,
) -> Result<(HistoryMutationResult, BTreeMap<String, Vec<u8>>), String> {
    let delete_ids = mutation.delete_ids.into_iter().collect::<BTreeSet<_>>();
    let mut upserts = Vec::with_capacity(mutation.upserts.len());
    for raw_item in mutation.upserts {
        let item = normalize_history_item(raw_item)?;
        validate_history_item(&item)?;
        if !item.payload_loaded && item.source_app_icon.is_some() {
            return Err("摘要写入不能携带来源应用图标".into());
        }
        if delete_ids.contains(&item.id) {
            return Err("同一记录不能同时删除和更新".into());
        }
        if !item.payload_loaded && !clip_exists(transaction, &item.id)? {
            return Err("摘要记录不能创建新的剪贴板正文".into());
        }
        upserts.push(item);
    }

    let mut source_icons = BTreeMap::new();
    let mut duplicate_image_ids = BTreeSet::new();
    let mut pending_thumbnails = BTreeMap::new();
    for mut item in upserts {
        if item.payload_loaded && item.kind == "image" {
            if let Some(image_hash) = item.image_hash.as_deref() {
                let same_image = same_image_state(transaction, &item.id, image_hash)?;
                item.pinned |= same_image.pinned;
                if item.collection_id.is_none() {
                    item.collection_id = same_image.collection_id;
                }
                if item.ocr_status.as_deref() == Some("pending") {
                    if let Some((status, text)) = same_image.terminal_ocr {
                        item.ocr_status = Some(status);
                        item.ocr_text = text;
                    }
                }
                validate_history_item(&item)?;
                for duplicate_id in same_image.duplicate_ids {
                    let deleted = transaction
                        .execute("DELETE FROM clips WHERE id = ?1", [&duplicate_id])
                        .map_err(|error| error.to_string())?;
                    if deleted > 0 {
                        duplicate_image_ids.insert(duplicate_id);
                    }
                }
            }
        }
        if item.payload_loaded {
            if let (Some(icon), false) = (&item.source_app_icon, item.source_app.is_empty()) {
                if let Some(icon_png) = source_app_icon_png_from_data_url(icon) {
                    source_icons
                        .entry(item.source_app.clone())
                        .or_insert(icon_png);
                }
            }
        }
        if item.payload_loaded {
            pending_thumbnails.remove(&item.id);
        }
        if let Some(thumbnail_png) =
            upsert_history_item(transaction, &item).map_err(|error| error.to_string())?
        {
            pending_thumbnails.insert(item.id.clone(), thumbnail_png);
        }
    }
    for id in delete_ids {
        transaction
            .execute("DELETE FROM clips WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
    }
    for (source_app, icon_png) in source_icons {
        transaction
            .execute(
                "INSERT INTO source_app_icons(source_app, icon_png) VALUES (?1, ?2)
                 ON CONFLICT(source_app) DO UPDATE SET icon_png = excluded.icon_png",
                params![source_app, icon_png],
            )
            .map_err(|error| error.to_string())?;
    }

    write_history_settings(transaction, &mutation.policy)?;
    let mut result = prune_capacity(transaction, &mutation.policy)?;
    duplicate_image_ids.extend(result.pruned_ids);
    for id in &duplicate_image_ids {
        pending_thumbnails.remove(id);
    }
    result.pruned_ids = duplicate_image_ids.into_iter().collect();
    Ok((result, pending_thumbnails))
}

#[derive(Default)]
struct SameImageState {
    duplicate_ids: Vec<String>,
    pinned: bool,
    collection_id: Option<String>,
    terminal_ocr: Option<(String, Option<String>)>,
}

fn same_image_state(
    transaction: &Transaction<'_>,
    incoming_id: &str,
    image_hash: &str,
) -> Result<SameImageState, String> {
    if !image_hash_is_canonical(image_hash) {
        return Ok(SameImageState::default());
    }
    let mut statement = transaction
        .prepare(
            "SELECT id, pinned, collection_id, ocr_status, ocr_text
             FROM clips
             WHERE kind = 'image' AND image_hash = ?1
             ORDER BY copied_at DESC, id DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([image_hash], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? != 0,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    let mut state = SameImageState::default();
    for (id, pinned, collection_id, status, text) in rows {
        if state.terminal_ocr.is_none()
            && matches!(
                status.as_deref(),
                Some("completed" | "unavailable" | "oversized")
            )
            && (status.as_deref() != Some("completed") || text.is_some())
        {
            state.terminal_ocr = status.map(|status| (status, text));
        }
        if id == incoming_id {
            continue;
        }
        state.duplicate_ids.push(id);
        state.pinned |= pinned;
        if state.collection_id.is_none() {
            state.collection_id = collection_id;
        }
    }
    Ok(state)
}

fn write_history_settings(
    transaction: &Transaction<'_>,
    policy: &CapacityPolicy,
) -> Result<(), String> {
    if policy.max_records > JS_MAX_SAFE_INTEGER_U64
        || policy.max_image_bytes > JS_MAX_SAFE_INTEGER_U64
    {
        return Err("历史存储策略超出前端安全整数范围".to_owned());
    }
    let max_records = i64::try_from(policy.max_records)
        .map_err(|_| "记录数量上限超出 SQLite 整数范围".to_owned())?;
    let max_image_bytes = i64::try_from(policy.max_image_bytes)
        .map_err(|_| "图片容量上限超出 SQLite 整数范围".to_owned())?;
    if policy
        .retention_days
        .is_some_and(|days| !(0..=MAX_RETENTION_DAYS).contains(&days))
    {
        return Err("保留天数超出支持范围".into());
    }
    let updated = transaction
        .execute(
            "UPDATE history_settings SET
               max_records = ?1,
               max_image_bytes = ?2,
               retention_days = ?3,
               revision = revision + 1
             WHERE singleton = 1",
            params![max_records, max_image_bytes, policy.retention_days],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("历史设置单例缺失".into());
    }
    Ok(())
}

fn normalize_history_item(mut item: HistoryItem) -> Result<HistoryItem, String> {
    item.formats = canonical_actual_formats(&item.formats)?;
    item.omitted_formats = canonical_omitted_formats(&item.omitted_formats)?;
    item.copied_at = normalize_timestamp(&item.copied_at)?;
    if item.updated_at.trim().is_empty() {
        if item.payload_loaded {
            item.updated_at.clone_from(&item.copied_at);
        }
    } else {
        item.updated_at = normalize_timestamp(&item.updated_at)?;
    }
    Ok(item)
}

fn canonical_actual_formats(formats: &[String]) -> Result<Vec<String>, String> {
    let mut unique = BTreeSet::new();
    for format in formats {
        if !matches!(format.as_str(), "text" | "html" | "rtf" | "image" | "files") {
            return Err("剪贴板记录包含不支持的格式".into());
        }
        if !unique.insert(format.as_str()) {
            return Err("剪贴板记录格式不能重复".into());
        }
    }
    Ok(["text", "html", "rtf", "image", "files"]
        .into_iter()
        .filter(|format| unique.contains(format))
        .map(str::to_owned)
        .collect())
}

fn normalize_timestamp(value: &str) -> Result<String, String> {
    let timestamp = chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|error| format!("时间戳无效: {error}"))?
        .with_timezone(&Utc);
    if !(HISTORY_TIMESTAMP_MIN_MILLIS..=HISTORY_TIMESTAMP_MAX_MILLIS)
        .contains(&timestamp.timestamp_millis())
    {
        return Err("时间戳必须位于 UTC 四位年份范围内".into());
    }
    Ok(timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn canonical_utc_millis_after(previous: Option<&str>) -> Result<String, String> {
    let now_millis = Utc::now().timestamp_millis();
    let minimum = previous
        .map(|value| {
            if normalize_timestamp(value).as_deref() != Ok(value) {
                return Err("已有时间戳不是规范 UTC 毫秒格式".to_owned());
            }
            chrono::DateTime::parse_from_rfc3339(value)
                .map_err(|_| "已有时间戳无效".to_owned())?
                .timestamp_millis()
                .checked_add(1)
                .ok_or_else(|| "时间戳已用尽".to_owned())
        })
        .transpose()?
        .unwrap_or(now_millis);
    let millis = now_millis.max(minimum);
    if !(HISTORY_TIMESTAMP_MIN_MILLIS..=HISTORY_TIMESTAMP_MAX_MILLIS).contains(&millis) {
        return Err("时间戳必须位于 UTC 四位年份范围内".to_owned());
    }
    chrono::DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|timestamp| timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| "无法生成规范 UTC 毫秒时间戳".to_owned())
}

fn normalize_collection_name(value: &str) -> Result<String, String> {
    let name = trim_query_value(value).to_owned();
    if name.is_empty()
        || name.encode_utf16().count() > MAX_COLLECTION_NAME_UTF16
        || name.chars().any(char::is_control)
    {
        return Err("集合名称无效".to_owned());
    }
    Ok(name)
}

fn validate_collection(collection: &Collection) -> Result<(), String> {
    if !history_id_is_cursor_safe(&collection.id)
        || normalize_collection_name(&collection.name).as_deref() != Ok(collection.name.as_str())
        || normalize_timestamp(&collection.created_at).as_deref()
            != Ok(collection.created_at.as_str())
        || normalize_timestamp(&collection.updated_at).as_deref()
            != Ok(collection.updated_at.as_str())
        || collection.created_at > collection.updated_at
        || !(-JS_MAX_SAFE_INTEGER_I64..=JS_MAX_SAFE_INTEGER_I64).contains(&collection.sort_order)
    {
        return Err("集合数据无效".to_owned());
    }
    Ok(())
}

fn collection_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Collection> {
    Ok(Collection {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        sort_order: row.get(4)?,
    })
}

pub(crate) fn list_history_collections(connection: &Connection) -> Result<Vec<Collection>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, created_at, updated_at, sort_order
             FROM collections ORDER BY sort_order ASC, id ASC",
        )
        .map_err(|error| error.to_string())?;
    let collections = statement
        .query_map([], collection_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for collection in &collections {
        validate_collection(collection)?;
        if !ids.insert(collection.id.as_str()) || !names.insert(collection.name.as_str()) {
            return Err("集合标识或名称重复".to_owned());
        }
    }
    Ok(collections)
}

fn collection_name_exists(
    connection: &Connection,
    name: &str,
    excluding_id: Option<&str>,
) -> Result<bool, String> {
    let exists = match excluding_id {
        Some(id) => connection.query_row(
            "SELECT 1 FROM collections
             WHERE name = ?1 COLLATE BINARY AND id <> ?2 LIMIT 1",
            params![name, id],
            |_| Ok(()),
        ),
        None => connection.query_row(
            "SELECT 1 FROM collections WHERE name = ?1 COLLATE BINARY LIMIT 1",
            [name],
            |_| Ok(()),
        ),
    }
    .optional()
    .map_err(|error| error.to_string())?;
    Ok(exists.is_some())
}

fn next_collection_id(connection: &Connection) -> Result<String, String> {
    for _ in 0..HISTORY_ENTITY_ID_ATTEMPTS {
        let id = format!("collection-{}", generate_restore_token()?);
        let exists = connection
            .query_row("SELECT 1 FROM collections WHERE id = ?1", [&id], |_| Ok(()))
            .optional()
            .map_err(|error| error.to_string())?;
        if exists.is_none() {
            return Ok(id);
        }
    }
    Err("无法生成唯一的集合标识".to_owned())
}

fn advance_history_revision(transaction: &Transaction<'_>) -> Result<(), String> {
    let updated = transaction
        .execute(
            "UPDATE history_settings SET revision = revision + 1
             WHERE singleton = 1 AND revision < ?1",
            [JS_MAX_SAFE_INTEGER_I64],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("历史修订号已用尽或设置单例缺失".to_owned());
    }
    Ok(())
}

pub(crate) fn create_history_collection(
    connection: &mut Connection,
    name: &str,
) -> Result<Collection, String> {
    let name = normalize_collection_name(name)?;
    initialize_history_database(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        if collection_name_exists(&transaction, &name, None)? {
            return Err("集合名称已存在".to_owned());
        }
        let maximum = transaction
            .query_row("SELECT MAX(sort_order) FROM collections", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(|error| error.to_string())?;
        let sort_order = maximum
            .map(|value| {
                value
                    .checked_add(1)
                    .ok_or_else(|| "集合排序值已用尽".to_owned())
            })
            .transpose()?
            .unwrap_or(0);
        if !(-JS_MAX_SAFE_INTEGER_I64..=JS_MAX_SAFE_INTEGER_I64).contains(&sort_order) {
            return Err("集合排序值已用尽".to_owned());
        }
        let id = next_collection_id(&transaction)?;
        let timestamp = canonical_utc_millis_after(None)?;
        let collection = Collection {
            id,
            name,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            sort_order,
        };
        validate_collection(&collection)?;
        transaction
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    collection.id,
                    collection.name,
                    collection.created_at,
                    collection.updated_at,
                    collection.sort_order
                ],
            )
            .map_err(|error| error.to_string())?;
        advance_history_revision(&transaction)?;
        Ok(collection)
    })();
    match result {
        Ok(collection) => {
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(collection)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

pub(crate) fn rename_history_collection(
    connection: &mut Connection,
    id: &str,
    name: &str,
) -> Result<Collection, String> {
    if !history_id_is_cursor_safe(id) {
        return Err("集合标识无效".to_owned());
    }
    let name = normalize_collection_name(name)?;
    initialize_history_database(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let existing = transaction
            .query_row(
                "SELECT id, name, created_at, updated_at, sort_order
                 FROM collections WHERE id = ?1",
                [id],
                collection_from_row,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "集合不存在".to_owned())?;
        validate_collection(&existing)?;
        if collection_name_exists(&transaction, &name, Some(id))? {
            return Err("集合名称已存在".to_owned());
        }
        let updated_at = canonical_utc_millis_after(Some(&existing.updated_at))?;
        let collection = Collection {
            name,
            updated_at,
            ..existing
        };
        validate_collection(&collection)?;
        let updated = transaction
            .execute(
                "UPDATE collections SET name = ?2, updated_at = ?3 WHERE id = ?1",
                params![collection.id, collection.name, collection.updated_at],
            )
            .map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err("集合不存在".to_owned());
        }
        advance_history_revision(&transaction)?;
        Ok(collection)
    })();
    match result {
        Ok(collection) => {
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(collection)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

pub(crate) fn delete_history_collection(
    connection: &mut Connection,
    id: &str,
) -> Result<CollectionDeleteResult, String> {
    if !history_id_is_cursor_safe(id) {
        return Err("集合标识无效".to_owned());
    }
    initialize_history_database(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        if transaction
            .query_row("SELECT 1 FROM collections WHERE id = ?1", [id], |_| Ok(()))
            .optional()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            return Err("集合不存在".to_owned());
        }
        let affected_count = transaction
            .query_row(
                "SELECT COUNT(*) FROM clips WHERE collection_id = ?1",
                [id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| error.to_string())?;
        let affected_count =
            u64::try_from(affected_count).map_err(|_| "集合记录数量无效".to_owned())?;
        if affected_count > JS_MAX_SAFE_INTEGER_U64 {
            return Err("集合记录数量超出前端安全整数范围".to_owned());
        }
        transaction
            .execute(
                "UPDATE clips SET collection_id = NULL WHERE collection_id = ?1",
                [id],
            )
            .map_err(|error| error.to_string())?;
        let deleted = transaction
            .execute("DELETE FROM collections WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        if deleted != 1 {
            return Err("集合不存在".to_owned());
        }
        advance_history_revision(&transaction)?;
        Ok(CollectionDeleteResult { affected_count })
    })();
    match result {
        Ok(result) => {
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn normalize_snippet_draft(mut draft: SnippetDraft) -> Result<SnippetDraft, String> {
    if draft
        .id
        .as_deref()
        .is_some_and(|id| !history_id_is_cursor_safe(id))
    {
        return Err("片段标识无效".to_owned());
    }
    draft.title = normalize_collection_name(&draft.title).map_err(|_| "片段标题无效".to_owned())?;
    if trim_query_value(&draft.content).is_empty() {
        return Err("片段正文不能为空".to_owned());
    }
    if !matches!(draft.kind.as_str(), "text" | "code") {
        return Err("片段类型必须是 text 或 code".to_owned());
    }
    if draft
        .collection_id
        .as_deref()
        .is_some_and(|id| !history_id_is_cursor_safe(id))
    {
        return Err("片段集合标识无效".to_owned());
    }
    Ok(draft)
}

fn collection_id_exists(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row("SELECT 1 FROM collections WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|row| row.is_some())
        .map_err(|error| error.to_string())
}

fn next_snippet_id(connection: &Connection) -> Result<String, String> {
    for _ in 0..HISTORY_ENTITY_ID_ATTEMPTS {
        let id = format!("snippet-{}", generate_restore_token()?);
        let exists = connection
            .query_row("SELECT 1 FROM clips WHERE id = ?1", [&id], |_| Ok(()))
            .optional()
            .map_err(|error| error.to_string())?;
        if exists.is_none() {
            return Ok(id);
        }
    }
    Err("无法生成唯一的片段标识".to_owned())
}

pub(crate) fn save_history_snippet(
    connection: &mut Connection,
    draft: SnippetDraft,
) -> Result<HistoryItem, String> {
    let draft = normalize_snippet_draft(draft)?;
    initialize_history_database(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        if let Some(collection_id) = draft.collection_id.as_deref() {
            if !collection_id_exists(&transaction, collection_id)? {
                return Err("片段集合不存在".to_owned());
            }
        }
        let (id, copied_at, updated_at, pinned) = match draft.id.as_deref() {
            Some(id) => {
                let existing = transaction
                    .query_row(
                        "SELECT kind, permanent, copied_at, updated_at, pinned
                         FROM clips WHERE id = ?1",
                        [id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)? != 0,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, i64>(4)? != 0,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| "片段不存在".to_owned())?;
                if !existing.1 || !matches!(existing.0.as_str(), "text" | "code") {
                    return Err("记录不是可编辑的永久片段".to_owned());
                }
                if normalize_timestamp(&existing.2).as_deref() != Ok(existing.2.as_str()) {
                    return Err("片段复制时间无效".to_owned());
                }
                let updated_at = canonical_utc_millis_after(Some(&existing.3))?;
                (id.to_owned(), existing.2, updated_at, existing.4)
            }
            None => {
                let id = next_snippet_id(&transaction)?;
                let timestamp = canonical_utc_millis_after(None)?;
                (id, timestamp.clone(), timestamp, false)
            }
        };
        let item = HistoryItem {
            id,
            kind: draft.kind,
            title: draft.title,
            content: draft.content,
            source_app: "QuickPaste".to_owned(),
            source_app_icon: None,
            copied_at,
            updated_at,
            pinned,
            permanent: true,
            collection_id: draft.collection_id,
            search_terms: Vec::new(),
            ocr_text: None,
            ocr_status: None,
            image_hash: None,
            match_source: None,
            color: None,
            dimensions: None,
            formats: vec!["text".to_owned()],
            omitted_formats: Vec::new(),
            payload_loaded: true,
            html: None,
            rtf_base64: None,
            image_url: None,
            files: Vec::new(),
        };
        validate_history_item(&item)?;
        let _ = upsert_history_item(&transaction, &item).map_err(|error| error.to_string())?;
        advance_history_revision(&transaction)?;
        Ok(item)
    })();
    match result {
        Ok(item) => {
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(item)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn clip_exists(transaction: &Transaction<'_>, id: &str) -> Result<bool, String> {
    transaction
        .query_row("SELECT 1 FROM clips WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|exists| exists.is_some())
        .map_err(|error| error.to_string())
}

fn image_hash_is_canonical(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn validate_history_item(item: &HistoryItem) -> Result<(), String> {
    if !history_id_is_cursor_safe(&item.id) {
        return Err("剪贴板记录 id 无效".into());
    }
    if item.payload_loaded && item.match_source.is_some() {
        return Err("完整剪贴板记录不能携带查询命中来源".into());
    }
    if item.payload_loaded {
        if item.content.len() > crate::clipboard_formats::MAX_FORMAT_BYTES {
            return Err("纯文本正文超过 8 MiB 限制".to_owned());
        }
        if item
            .html
            .as_deref()
            .is_some_and(|html| html.len() > crate::clipboard_formats::MAX_FORMAT_BYTES)
        {
            return Err("HTML 格式超过 8 MiB 限制".to_owned());
        }
        if item
            .rtf_base64
            .as_deref()
            .is_some_and(|rtf| rtf.len() > crate::clipboard_formats::MAX_RTF_BASE64_INPUT_BYTES)
        {
            return Err("RTF 格式超过 8 MiB 限制".to_owned());
        }
        if let Some(image_url) = item.image_url.as_deref() {
            let (_, encoded) = image_url
                .split_once(',')
                .ok_or_else(|| "图片数据 URL 缺少正文".to_owned())?;
            let max_encoded = HISTORY_IMAGE_BLOB_MAX_BYTES.div_ceil(3).saturating_mul(4);
            if encoded.len() > max_encoded {
                return Err("图片正文超过 64 MiB 限制".to_owned());
            }
        }
    }
    if item.match_source == Some(HistoryMatchSource::Ocr)
        && (item.payload_loaded
            || item.kind != "image"
            || item.ocr_status.as_deref() != Some("completed"))
    {
        return Err("OCR 命中来源与摘要状态不一致".into());
    }
    if let Some(status) = item.ocr_status.as_deref() {
        if !matches!(
            status,
            "pending" | "completed" | "unavailable" | "failed" | "oversized"
        ) {
            return Err("OCR 状态无效".into());
        }
    }
    if let Some(image_hash) = item.image_hash.as_deref() {
        if item.kind != "image" || !image_hash_is_canonical(image_hash) {
            return Err("图片哈希无效".into());
        }
    }
    if item.kind != "image"
        && (item.image_hash.is_some() || item.ocr_text.is_some() || item.ocr_status.is_some())
    {
        return Err("只有图片记录可以携带 OCR 数据".into());
    }
    if item.kind == "image" {
        match item.ocr_status.as_deref() {
            Some("completed") => {
                if item.image_hash.is_none()
                    || (item.payload_loaded && item.ocr_text.is_none())
                    || (!item.payload_loaded && item.ocr_text.is_some())
                    || item
                        .ocr_text
                        .as_deref()
                        .is_some_and(|text| !crate::ocr::ocr_text_is_canonical(text))
                {
                    return Err("已完成 OCR 的图片载荷无效".into());
                }
            }
            Some("pending" | "unavailable" | "failed" | "oversized") => {
                if item.image_hash.is_none() || item.ocr_text.is_some() {
                    return Err("图片 OCR 状态和正文不一致".into());
                }
            }
            None if item.ocr_text.is_some() => return Err("OCR 正文缺少状态".into()),
            _ => {}
        }
    }
    if item
        .files
        .iter()
        .filter_map(|file| file.size)
        .any(|size| size > JS_MAX_SAFE_INTEGER_U64)
    {
        return Err("文件大小超出前端安全整数范围".to_owned());
    }
    let mut declared = item
        .formats
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if declared.len() != item.formats.len() {
        return Err("剪贴板记录格式不能重复".into());
    }
    if declared.is_empty() && item.kind != "file" {
        declared.insert(if item.kind == "image" {
            "image"
        } else {
            "text"
        });
    }
    if item
        .omitted_formats
        .iter()
        .any(|format| declared.contains(format.as_str()))
    {
        return Err("已保存格式与省略格式不能重叠".into());
    }
    if item.permanent
        && (!matches!(item.kind.as_str(), "text" | "code")
            || declared.len() != 1
            || !declared.contains("text")
            || !item.omitted_formats.is_empty()
            || !item.files.is_empty()
            || item.html.is_some()
            || item.rtf_base64.is_some()
            || item.image_url.is_some()
            || item.ocr_text.is_some()
            || item.ocr_status.is_some()
            || item.color.is_some()
            || item.dimensions.is_some())
    {
        return Err("永久片段必须是纯文本 text/code 记录".to_owned());
    }
    if !item.payload_loaded {
        if item.html.is_some()
            || item.rtf_base64.is_some()
            || item.image_url.is_some()
            || item.ocr_text.is_some()
            || !item.search_terms.is_empty()
        {
            return Err("摘要记录不能携带未加载的正文或搜索载荷".into());
        }
        return Ok(());
    }
    let contains = |format| declared.contains(format);
    match item.kind.as_str() {
        "file" => {
            if item.files.is_empty() || declared.len() != 1 || !contains("files") {
                return Err("文件记录必须包含非空 files 且只声明 files 格式".into());
            }
            if item.html.is_some() || item.rtf_base64.is_some() || item.image_url.is_some() {
                return Err("文件记录不能携带富文本或图片正文".into());
            }
        }
        "image" => {
            if !item.files.is_empty()
                || (declared.len() != 1 || !contains("image"))
                || item.html.is_some()
                || item.rtf_base64.is_some()
            {
                return Err("图片记录格式不一致".into());
            }
        }
        "text" | "code" | "link" => {
            if !item.files.is_empty() {
                return Err("文本记录不能携带 files".into());
            }
            if !item.formats.is_empty()
                && (!contains("text")
                    || declared
                        .iter()
                        .any(|format| !matches!(*format, "text" | "html" | "rtf")))
            {
                return Err("文本记录格式不一致".into());
            }
        }
        _ => return Err("剪贴板记录类型不支持".into()),
    }
    if item.html.is_some() && !contains("html") {
        return Err("HTML 正文缺少 html 格式声明".into());
    }
    if item.rtf_base64.is_some() && !contains("rtf") {
        return Err("RTF 正文缺少 rtf 格式声明".into());
    }
    if item.image_url.is_some() && !contains("image") {
        return Err("图片正文缺少 image 格式声明".into());
    }
    if item.payload_loaded {
        if contains("html") != item.html.is_some() {
            return Err("HTML 格式和正文必须一致".into());
        }
        if contains("rtf") != item.rtf_base64.is_some() {
            return Err("RTF 格式和正文必须一致".into());
        }
        if contains("image") != item.image_url.is_some() {
            return Err("图片格式和正文必须一致".into());
        }
    }
    Ok(())
}

fn upsert_history_item(
    transaction: &Transaction<'_>,
    item: &HistoryItem,
) -> Result<Option<Vec<u8>>, HistoryWriteFailure> {
    if !history_id_is_cursor_safe(&item.id) {
        return Err(write_contract_failure("剪贴板记录 id 无效"));
    }
    if !item.payload_loaded {
        update_history_summary_metadata(transaction, item)?;
        return Ok(None);
    }
    let formats = canonical_formats(item).map_err(write_contract_failure)?;
    let logical_bytes = logical_bytes(item).map_err(write_contract_failure)?;
    let search_terms = serde_json::to_string(&item.search_terms)
        .map_err(|error| write_contract_failure(format!("无法序列化搜索词: {error}")))?;
    let omitted_formats = serde_json::to_string(&item.omitted_formats)
        .map_err(|error| write_contract_failure(format!("无法序列化省略格式: {error}")))?;
    transaction.execute(
        "INSERT INTO clips(
                id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                permanent, collection_id, search_terms, ocr_text, ocr_status, logical_bytes,
                color, dimensions, omitted_formats, image_hash
             ) VALUES(
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
             ) ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                title = excluded.title,
                plain_text = excluded.plain_text,
                source_app = excluded.source_app,
                copied_at = excluded.copied_at,
                updated_at = excluded.updated_at,
                pinned = excluded.pinned,
                permanent = excluded.permanent,
                collection_id = excluded.collection_id,
                search_terms = excluded.search_terms,
                ocr_text = excluded.ocr_text,
                ocr_status = excluded.ocr_status,
                logical_bytes = excluded.logical_bytes,
                color = excluded.color,
                dimensions = excluded.dimensions,
                omitted_formats = excluded.omitted_formats,
                image_hash = excluded.image_hash",
        params![
            item.id,
            item.kind,
            item.title,
            item.content,
            item.source_app,
            item.copied_at,
            item.updated_at,
            item.pinned as i64,
            item.permanent as i64,
            item.collection_id,
            search_terms,
            item.ocr_text,
            item.ocr_status,
            logical_bytes,
            item.color,
            item.dimensions,
            omitted_formats,
            item.image_hash,
        ],
    )?;
    transaction.execute("DELETE FROM clip_thumbnails WHERE clip_id = ?1", [&item.id])?;
    transaction.execute("DELETE FROM clip_formats WHERE clip_id = ?1", [&item.id])?;
    transaction.execute("DELETE FROM clip_files WHERE clip_id = ?1", [&item.id])?;

    let mut pending_thumbnail = None;
    for format in formats {
        match format.as_str() {
            "text" => {
                insert_format(transaction, &item.id, "text", Some("text/plain"), None)?;
            }
            "html" => {
                let data = item.html.as_ref().map(|html| html.as_bytes().to_vec());
                insert_format(transaction, &item.id, "html", Some("text/html"), data)?;
            }
            "rtf" => {
                let data = item
                    .rtf_base64
                    .as_deref()
                    .map(|rtf| {
                        decode_base64_with_limit(
                            rtf,
                            crate::clipboard_formats::MAX_FORMAT_BYTES,
                            "RTF 格式",
                        )
                        .map_err(write_contract_failure)
                    })
                    .transpose()?;
                insert_format(transaction, &item.id, "rtf", Some("application/rtf"), data)?;
            }
            "image" => {
                let image = item
                    .image_url
                    .as_deref()
                    .map(data_url_parts)
                    .transpose()
                    .map_err(write_contract_failure)?;
                let (mime, data) = image
                    .map(|(mime, data)| (Some(mime), Some(data)))
                    .unwrap_or((None, None));
                pending_thumbnail = match (mime.as_deref(), data.as_deref()) {
                    (Some("image/png"), Some(png)) => generate_thumbnail_png(png).ok(),
                    _ => None,
                };
                insert_format(transaction, &item.id, "image", mime.as_deref(), data)?;
            }
            _ => {
                return Err(write_contract_failure(format!(
                    "不支持的剪贴板格式 {format}"
                )))
            }
        }
    }
    for (ordinal, file) in item.files.iter().enumerate() {
        let size = file
            .size
            .map(i64::try_from)
            .transpose()
            .map_err(|_| write_contract_failure("文件大小超出 SQLite 整数范围"))?;
        transaction
            .execute(
                "INSERT INTO clip_files(
                    clip_id, ordinal, path, name, extension, size, modified_at, directory, exists_at_capture
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    item.id,
                    ordinal as i64,
                    file.path,
                    file.name,
                    file.extension,
                    size,
                    file.modified_at,
                    file.directory as i64,
                    file.exists as i64,
                ],
            )
            ?;
    }
    write_item_search_projection(transaction, item)?;
    Ok(pending_thumbnail)
}

fn update_history_summary_metadata(
    transaction: &Transaction<'_>,
    item: &HistoryItem,
) -> Result<(), HistoryWriteFailure> {
    let updated = transaction.execute(
        "UPDATE clips SET
                title = ?2,
                copied_at = ?3,
                updated_at = COALESCE(NULLIF(?4, ''), updated_at),
                pinned = ?5,
                permanent = ?6,
                collection_id = ?7,
                color = ?8
             WHERE id = ?1",
        params![
            item.id,
            item.title,
            item.copied_at,
            item.updated_at,
            item.pinned as i64,
            item.permanent as i64,
            item.collection_id,
            item.color,
        ],
    )?;
    if updated == 0 {
        return Err(write_contract_failure("摘要记录不能创建新的剪贴板正文"));
    }
    refresh_search_projection(transaction, &item.id)
}

fn insert_format(
    transaction: &Transaction<'_>,
    clip_id: &str,
    format: &str,
    mime: Option<&str>,
    data: Option<Vec<u8>>,
) -> Result<(), HistoryWriteFailure> {
    transaction
        .execute(
            "INSERT INTO clip_formats(clip_id, format, mime, data) VALUES (?1, ?2, ?3, ?4)",
            params![clip_id, format, mime, data],
        )
        .map(|_| ())
        .map_err(HistoryWriteFailure::from)
}

fn canonical_formats(item: &HistoryItem) -> Result<BTreeSet<String>, String> {
    let mut formats = item.formats.iter().cloned().collect::<BTreeSet<_>>();
    if formats.is_empty() {
        formats.insert(
            if item.kind == "image" {
                "image"
            } else {
                "text"
            }
            .into(),
        );
    }
    if item.html.is_some() {
        formats.insert("html".into());
    }
    if item.rtf_base64.is_some() {
        formats.insert("rtf".into());
    }
    if item.image_url.is_some() {
        formats.insert("image".into());
    }
    let file_only = formats.remove("files") || item.kind == "file" || !item.files.is_empty();
    if formats
        .iter()
        .any(|format| !matches!(format.as_str(), "text" | "html" | "rtf" | "image"))
    {
        return Err("剪贴板记录包含不支持的格式".into());
    }
    if formats.is_empty() && !file_only {
        return Err("剪贴板记录没有可存储格式".into());
    }
    Ok(formats)
}

fn logical_bytes(item: &HistoryItem) -> Result<i64, String> {
    let rtf_bytes = item
        .rtf_base64
        .as_deref()
        .map(|rtf| {
            decode_base64_with_limit(rtf, crate::clipboard_formats::MAX_FORMAT_BYTES, "RTF 格式")
                .map(|bytes| bytes.len())
        })
        .transpose()?
        .unwrap_or(0);
    let bytes = item.content.len()
        + item.html.as_deref().map_or(0, str::len)
        + rtf_bytes
        + item
            .files
            .iter()
            .map(|file| {
                file.path.len()
                    + file.name.len()
                    + file.extension.as_deref().map_or(0, str::len)
                    + file.modified_at.as_deref().map_or(0, str::len)
            })
            .sum::<usize>();
    Ok(i64::try_from(bytes).unwrap_or(i64::MAX))
}

fn decode_base64_with_limit(
    encoded: &str,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let max_encoded = max_bytes.div_ceil(3).saturating_mul(4);
    if encoded.len() > max_encoded {
        return Err(format!("{label}超过 {} MiB 限制", max_bytes / 1024 / 1024));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|error| error.to_string())?;
    if bytes.len() > max_bytes {
        return Err(format!("{label}超过 {} MiB 限制", max_bytes / 1024 / 1024));
    }
    Ok(bytes)
}

fn data_url_parts_with_limit(value: &str, max_bytes: usize) -> Result<(String, Vec<u8>), String> {
    let (header, encoded) = value
        .split_once(',')
        .ok_or_else(|| "图片数据 URL 缺少正文".to_owned())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|header| header.strip_suffix(";base64"))
        .filter(|mime| !mime.is_empty())
        .ok_or_else(|| "图片数据 URL 格式无效".to_owned())?;
    let bytes = decode_base64_with_limit(encoded, max_bytes, "图片正文")?;
    Ok((mime.to_owned(), bytes))
}

fn data_url_parts(value: &str) -> Result<(String, Vec<u8>), String> {
    data_url_parts_with_limit(value, HISTORY_IMAGE_BLOB_MAX_BYTES)
}

fn source_app_icon_png_from_data_url(value: &str) -> Option<Vec<u8>> {
    let encoded = value.strip_prefix(SOURCE_APP_ICON_DATA_URL_PREFIX)?;
    let max_base64 = SOURCE_APP_ICON_PNG_MAX_BYTES.div_ceil(3) * 4;
    if encoded.is_empty() || encoded.len() > max_base64 {
        return None;
    }
    let bytes = STANDARD.decode(encoded).ok()?;
    source_app_icon_png_is_safe(&bytes).then_some(bytes)
}

fn source_app_icon_png_is_safe(bytes: &[u8]) -> bool {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

    if bytes.len() > SOURCE_APP_ICON_PNG_MAX_BYTES
        || bytes.len() < 24
        || &bytes[..8] != PNG_SIGNATURE
        || u32::from_be_bytes(bytes[8..12].try_into().unwrap_or_default()) != 13
        || &bytes[12..16] != b"IHDR"
        || u32::from_be_bytes(bytes[16..20].try_into().unwrap_or_default()) != 64
        || u32::from_be_bytes(bytes[20..24].try_into().unwrap_or_default()) != 64
    {
        return false;
    }

    image::load_from_memory_with_format(bytes, ImageFormat::Png)
        .map(|image| image.width() == 64 && image.height() == 64)
        .unwrap_or(false)
}

fn retention_cutoff(now: chrono::DateTime<Utc>, days: i64) -> String {
    (now - ChronoDuration::days(days)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn prune_capacity(
    transaction: &Transaction<'_>,
    policy: &CapacityPolicy,
) -> Result<HistoryMutationResult, String> {
    let mut pruned_ids = BTreeSet::new();
    if let Some(days) = policy.retention_days {
        if days < 0 {
            return Err("保留天数不能为负数".into());
        }
        let cutoff = retention_cutoff(Utc::now(), days);
        let mut statement = transaction
            .prepare(
                "SELECT id FROM clips
                 WHERE pinned = 0 AND permanent = 0 AND copied_at < ?1
                 ORDER BY copied_at ASC, id ASC",
            )
            .map_err(|error| error.to_string())?;
        let ids = statement
            .query_map([cutoff], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        delete_capacity_candidates(transaction, ids, &mut pruned_ids)?;
    }

    let ordinary_count: u64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM clips WHERE pinned = 0 AND permanent = 0",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if ordinary_count > policy.max_records {
        let ids = oldest_unprotected_ids(
            transaction,
            ordinary_count.saturating_sub(policy.max_records),
        )?;
        delete_capacity_candidates(transaction, ids, &mut pruned_ids)?;
    }

    let mut image_bytes: u64 = transaction
        .query_row(
            "SELECT COALESCE(SUM(length(data)), 0) FROM clip_formats WHERE format = 'image'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if image_bytes > policy.max_image_bytes {
        let mut statement = transaction
            .prepare(
                "SELECT clips.id, COALESCE(length(clip_formats.data), 0)
                 FROM clips
                 JOIN clip_formats ON clip_formats.clip_id = clips.id
                 WHERE clips.pinned = 0 AND clips.permanent = 0 AND clip_formats.format = 'image'
                 ORDER BY clips.copied_at ASC, clips.id ASC",
            )
            .map_err(|error| error.to_string())?;
        let candidates = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);
        for (id, bytes) in candidates {
            if image_bytes <= policy.max_image_bytes {
                break;
            }
            let deleted = transaction
                .execute("DELETE FROM clips WHERE id = ?1", [&id])
                .map_err(|error| error.to_string())?;
            if deleted > 0 {
                pruned_ids.insert(id);
                image_bytes = image_bytes.saturating_sub(bytes);
            }
        }
    }
    Ok(HistoryMutationResult {
        pruned_ids: pruned_ids.into_iter().collect(),
    })
}

fn oldest_unprotected_ids(
    transaction: &Transaction<'_>,
    count: u64,
) -> Result<Vec<String>, String> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut statement = transaction
        .prepare(
            "SELECT id FROM clips WHERE pinned = 0 AND permanent = 0
             ORDER BY copied_at ASC, id ASC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([i64::try_from(count).unwrap_or(i64::MAX)], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    Ok(ids)
}

fn delete_capacity_candidates(
    transaction: &Transaction<'_>,
    ids: Vec<String>,
    pruned_ids: &mut BTreeSet<String>,
) -> Result<(), String> {
    for id in ids {
        let deleted = transaction
            .execute("DELETE FROM clips WHERE id = ?1", [&id])
            .map_err(|error| error.to_string())?;
        if deleted > 0 {
            pruned_ids.insert(id);
        }
    }
    Ok(())
}

pub(crate) fn load_history(connection: &Connection) -> Result<Vec<HistoryItem>, String> {
    let mut statement = connection
        .prepare("SELECT id FROM clips ORDER BY copied_at DESC, id DESC")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    ids.into_iter()
        .map(|id| {
            get_clip_payload(connection, &id)?.ok_or_else(|| "历史记录在读取时消失".to_owned())
        })
        .collect()
}

pub(crate) fn get_clip_payload(
    connection: &Connection,
    id: &str,
) -> Result<Option<HistoryItem>, String> {
    let item = connection
        .query_row(
            "SELECT id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                    permanent, collection_id, search_terms, ocr_text, ocr_status, image_hash,
                    color, dimensions, omitted_formats,
                    length(CAST(plain_text AS BLOB))
             FROM clips WHERE id = ?1",
            [id],
            full_history_item_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(mut item) = item else {
        return Ok(None);
    };

    item.source_app_icon = source_app_icon_for(connection, &item.source_app)?;
    let mut statement = connection
        .prepare(
            "SELECT format, mime, length(data), data FROM clip_formats
             WHERE clip_id = ?1
             ORDER BY CASE format
               WHEN 'text' THEN 0 WHEN 'html' THEN 1 WHEN 'rtf' THEN 2 WHEN 'image' THEN 3
               ELSE 4 END",
        )
        .map_err(|error| error.to_string())?;
    let formats = statement
        .query_map([id], |row| {
            let format = row.get::<_, String>(0)?;
            let mime = row.get::<_, Option<String>>(1)?;
            let length = row.get::<_, Option<i64>>(2)?;
            if !persisted_format_blob_length_is_safe(&format, length) {
                return Err(invalid_blob_column(3, "剪贴板格式正文超出安全边界".into()));
            }
            Ok((format, mime, row.get::<_, Option<Vec<u8>>>(3)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (format, mime, data) in formats {
        item.formats.push(format.clone());
        match format.as_str() {
            "html" => {
                item.html = data
                    .map(String::from_utf8)
                    .transpose()
                    .map_err(|error| error.to_string())?;
            }
            "rtf" => item.rtf_base64 = data.map(|data| STANDARD.encode(data)),
            "image" => {
                item.image_url = data.map(|data| {
                    format!(
                        "data:{};base64,{}",
                        mime.unwrap_or_else(|| "image/png".into()),
                        STANDARD.encode(data)
                    )
                });
            }
            "text" => {}
            _ => return Err(format!("历史记录包含未知格式 {format}")),
        }
    }

    let mut statement = connection
        .prepare(
            "SELECT path, name, extension, size, modified_at, directory, exists_at_capture
             FROM clip_files WHERE clip_id = ?1 ORDER BY ordinal ASC",
        )
        .map_err(|error| error.to_string())?;
    item.files = statement
        .query_map([id], |row| {
            Ok(ClipboardFile {
                path: row.get(0)?,
                name: row.get(1)?,
                extension: row.get(2)?,
                size: read_file_size(row)?,
                modified_at: row.get(4)?,
                directory: row.get::<_, i64>(5)? != 0,
                exists: row.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if !item.files.is_empty() {
        item.formats.push("files".into());
    }
    validate_history_item(&item)?;
    Ok(Some(item))
}

fn decode_png_with_limits(
    png: &[u8],
    max_dimension: u32,
    max_alloc: u64,
) -> Result<image::DynamicImage, String> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(max_dimension);
    limits.max_image_height = Some(max_dimension);
    limits.max_alloc = Some(max_alloc);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "无法解码历史图片缩略图".to_owned())
}

fn thumbnail_png_is_safe(png: &[u8]) -> bool {
    if png.is_empty() || png.len() > HISTORY_THUMBNAIL_PNG_MAX_BYTES {
        return false;
    }
    decode_png_with_limits(
        png,
        HISTORY_THUMBNAIL_MAX_DIMENSION,
        HISTORY_THUMBNAIL_DECODE_MAX_ALLOC_BYTES,
    )
    .is_ok_and(|image| {
        image.width() > 0
            && image.height() > 0
            && image.width() <= HISTORY_THUMBNAIL_MAX_DIMENSION
            && image.height() <= HISTORY_THUMBNAIL_MAX_DIMENSION
    })
}

fn generate_thumbnail_png(png: &[u8]) -> Result<Vec<u8>, String> {
    if png.is_empty() || png.len() > HISTORY_IMAGE_BLOB_MAX_BYTES {
        return Err("图片缩略图源数据超过安全边界".to_owned());
    }
    let image = decode_png_with_limits(
        png,
        HISTORY_IMAGE_MAX_DIMENSION,
        HISTORY_IMAGE_DECODE_MAX_ALLOC_BYTES,
    )?;
    let thumbnail = image.thumbnail(
        HISTORY_THUMBNAIL_MAX_DIMENSION,
        HISTORY_THUMBNAIL_MAX_DIMENSION,
    );
    let mut output = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|_| "无法生成历史图片缩略图".to_owned())?;
    let thumbnail_png = output.into_inner();
    if !thumbnail_png_is_safe(&thumbnail_png) {
        return Err("生成的历史图片缩略图超过安全边界".to_owned());
    }
    Ok(thumbnail_png)
}

fn cached_thumbnail_png(connection: &Connection, id: &str) -> Result<Option<Vec<u8>>, String> {
    let metadata = connection
        .query_row(
            "SELECT typeof(clip_thumbnails.thumbnail_png),
                    length(clip_thumbnails.thumbnail_png)
             FROM clips
             JOIN clip_thumbnails ON clip_thumbnails.clip_id = clips.id
             WHERE clips.id = ?1 AND clips.kind = 'image'",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((storage_class, Some(length))) = metadata else {
        return Ok(None);
    };
    if storage_class != "blob" || !(1..=HISTORY_THUMBNAIL_PNG_MAX_BYTES as i64).contains(&length) {
        return Ok(None);
    }
    let png = connection
        .query_row(
            "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = ?1",
            [id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(png.filter(|png| {
        usize::try_from(length).ok() == Some(png.len()) && thumbnail_png_is_safe(png)
    }))
}

pub(crate) fn get_clip_thumbnail(
    connection: &Connection,
    id: &str,
) -> Result<Option<String>, String> {
    if !history_id_is_cursor_safe(id) {
        return Ok(None);
    }
    if let Some(thumbnail_png) = cached_thumbnail_png(connection, id)? {
        return Ok(Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(thumbnail_png)
        )));
    }

    let stored = connection
        .query_row(
            "SELECT length(clip_formats.data), clip_formats.data
             FROM clips
             JOIN clip_formats ON clip_formats.clip_id = clips.id
             WHERE clips.id = ?1 AND clips.kind = 'image'
               AND clip_formats.format = 'image' AND clip_formats.mime = 'image/png'",
            [id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((Some(length), Some(png))) = stored else {
        return Ok(None);
    };
    if !(1..=HISTORY_IMAGE_BLOB_MAX_BYTES as i64).contains(&length)
        || usize::try_from(length).ok() != Some(png.len())
    {
        return Err("图片缩略图源数据超过安全边界".to_owned());
    }

    let thumbnail_png = generate_thumbnail_png(&png)?;
    let _ = connection.execute(
        "INSERT INTO clip_thumbnails(clip_id, thumbnail_png) VALUES (?1, ?2)
         ON CONFLICT(clip_id) DO UPDATE SET thumbnail_png = excluded.thumbnail_png",
        params![id, &thumbnail_png],
    );
    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(thumbnail_png)
    )))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StoredOcrImage {
    Ready(Vec<u8>),
    Stale,
    Oversized,
    Decode,
}

pub(crate) fn load_stored_ocr_image(
    connection: &Connection,
    id: &str,
    image_hash: &str,
) -> Result<StoredOcrImage, String> {
    if !history_id_is_cursor_safe(id) || !image_hash_is_canonical(image_hash) {
        return Ok(StoredOcrImage::Stale);
    }
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let metadata = transaction
        .query_row(
            "SELECT clips.kind, clips.image_hash, clips.ocr_status,
                    clip_formats.mime, length(clip_formats.data)
             FROM clips
             LEFT JOIN clip_formats
               ON clip_formats.clip_id = clips.id AND clip_formats.format = 'image'
             WHERE clips.id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let result = match metadata {
        None => StoredOcrImage::Stale,
        Some((kind, stored_hash, status, _, _))
            if kind != "image"
                || stored_hash.as_deref() != Some(image_hash)
                || status.as_deref() != Some("pending") =>
        {
            StoredOcrImage::Stale
        }
        Some((_, _, _, Some(mime), Some(length))) if mime == "image/png" && length >= 0 => {
            if length > OCR_STORED_PNG_MAX_BYTES {
                StoredOcrImage::Oversized
            } else {
                transaction
                    .query_row(
                        "SELECT clip_formats.data
                         FROM clips
                         JOIN clip_formats
                           ON clip_formats.clip_id = clips.id AND clip_formats.format = 'image'
                         WHERE clips.id = ?1 AND clips.kind = 'image' AND clips.image_hash = ?2",
                        params![id, image_hash],
                        |row| row.get::<_, Vec<u8>>(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?
                    .map(StoredOcrImage::Ready)
                    .unwrap_or(StoredOcrImage::Decode)
            }
        }
        Some(_) => StoredOcrImage::Decode,
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn load_stored_image_for_analysis(
    connection: &Connection,
    id: &str,
) -> Result<Option<Vec<u8>>, String> {
    if !history_id_is_cursor_safe(id) {
        return Ok(None);
    }
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let metadata = transaction
        .query_row(
            "SELECT clip_formats.mime, length(clip_formats.data)
             FROM clips
             JOIN clip_formats
               ON clip_formats.clip_id = clips.id AND clip_formats.format = 'image'
             WHERE clips.id = ?1 AND clips.kind = 'image'",
            [id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let result = match metadata {
        None => None,
        Some((mime, length))
            if mime == "image/png"
                && (1..=HISTORY_IMAGE_BLOB_MAX_BYTES as i64).contains(&length) =>
        {
            let png = transaction
                .query_row(
                    "SELECT clip_formats.data
                     FROM clips
                     JOIN clip_formats
                       ON clip_formats.clip_id = clips.id AND clip_formats.format = 'image'
                     WHERE clips.id = ?1 AND clips.kind = 'image'",
                    [id],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .map_err(|error| error.to_string())?;
            if usize::try_from(length).ok() != Some(png.len()) {
                return Err("本地图片分析源数据无效".into());
            }
            Some(png)
        }
        Some(_) => return Err("本地图片分析源数据无效".into()),
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn apply_ocr_patch(
    connection: &mut Connection,
    id: &str,
    image_hash: &str,
    status: &str,
    text: Option<&str>,
) -> Result<bool, String> {
    if !history_id_is_cursor_safe(id) || !image_hash_is_canonical(image_hash) {
        return Ok(false);
    }
    let valid_payload = match status {
        "completed" => text.is_some_and(crate::ocr::ocr_text_is_canonical),
        "unavailable" | "failed" | "oversized" => text.is_none(),
        _ => false,
    };
    if !valid_payload {
        return Err("OCR 写回载荷无效".to_owned());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let updated = transaction
            .execute(
                "UPDATE clips SET ocr_text = ?3, ocr_status = ?4
                 WHERE id = ?1 AND kind = 'image' AND image_hash = ?2
                   AND ocr_status = 'pending'",
                params![id, image_hash, text, status],
            )
            .map_err(|error| error.to_string())?;
        if updated == 0 {
            return Ok(false);
        }
        refresh_search_projection(&transaction, id).map_err(|error| error.to_string())?;
        advance_history_revision(&transaction)?;
        Ok(true)
    })();
    match result {
        Ok(applied) => {
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(applied)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

fn persisted_plain_text_length_is_safe(length: i64) -> bool {
    (0..=crate::clipboard_formats::MAX_FORMAT_BYTES as i64).contains(&length)
}

fn persisted_format_blob_length_is_safe(format: &str, length: Option<i64>) -> bool {
    match format {
        "text" => length.is_none(),
        "html" | "rtf" => length.is_some_and(|length| {
            (0..=crate::clipboard_formats::MAX_FORMAT_BYTES as i64).contains(&length)
        }),
        "image" => {
            length.is_some_and(|length| (0..=HISTORY_IMAGE_BLOB_MAX_BYTES as i64).contains(&length))
        }
        _ => false,
    }
}

fn full_history_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryItem> {
    let content_length = row.get::<_, i64>(17)?;
    if !persisted_plain_text_length_is_safe(content_length) {
        return Err(invalid_text_column(3, "纯文本正文超过 8 MiB 限制".into()));
    }
    history_item_from_row(row)
}

fn history_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryItem> {
    let search_terms = row.get::<_, String>(10)?;
    let search_terms = serde_json::from_str::<Vec<String>>(&search_terms)
        .map_err(|error| invalid_text_column(10, error.to_string()))?;
    let omitted_formats = row.get::<_, String>(16)?;
    Ok(HistoryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        source_app: row.get(4)?,
        source_app_icon: None,
        copied_at: row.get(5)?,
        updated_at: row.get(6)?,
        pinned: row.get::<_, i64>(7)? != 0,
        permanent: row.get::<_, i64>(8)? != 0,
        collection_id: row.get(9)?,
        search_terms,
        ocr_text: row.get(11)?,
        ocr_status: row.get(12)?,
        image_hash: row.get(13)?,
        match_source: None,
        color: row.get(14)?,
        dimensions: row.get(15)?,
        formats: Vec::new(),
        omitted_formats: stored_omitted_formats(&omitted_formats, 16)?,
        payload_loaded: true,
        html: None,
        rtf_base64: None,
        image_url: None,
        files: Vec::new(),
    })
}

fn summary_history_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryItem> {
    let mut item = history_item_from_row(row)?;
    let source_app_icon = row.get::<_, Option<Vec<u8>>>(17)?;
    item.source_app_icon = source_app_icon
        .filter(|icon_png| source_app_icon_png_is_safe(icon_png))
        .map(|icon_png| {
            format!(
                "{SOURCE_APP_ICON_DATA_URL_PREFIX}{}",
                STANDARD.encode(icon_png)
            )
        });
    Ok(item)
}

fn stored_omitted_formats(
    value: &str,
    column_index: usize,
) -> rusqlite::Result<Vec<ClipboardFormat>> {
    let parsed = serde_json::from_str::<Vec<ClipboardFormat>>(value)
        .map_err(|error| invalid_text_column(column_index, error.to_string()))?;
    let canonical = canonical_omitted_formats(&parsed)
        .map_err(|error| invalid_text_column(column_index, error))?;
    if canonical != parsed {
        return Err(invalid_text_column(
            column_index,
            "省略格式顺序不是规范顺序".into(),
        ));
    }
    Ok(parsed)
}

fn invalid_text_column(column_index: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column_index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn invalid_blob_column(column_index: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column_index,
        rusqlite::types::Type::Blob,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

fn read_file_size_at(
    row: &rusqlite::Row<'_>,
    column_index: usize,
) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(column_index)?
        .map_or(Ok(None), |size| {
            if !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&size) {
                return Err(rusqlite::Error::FromSqlConversionFailure(
                    column_index,
                    rusqlite::types::Type::Integer,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "文件大小超出前端安全整数范围",
                    )),
                ));
            }
            u64::try_from(size).map(Some).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    column_index,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })
        })
}

fn read_file_size(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<u64>> {
    read_file_size_at(row, 3)
}

fn source_app_icon_for(
    connection: &Connection,
    source_app: &str,
) -> Result<Option<String>, String> {
    if source_app.is_empty() {
        return Ok(None);
    }
    let icon = connection
        .query_row(
            "SELECT icon_png FROM source_app_icons WHERE source_app = ?1",
            [source_app],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(icon
        .filter(|icon_png| source_app_icon_png_is_safe(icon_png))
        .map(|icon_png| {
            format!(
                "{SOURCE_APP_ICON_DATA_URL_PREFIX}{}",
                STANDARD.encode(icon_png)
            )
        }))
}

fn sql_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn load_query_metadata_batch(
    connection: &Connection,
    items: &mut [HistoryItem],
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let ids = items
        .iter()
        .map(|item| Value::Text(item.id.clone()))
        .collect::<Vec<_>>();
    let placeholders = sql_placeholders(ids.len());
    let mut formats_by_id = BTreeMap::<String, Vec<String>>::new();
    let mut statement = connection
        .prepare(&format!(
            "SELECT clip_id, format FROM clip_formats WHERE clip_id IN ({placeholders})
             ORDER BY clip_id, CASE format
               WHEN 'text' THEN 0 WHEN 'html' THEN 1 WHEN 'rtf' THEN 2 WHEN 'image' THEN 3
               ELSE 4 END"
        ))
        .map_err(|error| error.to_string())?;
    let formats = statement
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<(String, String)>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (clip_id, format) in formats {
        formats_by_id.entry(clip_id).or_default().push(format);
    }

    let mut files_by_id = BTreeMap::<String, Vec<ClipboardFile>>::new();
    let mut statement = connection
        .prepare(&format!(
            "SELECT clip_id, path, name, extension, size, modified_at, directory, exists_at_capture
             FROM clip_files WHERE clip_id IN ({placeholders}) ORDER BY clip_id, ordinal ASC"
        ))
        .map_err(|error| error.to_string())?;
    let files = statement
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                ClipboardFile {
                    path: row.get(1)?,
                    name: row.get(2)?,
                    extension: row.get(3)?,
                    size: read_file_size_at(row, 4)?,
                    modified_at: row.get(5)?,
                    directory: row.get::<_, i64>(6)? != 0,
                    exists: row.get::<_, i64>(7)? != 0,
                },
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<(String, ClipboardFile)>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    for (clip_id, file) in files {
        files_by_id.entry(clip_id).or_default().push(file);
    }

    for item in items {
        item.formats = formats_by_id.remove(&item.id).unwrap_or_default();
        item.files = files_by_id.remove(&item.id).unwrap_or_default();
        if !item.files.is_empty() {
            item.formats.push("files".into());
        }
    }
    Ok(())
}

fn append_in_predicate(
    predicates: &mut Vec<String>,
    parameters: &mut Vec<Value>,
    column: &str,
    values: &[String],
) {
    if values.is_empty() {
        return;
    }
    predicates.push(format!("{column} IN ({})", sql_placeholders(values.len())));
    parameters.extend(values.iter().cloned().map(Value::Text));
}

fn fts5_literal(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn escaped_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('%');
    for character in value.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.push('%');
    escaped
}

fn history_query_predicate(query: &HistoryQuery) -> (String, String, Vec<Value>) {
    let terms = if query.text.is_empty() {
        Vec::new()
    } else {
        query.text.split(' ').collect::<Vec<_>>()
    };
    let has_fts_terms = terms.iter().any(|term| term.chars().count() >= 3);
    let from = if has_fts_terms {
        "clip_search_fts
         JOIN clip_search ON clip_search.rowid = clip_search_fts.rowid
         JOIN clips ON clips.id = clip_search.clip_id"
            .to_owned()
    } else if terms.is_empty() {
        "clips".to_owned()
    } else {
        "clip_search JOIN clips ON clips.id = clip_search.clip_id".to_owned()
    };
    let mut predicates = Vec::new();
    let mut parameters = Vec::new();
    append_in_predicate(&mut predicates, &mut parameters, "clips.kind", &query.kinds);
    append_in_predicate(
        &mut predicates,
        &mut parameters,
        "clips.source_app",
        &query.source_apps,
    );
    match &query.collection {
        CollectionScope::Any {} => {}
        CollectionScope::Unfiled {} => {
            predicates.push("clips.collection_id IS NULL".to_owned());
        }
        CollectionScope::Collection { id } => {
            predicates.push("clips.collection_id = ?".to_owned());
            parameters.push(Value::Text(id.clone()));
        }
    }
    if let Some(pinned) = query.pinned {
        predicates.push("clips.pinned = ?".to_owned());
        parameters.push(Value::Integer(i64::from(pinned)));
    }
    if let Some(permanent) = query.permanent {
        predicates.push("clips.permanent = ?".to_owned());
        parameters.push(Value::Integer(i64::from(permanent)));
    }
    let mut fts_terms = Vec::new();
    for term in terms {
        if term.chars().count() >= 3 {
            fts_terms.push(fts5_literal(term));
        } else {
            predicates.push("clip_search.normalized_text LIKE ? ESCAPE '\\'".to_owned());
            parameters.push(Value::Text(escaped_like_pattern(term)));
        }
    }
    if !fts_terms.is_empty() {
        predicates.push("clip_search_fts MATCH ?".to_owned());
        parameters.push(Value::Text(fts_terms.join(" AND ")));
    }
    let predicate = if predicates.is_empty() {
        "1 = 1".to_owned()
    } else {
        predicates.join(" AND ")
    };
    (from, predicate, parameters)
}

fn dedupe_batch_ids(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > MAX_BATCH_TARGET_IDS {
        return Err("批量目标过多".to_owned());
    }
    let mut seen = BTreeSet::new();
    let mut deduplicated = Vec::with_capacity(ids.len());
    for id in ids {
        if !history_id_is_cursor_safe(&id) {
            return Err("批量目标标识无效".to_owned());
        }
        if seen.insert(id.clone()) {
            deduplicated.push(id);
        }
    }
    Ok(deduplicated)
}

fn normalize_batch_history_query(query: BatchHistoryQuery) -> Result<BatchHistoryQuery, String> {
    let normalized = normalize_history_query(HistoryQuery {
        text: query.text,
        kinds: query.kinds,
        source_apps: query.source_apps,
        collection: query.collection,
        pinned: query.pinned,
        permanent: None,
        limit: 1,
        cursor: None,
    })?;
    Ok(BatchHistoryQuery {
        text: normalized.text,
        kinds: normalized.kinds,
        source_apps: normalized.source_apps,
        collection: normalized.collection,
        pinned: normalized.pinned,
    })
}

fn batch_history_query_as_history(query: &BatchHistoryQuery) -> HistoryQuery {
    HistoryQuery {
        text: query.text.clone(),
        kinds: query.kinds.clone(),
        source_apps: query.source_apps.clone(),
        collection: query.collection.clone(),
        pinned: query.pinned,
        permanent: None,
        limit: 1,
        cursor: None,
    }
}

fn normalize_query_upper_bound(upper_bound: QueryUpperBound) -> Result<QueryUpperBound, String> {
    if normalize_timestamp(&upper_bound.copied_at).as_deref() != Ok(upper_bound.copied_at.as_str())
        || !history_id_is_cursor_safe(&upper_bound.id)
    {
        return Err("批量查询上界无效".to_owned());
    }
    Ok(upper_bound)
}

fn normalize_batch_target(target: BatchTarget) -> Result<BatchTarget, String> {
    match target {
        BatchTarget::Ids { ids } => Ok(BatchTarget::Ids {
            ids: dedupe_batch_ids(ids)?,
        }),
        BatchTarget::Query {
            query,
            upper_bound,
            excluded_ids,
        } => Ok(BatchTarget::Query {
            query: normalize_batch_history_query(query)?,
            upper_bound: normalize_query_upper_bound(upper_bound)?,
            excluded_ids: dedupe_batch_ids(excluded_ids)?,
        }),
    }
}

fn validate_batch_action(action: &BatchAction) -> Result<(), String> {
    if let BatchAction::Move {
        collection_id: Some(collection_id),
    } = action
    {
        if !history_id_is_cursor_safe(collection_id) {
            return Err("目标集合标识无效".to_owned());
        }
    }
    Ok(())
}

fn materialize_batch_target(
    transaction: &Transaction<'_>,
    target: &BatchTarget,
) -> Result<Vec<String>, String> {
    match target {
        BatchTarget::Ids { ids } => {
            let mut statement = transaction
                .prepare("SELECT 1 FROM clips WHERE id = ?1")
                .map_err(|error| error.to_string())?;
            for id in ids {
                if statement
                    .query_row([id], |_| Ok(()))
                    .optional()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    return Err("批量目标记录不存在".to_owned());
                }
            }
            Ok(ids.clone())
        }
        BatchTarget::Query {
            query,
            upper_bound,
            excluded_ids,
        } => {
            if let CollectionScope::Collection { id } = &query.collection {
                if !collection_id_exists(transaction, id)? {
                    return Err("查询集合不存在".to_owned());
                }
            }
            let query = batch_history_query_as_history(query);
            let (from, mut predicate, mut parameters) = history_query_predicate(&query);
            predicate.push_str(
                " AND (clips.copied_at < ? OR
                        (clips.copied_at = ? AND clips.id COLLATE BINARY <= ?))",
            );
            parameters.push(Value::Text(upper_bound.copied_at.clone()));
            parameters.push(Value::Text(upper_bound.copied_at.clone()));
            parameters.push(Value::Text(upper_bound.id.clone()));
            if !excluded_ids.is_empty() {
                predicate.push_str(&format!(
                    " AND clips.id NOT IN ({})",
                    sql_placeholders(excluded_ids.len())
                ));
                parameters.extend(excluded_ids.iter().cloned().map(Value::Text));
            }
            let sql = format!(
                "SELECT clips.id FROM {from} WHERE {predicate}
                 ORDER BY clips.copied_at DESC, clips.id DESC"
            );
            let mut statement = transaction
                .prepare(&sql)
                .map_err(|error| error.to_string())?;
            let ids = statement
                .query_map(params_from_iter(parameters.iter()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(ids)
        }
    }
}

fn safe_batch_count(value: usize) -> Result<u64, String> {
    let count = u64::try_from(value).map_err(|_| "批量结果计数无效".to_owned())?;
    if count > JS_MAX_SAFE_INTEGER_U64 {
        return Err("批量结果计数超出前端安全整数范围".to_owned());
    }
    Ok(count)
}

pub(crate) fn apply_history_batch(
    connection: &mut Connection,
    target: BatchTarget,
    action: BatchAction,
) -> Result<BatchResult, String> {
    apply_history_batch_with_hook(connection, target, action, |_| Ok(()))
}

fn apply_history_batch_with_hook<F>(
    connection: &mut Connection,
    target: BatchTarget,
    action: BatchAction,
    mut after_changed_row: F,
) -> Result<BatchResult, String>
where
    F: FnMut(usize) -> Result<(), String>,
{
    let target = normalize_batch_target(target)?;
    validate_batch_action(&action)?;
    if matches!(&target, BatchTarget::Ids { ids } if ids.is_empty()) {
        return Ok(BatchResult {
            matched_count: 0,
            changed_count: 0,
            deleted_count: 0,
            pruned_ids: Vec::new(),
        });
    }
    initialize_history_database(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = (|| {
        if let BatchAction::Move {
            collection_id: Some(collection_id),
        } = &action
        {
            if !collection_id_exists(&transaction, collection_id)? {
                return Err("目标集合不存在".to_owned());
            }
        }
        let ids = materialize_batch_target(&transaction, &target)?;
        let matched_count = safe_batch_count(ids.len())?;
        let mut changed_rows = 0_usize;
        let mut deleted_rows = 0_usize;
        match &action {
            BatchAction::Move { collection_id } => {
                let mut statement = transaction
                    .prepare(
                        "UPDATE clips SET collection_id = ?1
                         WHERE id = ?2 AND collection_id IS NOT ?1",
                    )
                    .map_err(|error| error.to_string())?;
                for id in &ids {
                    let changed = statement
                        .execute(params![collection_id, id])
                        .map_err(|error| error.to_string())?;
                    if changed > 0 {
                        changed_rows += changed;
                        after_changed_row(changed_rows)?;
                    }
                }
            }
            BatchAction::SetPinned { pinned } => {
                let mut statement = transaction
                    .prepare("UPDATE clips SET pinned = ?1 WHERE id = ?2 AND pinned <> ?1")
                    .map_err(|error| error.to_string())?;
                for id in &ids {
                    let changed = statement
                        .execute(params![i64::from(*pinned), id])
                        .map_err(|error| error.to_string())?;
                    if changed > 0 {
                        changed_rows += changed;
                        after_changed_row(changed_rows)?;
                    }
                }
            }
            BatchAction::Delete {} => {
                let mut statement = transaction
                    .prepare("DELETE FROM clips WHERE id = ?1")
                    .map_err(|error| error.to_string())?;
                for id in &ids {
                    let changed = statement.execute([id]).map_err(|error| error.to_string())?;
                    if changed > 0 {
                        changed_rows += changed;
                        deleted_rows += changed;
                        after_changed_row(changed_rows)?;
                    }
                }
            }
        }
        let pruned_ids = if matches!(action, BatchAction::Delete {}) {
            Vec::new()
        } else {
            let policy = history_policy(&transaction)?;
            prune_capacity(&transaction, &policy)?.pruned_ids
        };
        if changed_rows > 0 || !pruned_ids.is_empty() {
            advance_history_revision(&transaction)?;
        }
        Ok(BatchResult {
            matched_count,
            changed_count: safe_batch_count(changed_rows)?,
            deleted_count: safe_batch_count(deleted_rows)?,
            pruned_ids,
        })
    })();
    match result {
        Ok(result) => {
            transaction.commit().map_err(|error| error.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = transaction.rollback();
            Err(error)
        }
    }
}

const HISTORY_SUMMARY_COLUMNS: &str =
    "clips.id, clips.kind, clips.title, substr(clips.plain_text, 1, 512),
     clips.source_app, clips.copied_at, clips.updated_at, clips.pinned,
     clips.permanent, clips.collection_id, '[]', clips.ocr_text, clips.ocr_status,
     clips.image_hash, clips.color, clips.dimensions, clips.omitted_formats,
     source_app_icons.icon_png";

fn history_match_source(query_text: &str, item: &HistoryItem) -> HistoryMatchSource {
    let terms = query_text
        .split(' ')
        .filter(|term| !term.is_empty())
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return HistoryMatchSource::None;
    }
    let visible = normalize_search_text(&format!(
        "{}\n{}\n{}",
        item.title, item.content, item.source_app
    ));
    if terms.iter().all(|term| visible.contains(term)) {
        return HistoryMatchSource::Direct;
    }
    if item.kind == "image"
        && item.ocr_status.as_deref() == Some("completed")
        && item
            .ocr_text
            .as_deref()
            .map(normalize_search_text)
            .is_some_and(|ocr_text| terms.iter().all(|term| ocr_text.contains(term)))
    {
        return HistoryMatchSource::Ocr;
    }
    HistoryMatchSource::Index
}

pub(crate) fn query_history(
    connection: &Connection,
    query: HistoryQuery,
) -> Result<HistoryPage, String> {
    query_history_with_after_count_hook(connection, query, || {})
}

fn query_history_with_after_count_hook<F>(
    connection: &Connection,
    query: HistoryQuery,
    after_count: F,
) -> Result<HistoryPage, String>
where
    F: FnOnce(),
{
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)
        .map_err(|error| error.to_string())?;
    let page = query_history_in_snapshot(&transaction, query, after_count)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(page)
}

fn query_history_in_snapshot<F>(
    connection: &Connection,
    query: HistoryQuery,
    after_count: F,
) -> Result<HistoryPage, String>
where
    F: FnOnce(),
{
    let query = normalize_history_query(query)?;
    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let (from, predicate, parameters) = history_query_predicate(&query);
    let count_sql = format!("SELECT COUNT(*) FROM {from} WHERE {predicate}");
    let total_count = connection
        .query_row(&count_sql, params_from_iter(parameters.iter()), |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| error.to_string())?;
    let total_count = u64::try_from(total_count).map_err(|error| error.to_string())?;
    after_count();

    let mut list_predicate = predicate;
    let mut list_parameters = parameters;
    if let Some((copied_at, id)) = cursor {
        list_predicate
            .push_str(" AND (clips.copied_at < ? OR (clips.copied_at = ? AND clips.id < ?))");
        list_parameters.push(Value::Text(copied_at.clone()));
        list_parameters.push(Value::Text(copied_at));
        list_parameters.push(Value::Text(id));
    }
    list_parameters.push(Value::Integer(i64::from(query.limit) + 1));
    let list_sql = format!(
        "SELECT {HISTORY_SUMMARY_COLUMNS}
         FROM {from}
         LEFT JOIN source_app_icons ON source_app_icons.source_app = clips.source_app
         WHERE {list_predicate}
         ORDER BY clips.copied_at DESC, clips.id DESC LIMIT ?"
    );
    let mut statement = connection
        .prepare(&list_sql)
        .map_err(|error| error.to_string())?;
    let mut items = statement
        .query_map(
            params_from_iter(list_parameters.iter()),
            summary_history_item_from_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let limit = query.limit as usize;
    let has_more = items.len() > limit;
    items.truncate(limit);
    load_query_metadata_batch(connection, &mut items)?;
    for item in &mut items {
        item.match_source = Some(history_match_source(&query.text, item));
        // 命中来源在 native 内判断；摘要边界仍不返回 OCR 正文。
        item.ocr_text = None;
        item.payload_loaded = false;
        validate_history_item(item)?;
    }
    let next_cursor = if has_more {
        items.last().map(encode_cursor).transpose()?
    } else {
        None
    };
    Ok(HistoryPage {
        items,
        next_cursor,
        total_count,
    })
}

fn encode_cursor(item: &HistoryItem) -> Result<String, String> {
    encode_cursor_position(&item.copied_at, &item.id)
}

fn encode_cursor_position(copied_at: &str, id: &str) -> Result<String, String> {
    if !history_id_is_cursor_safe(id) {
        return Err("分页游标记录标识无效".into());
    }
    let copied_at_millis = chrono::DateTime::parse_from_rfc3339(copied_at)
        .map_err(|_| "分页游标时间戳无效".to_owned())?
        .timestamp_millis();
    if !(HISTORY_TIMESTAMP_MIN_MILLIS..=HISTORY_TIMESTAMP_MAX_MILLIS).contains(&copied_at_millis) {
        return Err("分页游标时间戳无效".into());
    }
    let cursor = STANDARD.encode(format!("{copied_at_millis}\n{id}"));
    if cursor.encode_utf16().count() > HISTORY_CURSOR_MAX_UTF16 {
        return Err("分页游标过长".into());
    }
    Ok(cursor)
}

pub(crate) fn list_pending_ocr_images(
    connection: &Connection,
    query: PendingOcrQuery,
) -> Result<PendingOcrPage, String> {
    if !(1..=8).contains(&query.limit) {
        return Err("待识别图片分页大小无效".into());
    }
    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let (cursor_time, cursor_id) = cursor
        .map(|(copied_at, id)| (Some(copied_at), Some(id)))
        .unwrap_or((None, None));
    let mut statement = connection
        .prepare(
            "SELECT id, image_hash, copied_at
             FROM clips
             WHERE kind = 'image' AND ocr_status = 'pending' AND image_hash IS NOT NULL
               AND (?1 IS NULL OR copied_at < ?1 OR (copied_at = ?1 AND id < ?2))
             ORDER BY copied_at DESC, id DESC LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![cursor_time, cursor_id, i64::from(query.limit) + 1],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    let limit = query.limit as usize;
    let has_more = rows.len() > limit;
    let page_rows = rows.into_iter().take(limit).collect::<Vec<_>>();
    for (id, image_hash, _) in &page_rows {
        if !history_id_is_cursor_safe(id) || !image_hash_is_canonical(image_hash) {
            return Err("待识别图片记录无效".into());
        }
    }
    let next_cursor = if has_more {
        page_rows
            .last()
            .map(|(id, _, copied_at)| encode_cursor_position(copied_at, id))
            .transpose()?
    } else {
        None
    };
    Ok(PendingOcrPage {
        items: page_rows
            .into_iter()
            .map(|(id, image_hash, _)| PendingOcrCandidate { id, image_hash })
            .collect(),
        next_cursor,
    })
}

fn decode_cursor(cursor: &str) -> Result<(String, String), String> {
    let decoded = STANDARD
        .decode(cursor)
        .map_err(|_| "分页游标无效".to_owned())?;
    if STANDARD.encode(&decoded) != cursor {
        return Err("分页游标无效".into());
    }
    let decoded = String::from_utf8(decoded).map_err(|_| "分页游标无效".to_owned())?;
    let (copied_at_millis, id) = decoded
        .split_once('\n')
        .ok_or_else(|| "分页游标无效".to_owned())?;
    if !history_id_is_cursor_safe(id)
        || copied_at_millis.is_empty()
        || copied_at_millis.starts_with('+')
    {
        return Err("分页游标无效".into());
    }
    let millis = copied_at_millis
        .parse::<i64>()
        .map_err(|_| "分页游标无效".to_owned())?;
    if millis.to_string() != copied_at_millis {
        return Err("分页游标无效".into());
    }
    if !(HISTORY_TIMESTAMP_MIN_MILLIS..=HISTORY_TIMESTAMP_MAX_MILLIS).contains(&millis) {
        return Err("分页游标无效".into());
    }
    let copied_at = chrono::DateTime::<Utc>::from_timestamp_millis(millis)
        .ok_or_else(|| "分页游标无效".to_owned())?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok((copied_at, id.to_owned()))
}

pub(crate) fn get_storage_stats(connection: &Connection) -> Result<StorageStats, String> {
    let mut stats = connection
        .query_row(
            "SELECT
                 (SELECT COUNT(*) FROM clips),
                 (SELECT COUNT(*) FROM clips WHERE pinned = 1),
                 (SELECT COUNT(*) FROM clips WHERE permanent = 1),
                 COALESCE((SELECT SUM(length(data)) FROM clip_formats WHERE format = 'image'), 0),
                 COALESCE((SELECT SUM(length(data)) FROM clip_formats
                           WHERE format IN ('html', 'rtf')), 0),
                 (SELECT COUNT(*) FROM clips WHERE kind = 'file'),
                 COALESCE((SELECT SUM(logical_bytes) FROM clips), 0),
                 (SELECT MIN(copied_at) FROM clips),
                 (SELECT MAX(copied_at) FROM clips),
                 max_records,
                 max_image_bytes,
                 retention_days
             FROM history_settings WHERE singleton = 1",
            [],
            |row| {
                Ok(StorageStats {
                    database_bytes: 0,
                    wal_bytes: 0,
                    shm_bytes: 0,
                    total_physical_bytes: 0,
                    record_count: row.get(0)?,
                    pinned_count: row.get(1)?,
                    permanent_count: row.get(2)?,
                    image_bytes: row.get(3)?,
                    rich_format_bytes: row.get(4)?,
                    file_record_count: row.get(5)?,
                    logical_bytes: row.get(6)?,
                    oldest_copied_at: row.get(7)?,
                    newest_copied_at: row.get(8)?,
                    max_records: row.get(9)?,
                    max_image_bytes: row.get(10)?,
                    retention_days: row.get(11)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    if let Some(database_path) = main_database_path(connection)? {
        stats.database_bytes = required_file_bytes(&database_path)?;
        stats.wal_bytes = optional_file_bytes(&path_with_suffix(&database_path, "-wal"))?;
        stats.shm_bytes = optional_file_bytes(&path_with_suffix(&database_path, "-shm"))?;
        stats.total_physical_bytes =
            checked_physical_total(stats.database_bytes, stats.wal_bytes, stats.shm_bytes)?;
    }
    for value in [
        stats.database_bytes,
        stats.wal_bytes,
        stats.shm_bytes,
        stats.total_physical_bytes,
        stats.record_count,
        stats.pinned_count,
        stats.permanent_count,
        stats.image_bytes,
        stats.rich_format_bytes,
        stats.file_record_count,
        stats.logical_bytes,
        stats.max_records,
        stats.max_image_bytes,
    ] {
        if value > JS_MAX_SAFE_INTEGER_U64 {
            return Err("历史存储统计超出前端安全整数范围".to_owned());
        }
    }
    if stats
        .retention_days
        .is_some_and(|days| !(0..=MAX_RETENTION_DAYS).contains(&days))
    {
        return Err("历史存储策略超出前端安全整数范围".to_owned());
    }
    Ok(stats)
}

fn main_database_path(connection: &Connection) -> Result<Option<PathBuf>, String> {
    let path = connection
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name = 'main'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok((!path.is_empty()).then(|| PathBuf::from(path)))
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn required_file_bytes(path: &Path) -> Result<u64, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法读取历史数据库大小: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("历史数据库路径不是普通文件".to_owned());
    }
    Ok(metadata.len())
}

fn optional_file_bytes(path: &Path) -> Result<u64, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
            Ok(metadata.len())
        }
        Ok(_) => Err("历史数据库旁路路径不是普通文件".to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("无法读取历史数据库旁路文件大小: {error}")),
    }
}

fn checked_physical_total(database: u64, wal: u64, shm: u64) -> Result<u64, String> {
    database
        .checked_add(wal)
        .and_then(|total| total.checked_add(shm))
        .ok_or_else(|| "历史数据库物理占用超出可表示范围".to_owned())
}

#[derive(Debug)]
struct OwnedTemporaryFile {
    path: PathBuf,
    published: bool,
}

impl OwnedTemporaryFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }

    fn mark_published(&mut self) {
        self.published = true;
    }

    fn cleanup_with<F>(&mut self, include_main: bool, remove: &mut F) -> Result<(), String>
    where
        F: FnMut(&Path) -> std::io::Result<()>,
    {
        let mut failed = false;
        if include_main && !self.published {
            if let Err(error) = remove(&self.path) {
                failed |= error.kind() != std::io::ErrorKind::NotFound;
            }
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            if let Err(error) = remove(&path_with_suffix(&self.path, suffix)) {
                failed |= error.kind() != std::io::ErrorKind::NotFound;
            }
        }
        if failed {
            Err("无法清理历史数据库临时文件".to_owned())
        } else {
            Ok(())
        }
    }
}

impl Drop for OwnedTemporaryFile {
    fn drop(&mut self) {
        let _ = self.cleanup_with(true, &mut |path| fs::remove_file(path));
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryNotice {
    format_version: u32,
    phase: RecoveryNoticePhase,
    reason: RecoveryReason,
    quarantine_path: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum RecoveryNoticePhase {
    Pending,
    Quarantined,
    Recovered,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HistoryOpenFailure {
    ConfirmedCorruption(RecoveryReason),
    ReadOnly(HistoryReadOnlyReason),
}

fn classify_sqlite_primary_code(code: i32) -> HistoryOpenFailure {
    match code & 0xff {
        rusqlite::ffi::SQLITE_CORRUPT => {
            HistoryOpenFailure::ConfirmedCorruption(RecoveryReason::Corrupt)
        }
        rusqlite::ffi::SQLITE_NOTADB => {
            HistoryOpenFailure::ConfirmedCorruption(RecoveryReason::NotADatabase)
        }
        rusqlite::ffi::SQLITE_BUSY | rusqlite::ffi::SQLITE_LOCKED => {
            HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Busy)
        }
        rusqlite::ffi::SQLITE_READONLY
        | rusqlite::ffi::SQLITE_PERM
        | rusqlite::ffi::SQLITE_AUTH => {
            HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::PermissionDenied)
        }
        rusqlite::ffi::SQLITE_FULL => HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::DiskFull),
        rusqlite::ffi::SQLITE_IOERR | rusqlite::ffi::SQLITE_CANTOPEN => {
            HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Io)
        }
        _ => HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Unknown),
    }
}

fn classify_sqlite_error(error: &rusqlite::Error) -> HistoryOpenFailure {
    match error {
        rusqlite::Error::SqliteFailure(error, _) => {
            classify_sqlite_primary_code(error.extended_code)
        }
        _ => HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Unknown),
    }
}

fn history_contract_validation_failure(error: rusqlite::Error) -> HistoryInitializationFailure {
    let preserve_sqlite = matches!(
        &error,
        rusqlite::Error::SqliteFailure(sqlite, _)
            if matches!(
                sqlite.extended_code & 0xff,
                rusqlite::ffi::SQLITE_CORRUPT
                    | rusqlite::ffi::SQLITE_NOTADB
                    | rusqlite::ffi::SQLITE_BUSY
                    | rusqlite::ffi::SQLITE_LOCKED
                    | rusqlite::ffi::SQLITE_READONLY
                    | rusqlite::ffi::SQLITE_PERM
                    | rusqlite::ffi::SQLITE_AUTH
                    | rusqlite::ffi::SQLITE_FULL
                    | rusqlite::ffi::SQLITE_IOERR
                    | rusqlite::ffi::SQLITE_CANTOPEN
            )
    );
    if preserve_sqlite {
        HistoryInitializationFailure::Sqlite(error)
    } else {
        HistoryInitializationFailure::Contract(error.to_string())
    }
}

fn validate_current_history_contract(
    connection: &Connection,
) -> Result<(), HistoryInitializationFailure> {
    const SCHEMA_PROBES: [&str; 9] = [
        "SELECT id, kind, title, plain_text, source_app, copied_at, updated_at,
                pinned, search_terms, ocr_text, ocr_status, logical_bytes, color,
                dimensions, permanent, collection_id, omitted_formats, image_hash
         FROM clips LIMIT 0",
        "SELECT clip_id, format, mime, data FROM clip_formats LIMIT 0",
        "SELECT clip_id, ordinal, path, name, extension, size, modified_at,
                directory, exists_at_capture FROM clip_files LIMIT 0",
        "SELECT id, name, created_at, updated_at, sort_order FROM collections LIMIT 0",
        "SELECT source_app, icon_png FROM source_app_icons LIMIT 0",
        "SELECT clip_id, thumbnail_png FROM clip_thumbnails LIMIT 0",
        "SELECT rowid, clip_id, normalized_text FROM clip_search LIMIT 0",
        "SELECT singleton, max_records, max_image_bytes, retention_days, revision
         FROM history_settings LIMIT 0",
        "SELECT rowid, normalized_text FROM clip_search_fts LIMIT 0",
    ];
    for sql in SCHEMA_PROBES {
        connection
            .prepare(sql)
            .map_err(history_contract_validation_failure)?;
    }

    let expected_objects: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE (type = 'trigger' AND name IN (
                      'clip_search_after_insert',
                      'clip_search_after_delete',
                      'clip_search_after_update'
                    ))
                OR (type = 'table' AND name = 'clip_search_fts')",
            [],
            |row| row.get(0),
        )
        .map_err(history_contract_validation_failure)?;
    if expected_objects != 4 {
        return Err(contract_failure("历史数据库搜索结构不完整"));
    }
    let collection_objects: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE (type = 'trigger' AND name IN (
                      'collections_validate_insert',
                      'collections_validate_update'
                    ))
                OR (type = 'index' AND name IN (
                      'collections_name_binary',
                      'collections_sort_order_id'
                    ))",
            [],
            |row| row.get(0),
        )
        .map_err(history_contract_validation_failure)?;
    if collection_objects != 4 {
        return Err(contract_failure("历史数据库集合结构不完整"));
    }
    let image_hash_index: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'clips_image_hash_ocr'",
            [],
            |row| row.get(0),
        )
        .map_err(history_contract_validation_failure)?;
    if image_hash_index != 1 {
        return Err(contract_failure("历史数据库图片哈希结构不完整"));
    }
    list_history_collections(connection).map_err(contract_failure)?;

    let mut settings_statement = connection
        .prepare(
            "SELECT singleton, max_records, max_image_bytes, retention_days, revision
             FROM history_settings ORDER BY singleton LIMIT 2",
        )
        .map_err(history_contract_validation_failure)?;
    let mut settings_rows = settings_statement
        .query([])
        .map_err(history_contract_validation_failure)?;
    let Some(settings_row) = settings_rows
        .next()
        .map_err(history_contract_validation_failure)?
    else {
        return Err(contract_failure("历史存储策略缺失"));
    };
    let singleton = settings_row
        .get::<_, i64>(0)
        .map_err(history_contract_validation_failure)?;
    let max_records = settings_row
        .get::<_, i64>(1)
        .map_err(history_contract_validation_failure)?;
    let max_image_bytes = settings_row
        .get::<_, i64>(2)
        .map_err(history_contract_validation_failure)?;
    let retention_days = settings_row
        .get::<_, Option<i64>>(3)
        .map_err(history_contract_validation_failure)?;
    let revision = settings_row
        .get::<_, i64>(4)
        .map_err(history_contract_validation_failure)?;
    if settings_rows
        .next()
        .map_err(history_contract_validation_failure)?
        .is_some()
        || singleton != 1
        || !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&max_records)
        || !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&max_image_bytes)
        || retention_days.is_some_and(|days| !(0..=MAX_RETENTION_DAYS).contains(&days))
        || !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&revision)
    {
        return Err(contract_failure("历史存储策略无效"));
    }
    drop(settings_rows);
    drop(settings_statement);

    let mut foreign_key_statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(history_contract_validation_failure)?;
    let mut foreign_key_rows = foreign_key_statement
        .query([])
        .map_err(history_contract_validation_failure)?;
    if foreign_key_rows
        .next()
        .map_err(history_contract_validation_failure)?
        .is_some()
    {
        return Err(contract_failure("历史数据库外键不一致"));
    }
    drop(foreign_key_rows);
    drop(foreign_key_statement);

    connection
        .execute(
            "INSERT INTO clip_search_fts(clip_search_fts, rank)
             VALUES('integrity-check', 1)",
            [],
        )
        .map_err(history_contract_validation_failure)?;
    Ok(())
}

fn classify_io_error(error: &std::io::Error) -> HistoryReadOnlyReason {
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        HistoryReadOnlyReason::PermissionDenied
    } else if matches!(error.raw_os_error(), Some(39 | 112)) {
        // Windows ERROR_HANDLE_DISK_FULL / ERROR_DISK_FULL。
        HistoryReadOnlyReason::DiskFull
    } else {
        HistoryReadOnlyReason::Io
    }
}

fn exact_file_exists(path: &Path) -> Result<bool, std::io::Error> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "expected exact file",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn open_history_database_once(data_directory: &Path) -> Result<Connection, HistoryOpenFailure> {
    let path = data_directory.join("history.sqlite3");
    let path_exists = exact_file_exists(&path)
        .map_err(|error| HistoryOpenFailure::ReadOnly(classify_io_error(&error)))?;
    let flags = if path_exists {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    };
    let mut connection =
        Connection::open_with_flags(&path, flags).map_err(|error| classify_sqlite_error(&error))?;
    connection
        .busy_timeout(HISTORY_DATABASE_BUSY_TIMEOUT)
        .map_err(|error| classify_sqlite_error(&error))?;
    let application_id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|error| classify_sqlite_error(&error))?;
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| classify_sqlite_error(&error))?;
    if application_id != 0 && application_id != APPLICATION_ID {
        return Err(HistoryOpenFailure::ReadOnly(
            HistoryReadOnlyReason::Incompatible,
        ));
    }
    if schema_version > SCHEMA_VERSION {
        return Err(HistoryOpenFailure::ReadOnly(
            HistoryReadOnlyReason::Incompatible,
        ));
    }
    match quick_check_is_ok(&connection) {
        Ok(true) => {}
        Ok(false) => {
            return Err(HistoryOpenFailure::ConfirmedCorruption(
                RecoveryReason::Corrupt,
            ))
        }
        Err(error) => return Err(classify_sqlite_error(&error)),
    }
    configure_history_database_connection_typed(&connection)
        .map_err(|error| classify_sqlite_error(&error))?;
    initialize_history_database_classified(&mut connection)
        .map_err(|failure| failure.open_failure())?;
    validate_current_history_contract(&connection).map_err(|failure| failure.open_failure())?;
    match quick_check_is_ok(&connection) {
        Ok(true) => {}
        Ok(false) => {
            return Err(HistoryOpenFailure::ConfirmedCorruption(
                RecoveryReason::Corrupt,
            ))
        }
        Err(error) => return Err(classify_sqlite_error(&error)),
    }
    Ok(connection)
}

fn create_recovery_directory(data_directory: &Path) -> Result<PathBuf, String> {
    for _ in 0..32 {
        let counter = HISTORY_TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "history-recovery-{}-{counter}",
            Utc::now().format("%Y%m%dT%H%M%S%3fZ")
        );
        let path = data_directory.join(name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("无法创建历史数据库隔离目录".to_owned()),
        }
    }
    Err("无法创建唯一的历史数据库隔离目录".to_owned())
}

fn path_is_exact_data_file(
    canonical_data_directory: &Path,
    path: &Path,
    expected_name: &str,
) -> Result<(), String> {
    let canonical = fs::canonicalize(path).map_err(|_| "无法验证历史数据库隔离路径".to_owned())?;
    if canonical.parent() != Some(canonical_data_directory)
        || canonical.file_name().and_then(|name| name.to_str()) != Some(expected_name)
    {
        return Err("历史数据库隔离路径无效".to_owned());
    }
    let metadata = fs::metadata(&canonical).map_err(|_| "无法验证历史数据库隔离文件".to_owned())?;
    if !metadata.is_file() {
        return Err("历史数据库隔离目标不是文件".to_owned());
    }
    Ok(())
}

fn quarantine_history_database_with<M, P>(
    data_directory: &Path,
    live_path: &Path,
    reason: RecoveryReason,
    move_file: M,
    publish_notice: P,
) -> Result<PathBuf, String>
where
    M: FnMut(&Path, &Path) -> std::io::Result<()>,
    P: FnMut(&RecoveryNotice) -> Result<(), String>,
{
    quarantine_history_database_with_rollback(
        data_directory,
        live_path,
        reason,
        move_file,
        |source, destination| fs::rename(source, destination),
        publish_notice,
    )
}

fn quarantine_history_database_with_rollback<M, R, P>(
    data_directory: &Path,
    live_path: &Path,
    reason: RecoveryReason,
    mut move_file: M,
    mut rollback_file: R,
    mut publish_notice: P,
) -> Result<PathBuf, String>
where
    M: FnMut(&Path, &Path) -> std::io::Result<()>,
    R: FnMut(&Path, &Path) -> std::io::Result<()>,
    P: FnMut(&RecoveryNotice) -> Result<(), String>,
{
    let canonical_data_directory =
        fs::canonicalize(data_directory).map_err(|_| "无法验证历史数据库目录".to_owned())?;
    path_is_exact_data_file(&canonical_data_directory, live_path, "history.sqlite3")?;
    let mut sources = vec![live_path.to_path_buf()];
    for (suffix, expected_name) in [
        ("-wal", "history.sqlite3-wal"),
        ("-shm", "history.sqlite3-shm"),
    ] {
        let path = path_with_suffix(live_path, suffix);
        match fs::metadata(&path) {
            Ok(_) => {
                path_is_exact_data_file(&canonical_data_directory, &path, expected_name)?;
                sources.push(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("无法检查历史数据库旁路文件".to_owned()),
        }
    }

    let recovery_directory = create_recovery_directory(&canonical_data_directory)?;
    let canonical_recovery_directory = fs::canonicalize(&recovery_directory)
        .map_err(|_| "无法验证历史数据库隔离目录".to_owned())?;
    if canonical_recovery_directory.parent() != Some(canonical_data_directory.as_path()) {
        let _ = fs::remove_dir(&recovery_directory);
        return Err("历史数据库隔离目录无效".to_owned());
    }
    let mut moved = Vec::<(PathBuf, PathBuf)>::new();
    let mut rollback = |moved: &[(PathBuf, PathBuf)]| -> bool {
        let mut complete = true;
        for (source, destination) in moved.iter().rev() {
            if rollback_file(destination, source).is_err() {
                complete = false;
            }
        }
        complete
    };
    let quarantine_path = canonical_recovery_directory
        .to_str()
        .ok_or_else(|| "历史数据库隔离路径不是有效 Unicode".to_owned())?
        .to_owned();
    let pending_notice = RecoveryNotice {
        format_version: HISTORY_RECOVERY_NOTICE_VERSION,
        phase: RecoveryNoticePhase::Pending,
        reason,
        quarantine_path: quarantine_path.clone(),
    };
    if publish_notice(&pending_notice).is_err() {
        let _ = fs::remove_dir(&canonical_recovery_directory);
        return Err("无法持久化历史数据库隔离意图".to_owned());
    }

    for source in sources {
        let destination = canonical_recovery_directory.join(
            source
                .file_name()
                .ok_or_else(|| "历史数据库隔离文件名无效".to_owned())?,
        );
        if move_file(&source, &destination).is_err() {
            let rolled_back = rollback(&moved);
            if rolled_back {
                let notice_path = data_directory.join(HISTORY_RECOVERY_NOTICE_FILE);
                let notice_removed = match fs::remove_file(&notice_path) {
                    Ok(()) => true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Err(_) => false,
                };
                if notice_removed {
                    let _ = fs::remove_dir(&canonical_recovery_directory);
                }
            }
            return if rolled_back {
                Err("无法隔离历史数据库文件".to_owned())
            } else {
                Err("隔离历史数据库失败且无法完整回滚".to_owned())
            };
        }
        moved.push((source, destination));
    }
    let quarantined_notice = RecoveryNotice {
        format_version: HISTORY_RECOVERY_NOTICE_VERSION,
        phase: RecoveryNoticePhase::Quarantined,
        reason,
        quarantine_path,
    };
    if publish_notice(&quarantined_notice).is_err() {
        let rolled_back = rollback(&moved);
        if rolled_back {
            let notice_path = data_directory.join(HISTORY_RECOVERY_NOTICE_FILE);
            let notice_removed = match fs::remove_file(&notice_path) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(_) => false,
            };
            if notice_removed {
                let _ = fs::remove_dir(&canonical_recovery_directory);
            }
        }
        return if rolled_back {
            Err("无法持久化历史数据库恢复通知".to_owned())
        } else {
            Err("恢复通知失败且无法完整回滚隔离文件".to_owned())
        };
    }
    Ok(canonical_recovery_directory)
}

fn write_recovery_notice(data_directory: &Path, notice: &RecoveryNotice) -> Result<(), String> {
    let destination = data_directory.join(HISTORY_RECOVERY_NOTICE_FILE);
    let counter = HISTORY_TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary_path = data_directory.join(format!(
        ".{HISTORY_RECOVERY_NOTICE_FILE}.quickpaste-tmp-{}-{counter}",
        std::process::id()
    ));
    let mut temporary = OwnedTemporaryFile::new(temporary_path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary.path)
        .map_err(|_| "无法创建历史数据库恢复通知".to_owned())?;
    let bytes =
        serde_json::to_vec(notice).map_err(|_| "无法序列化历史数据库恢复通知".to_owned())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法同步历史数据库恢复通知".to_owned())?;
    drop(file);
    crate::system_actions::atomic_replace_history_file(&temporary.path, &destination)
        .map_err(|_| "无法发布历史数据库恢复通知".to_owned())?;
    temporary.mark_published();
    Ok(())
}

fn load_recovery_notice(data_directory: &Path) -> Result<Option<RecoveryNotice>, String> {
    let notice_path = data_directory.join(HISTORY_RECOVERY_NOTICE_FILE);
    let metadata = match fs::symlink_metadata(&notice_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法检查历史数据库恢复通知".to_owned()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("历史数据库恢复通知不是普通文件".to_owned());
    }
    if metadata.len() > 16 * 1024 {
        return Err("历史数据库恢复通知过大".to_owned());
    }
    let bytes = match fs::read(&notice_path) {
        Ok(bytes) if bytes.len() <= 16 * 1024 => bytes,
        Ok(_) => return Err("历史数据库恢复通知在读取时发生变化".to_owned()),
        Err(_) => return Err("无法读取历史数据库恢复通知".to_owned()),
    };
    let notice = serde_json::from_slice::<RecoveryNotice>(&bytes)
        .map_err(|_| "历史数据库恢复通知无效".to_owned())?;
    if notice.format_version != HISTORY_RECOVERY_NOTICE_VERSION {
        return Err("历史数据库恢复通知版本无效".to_owned());
    }
    Ok(Some(notice))
}

fn recovery_directory_from_notice(
    data_directory: &Path,
    notice: &RecoveryNotice,
) -> Result<PathBuf, String> {
    let canonical_data_directory =
        fs::canonicalize(data_directory).map_err(|_| "无法验证历史数据库恢复通知".to_owned())?;
    let quarantine_path = PathBuf::from(&notice.quarantine_path);
    let canonical_quarantine_path =
        fs::canonicalize(&quarantine_path).map_err(|_| "历史数据库恢复通知路径无效".to_owned())?;
    let name_is_owned = canonical_quarantine_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("history-recovery-"));
    if canonical_quarantine_path.parent() != Some(canonical_data_directory.as_path())
        || !name_is_owned
        || !canonical_quarantine_path.is_dir()
    {
        return Err("历史数据库恢复通知路径无效".to_owned());
    }
    Ok(canonical_quarantine_path)
}

fn recovered_notice_quarantine_directory(
    data_directory: &Path,
    notice: &RecoveryNotice,
) -> Result<Option<PathBuf>, String> {
    let canonical_data_directory =
        fs::canonicalize(data_directory).map_err(|_| "无法验证历史数据库恢复通知".to_owned())?;
    let quarantine_path = PathBuf::from(&notice.quarantine_path);
    let name_is_owned = quarantine_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("history-recovery-"));
    if quarantine_path.parent() != Some(canonical_data_directory.as_path()) || !name_is_owned {
        return Err("历史数据库恢复通知路径无效".to_owned());
    }
    let directory_metadata = match fs::symlink_metadata(&quarantine_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法检查历史数据库隔离目录".to_owned()),
    };
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err("历史数据库恢复通知路径无效".to_owned());
    }
    let canonical_quarantine_path =
        fs::canonicalize(&quarantine_path).map_err(|_| "无法验证历史数据库隔离目录".to_owned())?;
    if canonical_quarantine_path.parent() != Some(canonical_data_directory.as_path()) {
        return Err("历史数据库恢复通知路径无效".to_owned());
    }

    let quarantined_main = canonical_quarantine_path.join("history.sqlite3");
    let main_metadata = match fs::symlink_metadata(&quarantined_main) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法检查历史数据库隔离主文件".to_owned()),
    };
    if main_metadata.file_type().is_symlink() || !main_metadata.is_file() {
        return Err("历史数据库隔离主文件无效".to_owned());
    }
    let canonical_main = fs::canonicalize(&quarantined_main)
        .map_err(|_| "无法验证历史数据库隔离主文件".to_owned())?;
    if canonical_main.parent() != Some(canonical_quarantine_path.as_path())
        || canonical_main.file_name().and_then(|name| name.to_str()) != Some("history.sqlite3")
    {
        return Err("历史数据库隔离主文件无效".to_owned());
    }
    Ok(Some(canonical_quarantine_path))
}

fn reconcile_recovery_notice(
    data_directory: &Path,
    notice: &RecoveryNotice,
) -> Result<RecoveryNotice, String> {
    let recovery_directory = recovery_directory_from_notice(data_directory, notice)?;
    let reconciled = if notice.phase == RecoveryNoticePhase::Pending {
        let canonical_data_directory = fs::canonicalize(data_directory)
            .map_err(|_| "无法验证历史数据库恢复通知".to_owned())?;
        for name in [
            "history.sqlite3",
            "history.sqlite3-wal",
            "history.sqlite3-shm",
        ] {
            let source = canonical_data_directory.join(name);
            let destination = recovery_directory.join(name);
            let source_exists =
                exact_file_exists(&source).map_err(|_| "无法检查历史数据库隔离源".to_owned())?;
            let destination_exists = exact_file_exists(&destination)
                .map_err(|_| "无法检查历史数据库隔离目标".to_owned())?;
            if source_exists && destination_exists {
                return Err("历史数据库隔离状态冲突".to_owned());
            }
            if name == "history.sqlite3" && !source_exists && !destination_exists {
                return Err("历史数据库隔离主文件缺失".to_owned());
            }
            if source_exists {
                path_is_exact_data_file(&canonical_data_directory, &source, name)?;
                fs::rename(&source, &destination)
                    .map_err(|_| "无法完成历史数据库隔离".to_owned())?;
            } else if destination_exists {
                let canonical_destination = fs::canonicalize(&destination)
                    .map_err(|_| "无法验证历史数据库隔离目标".to_owned())?;
                if canonical_destination.parent() != Some(recovery_directory.as_path())
                    || canonical_destination
                        .file_name()
                        .and_then(|value| value.to_str())
                        != Some(name)
                    || !canonical_destination.is_file()
                {
                    return Err("历史数据库隔离目标无效".to_owned());
                }
            }
        }
        let quarantined = RecoveryNotice {
            format_version: HISTORY_RECOVERY_NOTICE_VERSION,
            phase: RecoveryNoticePhase::Quarantined,
            reason: notice.reason,
            quarantine_path: notice.quarantine_path.clone(),
        };
        write_recovery_notice(data_directory, &quarantined)?;
        quarantined
    } else {
        notice.clone()
    };
    if !exact_file_exists(&recovery_directory.join("history.sqlite3"))
        .map_err(|_| "无法检查历史数据库隔离主文件".to_owned())?
    {
        return Err("历史数据库隔离主文件缺失".to_owned());
    }
    Ok(reconciled)
}

fn health_from_recovery_notice(notice: &RecoveryNotice) -> HistoryHealth {
    HistoryHealth::recovered(notice.reason, notice.quarantine_path.clone())
}

fn recover_confirmed_history_database_with<F>(
    data_directory: &Path,
    live_path: &Path,
    reason: RecoveryReason,
    create_fresh: F,
) -> Result<(Connection, HistoryHealth), HistoryHealth>
where
    F: FnOnce() -> Result<Connection, HistoryReadOnlyReason>,
{
    let quarantine_path = quarantine_history_database_with(
        data_directory,
        live_path,
        reason,
        |source, destination| fs::rename(source, destination),
        |notice| write_recovery_notice(data_directory, notice),
    )
    .map_err(|_| HistoryHealth::read_only(HistoryReadOnlyReason::QuarantineFailed))?;
    let quarantine_path = quarantine_path
        .to_str()
        .expect("validated recovery paths are Unicode")
        .to_owned();
    match create_fresh() {
        Ok(connection) => {
            let recovered_notice = RecoveryNotice {
                format_version: HISTORY_RECOVERY_NOTICE_VERSION,
                phase: RecoveryNoticePhase::Recovered,
                reason,
                quarantine_path: quarantine_path.clone(),
            };
            if write_recovery_notice(data_directory, &recovered_notice).is_err() {
                drop(connection);
                return Err(HistoryHealth::fresh_database_failed(
                    reason,
                    quarantine_path,
                ));
            }
            Ok((
                connection,
                HistoryHealth::recovered(reason, quarantine_path),
            ))
        }
        Err(_) => Err(HistoryHealth::fresh_database_failed(
            reason,
            quarantine_path,
        )),
    }
}

pub(crate) fn open_history_database_with_recovery(
    data_directory: &Path,
) -> Result<(Connection, HistoryHealth), HistoryHealth> {
    open_history_database_with_recovery_and_notice_loader(data_directory, load_recovery_notice)
}

fn open_history_database_with_recovery_and_notice_loader<L>(
    data_directory: &Path,
    load_notice: L,
) -> Result<(Connection, HistoryHealth), HistoryHealth>
where
    L: FnOnce(&Path) -> Result<Option<RecoveryNotice>, String>,
{
    fs::create_dir_all(data_directory)
        .map_err(|error| HistoryHealth::read_only(classify_io_error(&error)))?;
    let live_path = data_directory.join("history.sqlite3");
    let notice_path = data_directory.join(HISTORY_RECOVERY_NOTICE_FILE);
    let live_existed_before_reconciliation = exact_file_exists(&live_path)
        .map_err(|error| HistoryHealth::read_only(classify_io_error(&error)))?;
    let mut stale_recovered_notice = false;
    let persisted_notice = match load_notice(data_directory) {
        Ok(Some(notice))
            if notice.phase == RecoveryNoticePhase::Recovered
                && live_existed_before_reconciliation =>
        {
            match recovered_notice_quarantine_directory(data_directory, &notice) {
                Ok(Some(_)) => Some(notice),
                Ok(None) => {
                    stale_recovered_notice = true;
                    None
                }
                Err(_) => {
                    return Err(HistoryHealth::read_only(
                        HistoryReadOnlyReason::QuarantineFailed,
                    ))
                }
            }
        }
        Ok(Some(notice)) => Some(
            reconcile_recovery_notice(data_directory, &notice)
                .map_err(|_| HistoryHealth::read_only(HistoryReadOnlyReason::QuarantineFailed))?,
        ),
        Ok(None) => None,
        Err(_) => {
            return Err(HistoryHealth::read_only(
                HistoryReadOnlyReason::QuarantineFailed,
            ))
        }
    };
    if let Some(notice) = persisted_notice
        .as_ref()
        .filter(|notice| notice.phase == RecoveryNoticePhase::Recovered)
    {
        if !exact_file_exists(&live_path)
            .map_err(|error| HistoryHealth::read_only(classify_io_error(&error)))?
        {
            return Err(HistoryHealth::fresh_database_failed(
                notice.reason,
                notice.quarantine_path.clone(),
            ));
        }
    }
    let recovery_is_incomplete = persisted_notice
        .as_ref()
        .is_some_and(|notice| notice.phase == RecoveryNoticePhase::Quarantined);
    match open_history_database_once(data_directory) {
        Ok(connection) => {
            if let Some(notice) = persisted_notice {
                if notice.phase == RecoveryNoticePhase::Quarantined {
                    let recovered = RecoveryNotice {
                        format_version: HISTORY_RECOVERY_NOTICE_VERSION,
                        phase: RecoveryNoticePhase::Recovered,
                        reason: notice.reason,
                        quarantine_path: notice.quarantine_path.clone(),
                    };
                    if write_recovery_notice(data_directory, &recovered).is_err() {
                        drop(connection);
                        return Err(HistoryHealth::fresh_database_failed(
                            notice.reason,
                            notice.quarantine_path,
                        ));
                    }
                }
                Ok((connection, health_from_recovery_notice(&notice)))
            } else {
                if stale_recovered_notice {
                    match fs::remove_file(&notice_path) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(_) => {
                            drop(connection);
                            return Err(HistoryHealth::read_only(
                                HistoryReadOnlyReason::QuarantineFailed,
                            ));
                        }
                    }
                }
                Ok((connection, HistoryHealth::healthy()))
            }
        }
        Err(_) if recovery_is_incomplete => {
            let notice = persisted_notice.expect("incomplete recovery notice checked above");
            Err(HistoryHealth::fresh_database_failed(
                notice.reason,
                notice.quarantine_path,
            ))
        }
        Err(HistoryOpenFailure::ConfirmedCorruption(reason)) => {
            recover_confirmed_history_database_with(data_directory, &live_path, reason, || {
                open_history_database_once(data_directory).map_err(|failure| match failure {
                    HistoryOpenFailure::ReadOnly(reason) => reason,
                    HistoryOpenFailure::ConfirmedCorruption(_) => HistoryReadOnlyReason::Unknown,
                })
            })
        }
        Err(HistoryOpenFailure::ReadOnly(reason)) => Err(HistoryHealth::read_only(reason)),
    }
}

fn create_backup_temporary_sibling(destination: &Path) -> Result<OwnedTemporaryFile, String> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "备份目标缺少父目录".to_owned())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "备份文件名不是有效 Unicode".to_owned())?;
    for _ in 0..32 {
        let counter = HISTORY_TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{file_name}.quickpaste-tmp-{}-{counter}.sqlite3",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                drop(file);
                return Ok(OwnedTemporaryFile::new(path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建备份临时文件: {error}")),
        }
    }
    Err("无法创建唯一的备份临时文件".into())
}

fn canonical_destination_path_with<F>(path: &Path, resolve: &mut F) -> Result<PathBuf, String>
where
    F: FnMut(&Path) -> std::io::Result<PathBuf>,
{
    match resolve(path) {
        Ok(resolved) => return Ok(resolved),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法解析备份目标".to_owned()),
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "备份目标缺少父目录".to_owned())?;
    let parent = resolve(parent).map_err(|_| "无法解析备份目录".to_owned())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "备份目标缺少文件名".to_owned())?;
    Ok(parent.join(file_name))
}

fn canonical_paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn validate_backup_destination_with<F>(
    live_path: &Path,
    destination: &Path,
    mut resolve: F,
) -> Result<(), String>
where
    F: FnMut(&Path) -> std::io::Result<PathBuf>,
{
    let live = resolve(live_path).map_err(|_| "无法解析历史数据库路径".to_owned())?;
    let destination = canonical_destination_path_with(destination, &mut resolve)?;
    let live_wal = canonical_destination_path_with(&path_with_suffix(&live, "-wal"), &mut resolve)?;
    let live_shm = canonical_destination_path_with(&path_with_suffix(&live, "-shm"), &mut resolve)?;
    if [&live, &live_wal, &live_shm]
        .into_iter()
        .any(|protected| canonical_paths_equal(protected, &destination))
    {
        return Err("备份目标不能是正在使用的历史数据库文件".into());
    }
    Ok(())
}

fn validate_backup_destination(live_path: &Path, destination: &Path) -> Result<(), String> {
    validate_backup_destination_with(live_path, destination, |path| fs::canonicalize(path))
}

fn validate_current_history_snapshot(path: &Path) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(HISTORY_DATABASE_BUSY_TIMEOUT)
        .map_err(|error| error.to_string())?;
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if !journal_mode.eq_ignore_ascii_case("delete") {
        return Err("无法将备份固化为独立数据库文件".to_owned());
    }
    let application_id: i64 = connection
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if application_id != APPLICATION_ID || schema_version != SCHEMA_VERSION {
        return Err("备份数据库标识或版本无效".into());
    }
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if quick_check != "ok" {
        return Err("备份数据库完整性检查失败".into());
    }
    Ok(())
}

pub(crate) fn create_history_backup_at(
    source: &Connection,
    live_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    create_history_backup_with(
        source,
        live_path,
        destination,
        validate_current_history_snapshot,
        crate::system_actions::atomic_replace_history_file,
    )
}

fn create_history_backup_with<V, P>(
    source: &Connection,
    live_path: &Path,
    destination: &Path,
    validate: V,
    publish: P,
) -> Result<(), String>
where
    V: FnOnce(&Path) -> Result<(), String>,
    P: FnOnce(&Path, &Path) -> Result<(), String>,
{
    create_history_backup_with_steps(
        source,
        live_path,
        destination,
        |source, temporary| {
            source
                .backup(rusqlite::MAIN_DB, temporary, None)
                .map_err(|error| error.to_string())
        },
        validate,
        publish,
        |path| fs::remove_file(path),
    )
}

fn create_history_backup_with_steps<B, V, P, R>(
    source: &Connection,
    live_path: &Path,
    destination: &Path,
    backup: B,
    validate: V,
    publish: P,
    mut remove: R,
) -> Result<(), String>
where
    B: FnOnce(&Connection, &Path) -> Result<(), String>,
    V: FnOnce(&Path) -> Result<(), String>,
    P: FnOnce(&Path, &Path) -> Result<(), String>,
    R: FnMut(&Path) -> std::io::Result<()>,
{
    validate_backup_destination(live_path, destination)?;
    let mut temporary = create_backup_temporary_sibling(destination)?;
    let operation = (|| {
        backup(source, &temporary.path)?;
        validate(&temporary.path)?;
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&temporary.path)
            .and_then(|file| file.sync_all())
            .map_err(|_| "无法同步备份临时文件".to_owned())?;
        // 在发布主文件前清除 SQLite 可能生成的精确旁路文件，避免成功后遗留明文临时载荷。
        temporary.cleanup_with(false, &mut remove)?;
        publish(&temporary.path, destination)?;
        temporary.mark_published();
        Ok(())
    })();
    match operation {
        Ok(()) => Ok(()),
        Err(operation_error) => match temporary.cleanup_with(true, &mut remove) {
            Ok(()) => Err(operation_error),
            Err(_) => Err("历史备份失败，且无法清理临时文件".to_owned()),
        },
    }
}

#[derive(Debug)]
struct PreparedHistoryRestore {
    staging: OwnedTemporaryFile,
    current_count: u64,
    incoming_count: u64,
    schema_version: i64,
    captured_revision: i64,
}

#[derive(Debug)]
struct PrepareHistoryRestoreFailure {
    message: String,
    staging: Option<OwnedTemporaryFile>,
}

impl PrepareHistoryRestoreFailure {
    fn without_staging(message: String) -> Self {
        Self {
            message,
            staging: None,
        }
    }

    fn with_staging(message: String, staging: OwnedTemporaryFile) -> Self {
        Self {
            message,
            staging: Some(staging),
        }
    }

    #[cfg(test)]
    fn into_message(self) -> String {
        self.message
    }
}

#[derive(Debug)]
struct RestoreCommitSummary {
    imported_count: u64,
    schema_version: i64,
    policy: CapacityPolicy,
    stats: StorageStats,
    needs_connection_reopen: bool,
}

#[derive(Debug)]
struct TimedPreparedRestore {
    prepared: PreparedHistoryRestore,
    expires_at: Instant,
}

pub(crate) struct HistoryRuntime {
    staging_directory: PathBuf,
    prepared_restores: BTreeMap<String, TimedPreparedRestore>,
    data_directory: Option<PathBuf>,
    connection: Option<Connection>,
    health: HistoryHealth,
    pending_cleanup: BTreeMap<PathBuf, OwnedTemporaryFile>,
}

fn restore_staging_main_name(name: &str) -> Option<String> {
    let main_name = ["-wal", "-shm", "-journal"]
        .into_iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(name);
    let token = main_name
        .strip_prefix(RESTORE_STAGING_PREFIX)?
        .strip_suffix(RESTORE_STAGING_SUFFIX)?;
    restore_token_is_valid(token).then(|| main_name.to_owned())
}

fn cleanup_restore_staging_orphans(staging_directory: &Path) -> Result<(), String> {
    if !staging_directory.exists() {
        fs::create_dir_all(staging_directory).map_err(|_| "无法创建历史恢复暂存目录".to_owned())?;
        return Ok(());
    }
    let mut owned_main_paths = BTreeSet::new();
    for entry in
        fs::read_dir(staging_directory).map_err(|_| "无法读取历史恢复暂存目录".to_owned())?
    {
        let entry = entry.map_err(|_| "无法读取历史恢复暂存目录".to_owned())?;
        if !entry
            .file_type()
            .map_err(|_| "无法检查历史恢复暂存文件".to_owned())?
            .is_file()
        {
            continue;
        }
        let Some(name) = entry
            .file_name()
            .to_str()
            .and_then(restore_staging_main_name)
        else {
            continue;
        };
        owned_main_paths.insert(staging_directory.join(name));
    }
    for path in owned_main_paths {
        let mut owned = OwnedTemporaryFile::new(path);
        owned.cleanup_with(true, &mut |path| fs::remove_file(path))?;
    }
    Ok(())
}

fn generate_restore_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成历史恢复令牌".to_owned())?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(64);
    for byte in bytes {
        token.push(HEX[usize::from(byte >> 4)] as char);
        token.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    Ok(token)
}

impl HistoryRuntime {
    #[cfg(test)]
    pub(crate) fn new(staging_directory: PathBuf) -> Result<Self, String> {
        cleanup_restore_staging_orphans(&staging_directory)?;
        Ok(Self {
            staging_directory,
            prepared_restores: BTreeMap::new(),
            data_directory: None,
            connection: None,
            health: HistoryHealth::healthy(),
            pending_cleanup: BTreeMap::new(),
        })
    }

    pub(crate) fn open(data_directory: PathBuf) -> Result<Self, String> {
        let staging_directory = data_directory.join("history-restore-staging");
        cleanup_restore_staging_orphans(&staging_directory)?;
        let (connection, health) = match open_history_database_with_recovery(&data_directory) {
            Ok((connection, health)) => (Some(connection), health),
            Err(health) => (None, health),
        };
        Ok(Self {
            staging_directory,
            prepared_restores: BTreeMap::new(),
            data_directory: Some(data_directory),
            connection,
            health,
            pending_cleanup: BTreeMap::new(),
        })
    }

    pub(crate) fn health(&self) -> HistoryHealth {
        self.health.clone()
    }

    pub(crate) fn with_connection<T, F>(&mut self, operation: F) -> Result<T, String>
    where
        F: FnOnce(&mut Connection) -> Result<T, String>,
    {
        let _ = self.retry_pending_cleanup();
        let connection = self
            .connection
            .as_mut()
            .ok_or_else(|| "历史数据库当前处于只读错误状态".to_owned())?;
        operation(connection)
    }

    pub(crate) fn create_backup_at(&mut self, destination: &Path) -> Result<BackupResult, String> {
        let live_path = self
            .data_directory
            .as_ref()
            .ok_or_else(|| "历史数据库运行时未初始化".to_owned())?
            .join("history.sqlite3");
        self.with_connection(|connection| {
            create_history_backup_at(connection, &live_path, destination)?;
            Ok(BackupResult::Saved {})
        })
    }

    pub(crate) fn prepare_restore_source(
        &mut self,
        source_path: &Path,
    ) -> Result<PreparedRestoreResult, String> {
        self.retry_pending_cleanup()?;
        let connection = self
            .connection
            .take()
            .ok_or_else(|| "历史数据库当前处于只读错误状态".to_owned())?;
        let result = self.prepare_restore_at(source_path, &connection);
        self.connection = Some(connection);
        result
    }

    pub(crate) fn prepare_restore_at(
        &mut self,
        source_path: &Path,
        live: &Connection,
    ) -> Result<PreparedRestoreResult, String> {
        let now = Instant::now();
        let mut remove = |path: &Path| fs::remove_file(path);
        self.prepare_restore_at_with_cleanup(source_path, live, now, &mut remove)
    }

    fn prepare_restore_at_with_cleanup<R>(
        &mut self,
        source_path: &Path,
        live: &Connection,
        now: Instant,
        remove: &mut R,
    ) -> Result<PreparedRestoreResult, String>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        self.purge_expired_at_with_cleanup(now, remove)?;
        // 快速面板一次只允许一个待确认恢复，避免重复 prepare 累积明文暂存快照。
        let mut cleanup_error = None;
        for (_, previous) in std::mem::take(&mut self.prepared_restores) {
            if let Err(error) = self.cleanup_or_retain_with(previous.prepared.staging, remove) {
                cleanup_error.get_or_insert(error);
            }
        }
        if let Some(error) = cleanup_error {
            return Err(error);
        }
        let token = (0..16)
            .map(|_| generate_restore_token())
            .find_map(|candidate| match candidate {
                Ok(token) if !self.prepared_restores.contains_key(&token) => Some(Ok(token)),
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .transpose()?
            .ok_or_else(|| "无法生成唯一的历史恢复令牌".to_owned())?;
        let prepared =
            match prepare_history_restore_at(source_path, &self.staging_directory, live, &token) {
                Ok(prepared) => prepared,
                Err(failure) => {
                    let PrepareHistoryRestoreFailure { message, staging } = failure;
                    if let Some(staging) = staging {
                        let _ = self.cleanup_or_retain_with(staging, remove);
                    }
                    return Err(message);
                }
            };
        let result = PreparedRestoreResult::Prepared {
            token: token.clone(),
            current_count: prepared.current_count,
            incoming_count: prepared.incoming_count,
            schema_version: prepared.schema_version,
        };
        self.prepared_restores.insert(
            token,
            TimedPreparedRestore {
                prepared,
                expires_at: now + RESTORE_TOKEN_TTL,
            },
        );
        Ok(result)
    }

    #[cfg(test)]
    fn commit_restore_with_connection(
        &mut self,
        token: &str,
        live: &mut Connection,
    ) -> Result<RestoreResult, String> {
        self.commit_restore_at(token, live, Instant::now())
    }

    pub(crate) fn commit_restore_token(&mut self, token: &str) -> Result<RestoreResult, String> {
        if !restore_token_is_valid(token) {
            return Err("历史恢复令牌无效".to_owned());
        }
        self.purge_expired_at(Instant::now())?;
        let Some(timed) = self.prepared_restores.remove(token) else {
            return Err("历史恢复令牌无效或已过期".to_owned());
        };
        let mut connection = match self.connection.take() {
            Some(connection) => connection,
            None => {
                let mut remove = |path: &Path| fs::remove_file(path);
                let _ = self.cleanup_or_retain_with(timed.prepared.staging, &mut remove);
                return Err("历史数据库当前处于只读错误状态".to_owned());
            }
        };
        let mut summary =
            commit_prepared_history_restore_with_hook(&mut connection, &timed.prepared, |_| Ok(()));
        let must_reopen = match &summary {
            Ok(summary) => summary.needs_connection_reopen,
            Err(_) => true,
        };
        if must_reopen {
            // ATTACH/DETACH 状态不确定时必须先关闭连接，再清理明文暂存文件。
            drop(connection);
            let data_directory = self
                .data_directory
                .as_ref()
                .expect("owned runtime has data directory")
                .clone();
            match open_history_database_with_recovery(&data_directory) {
                Ok((connection, health)) => {
                    self.connection = Some(connection);
                    self.health = health;
                }
                Err(health) => {
                    self.connection = None;
                    self.health = health;
                }
            }
        } else {
            self.connection = Some(connection);
        }

        let mut remove = |path: &Path| fs::remove_file(path);
        let _ = self.cleanup_or_retain_with(timed.prepared.staging, &mut remove);
        for (_, other) in std::mem::take(&mut self.prepared_restores) {
            let _ = self.cleanup_or_retain_with(other.prepared.staging, &mut remove);
        }

        if let Ok(summary) = &mut summary {
            // 在确定已解除 staging 文件占用的连接上重采样真实 post-commit stats。
            if let Some(connection) = self.connection.as_ref() {
                if let Ok(stats) = get_storage_stats(connection) {
                    summary.stats = stats;
                }
            }
        }
        summary.map(|summary| RestoreResult::Restored {
            imported_count: summary.imported_count,
            schema_version: summary.schema_version,
            policy: summary.policy,
            stats: summary.stats,
        })
    }

    #[cfg(test)]
    fn commit_restore_at(
        &mut self,
        token: &str,
        live: &mut Connection,
        now: Instant,
    ) -> Result<RestoreResult, String> {
        let mut remove = |path: &Path| fs::remove_file(path);
        self.commit_restore_at_with_cleanup(token, live, now, &mut remove)
    }

    #[cfg(test)]
    fn commit_restore_at_with_cleanup<R>(
        &mut self,
        token: &str,
        live: &mut Connection,
        now: Instant,
        remove: &mut R,
    ) -> Result<RestoreResult, String>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        if !restore_token_is_valid(token) {
            return Err("历史恢复令牌无效".to_owned());
        }
        self.purge_expired_at_with_cleanup(now, remove)?;
        let Some(timed) = self.prepared_restores.remove(token) else {
            return Err("历史恢复令牌无效或已过期".to_owned());
        };
        let result = commit_prepared_history_restore_with_hook(live, &timed.prepared, |_| Ok(()));
        match result {
            Ok(summary) => {
                // 成功导入提升 live revision，所有并行准备的旧令牌都必须立即失效。
                let _ = self.cleanup_or_retain_with(timed.prepared.staging, remove);
                for (_, other) in std::mem::take(&mut self.prepared_restores) {
                    let _ = self.cleanup_or_retain_with(other.prepared.staging, remove);
                }
                Ok(RestoreResult::Restored {
                    imported_count: summary.imported_count,
                    schema_version: summary.schema_version,
                    policy: summary.policy,
                    stats: summary.stats,
                })
            }
            Err(error) => {
                let _ = self.cleanup_or_retain_with(timed.prepared.staging, remove);
                Err(error)
            }
        }
    }

    pub(crate) fn discard_restore(&mut self, token: &str) -> Result<DiscardRestoreResult, String> {
        let mut remove = |path: &Path| fs::remove_file(path);
        self.discard_restore_at_with_cleanup(token, Instant::now(), &mut remove)
    }

    fn discard_restore_at_with_cleanup<R>(
        &mut self,
        token: &str,
        now: Instant,
        remove: &mut R,
    ) -> Result<DiscardRestoreResult, String>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        if !restore_token_is_valid(token) {
            return Err("历史恢复令牌无效".to_owned());
        }
        self.purge_expired_at_with_cleanup(now, remove)?;
        let Some(timed) = self.prepared_restores.remove(token) else {
            return Err("历史恢复令牌无效或已过期".to_owned());
        };
        self.cleanup_or_retain_with(timed.prepared.staging, remove)?;
        Ok(DiscardRestoreResult::Discarded {})
    }

    pub(crate) fn purge_expired(&mut self) -> Result<(), String> {
        self.purge_expired_at(Instant::now())
    }

    fn retain_pending_cleanup(&mut self, staging: OwnedTemporaryFile) {
        let path = staging.path.clone();
        let previous = self.pending_cleanup.insert(path, staging);
        debug_assert!(
            previous.is_none(),
            "staging path must have exactly one owner"
        );
    }

    fn cleanup_or_retain_with<R>(
        &mut self,
        mut staging: OwnedTemporaryFile,
        remove: &mut R,
    ) -> Result<(), String>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        match staging.cleanup_with(true, remove) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.retain_pending_cleanup(staging);
                Err(error)
            }
        }
    }

    fn retry_pending_cleanup(&mut self) -> Result<(), String> {
        let mut remove = |path: &Path| fs::remove_file(path);
        self.retry_pending_cleanup_with(&mut remove)
    }

    fn retry_pending_cleanup_with<R>(&mut self, remove: &mut R) -> Result<(), String>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        let mut first_error = None;
        for (_, staging) in std::mem::take(&mut self.pending_cleanup) {
            if let Err(error) = self.cleanup_or_retain_with(staging, remove) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn purge_expired_at(&mut self, now: Instant) -> Result<(), String> {
        let mut remove = |path: &Path| fs::remove_file(path);
        self.purge_expired_at_with_cleanup(now, &mut remove)
    }

    fn purge_expired_at_with_cleanup<R>(
        &mut self,
        now: Instant,
        remove: &mut R,
    ) -> Result<(), String>
    where
        R: FnMut(&Path) -> std::io::Result<()>,
    {
        // 只重试进入本轮前已挂起的所有权；本轮新失败项留给下一次 30 秒维护。
        let mut first_error = self.retry_pending_cleanup_with(remove).err();
        let expired = self
            .prepared_restores
            .iter()
            .filter(|(_, prepared)| now >= prepared.expires_at)
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        for token in expired {
            if let Some(timed) = self.prepared_restores.remove(&token) {
                if let Err(error) = self.cleanup_or_retain_with(timed.prepared.staging, remove) {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn history_count(connection: &Connection) -> Result<u64, String> {
    connection
        .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get::<_, i64>(0))
        .map_err(|_| "无法读取历史记录数量".to_owned())
        .and_then(|count| u64::try_from(count).map_err(|_| "历史记录数量无效".to_owned()))
}

fn history_revision(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT revision FROM history_settings WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "无法读取历史修订号".to_owned())
}

fn history_policy(connection: &Connection) -> Result<CapacityPolicy, String> {
    let (max_records, max_image_bytes, retention_days) = connection
        .query_row(
            "SELECT max_records, max_image_bytes, retention_days
             FROM history_settings WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .map_err(|_| "历史存储策略无效".to_owned())?;
    if !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&max_records)
        || !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&max_image_bytes)
        || retention_days.is_some_and(|days| !(0..=MAX_RETENTION_DAYS).contains(&days))
    {
        return Err("历史存储策略超出前端安全整数范围".to_owned());
    }
    Ok(CapacityPolicy {
        max_records: max_records as u64,
        max_image_bytes: max_image_bytes as u64,
        retention_days,
    })
}

fn quick_check_is_ok(connection: &Connection) -> Result<bool, rusqlite::Error> {
    connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map(|result| result == "ok")
}

fn restore_token_is_valid(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn create_restore_staging_file(
    staging_directory: &Path,
    token: &str,
) -> Result<OwnedTemporaryFile, String> {
    if !restore_token_is_valid(token) {
        return Err("历史恢复令牌无效".to_owned());
    }
    fs::create_dir_all(staging_directory).map_err(|_| "无法创建历史恢复暂存目录".to_owned())?;
    let path = staging_directory.join(format!(".quickpaste-restore-{token}.sqlite3"));
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "无法创建历史恢复暂存文件".to_owned())?;
    Ok(OwnedTemporaryFile::new(path))
}

fn validate_restore_runtime_contracts(
    connection: &Connection,
    verify_derived_search: bool,
) -> Result<u64, String> {
    if !quick_check_is_ok(connection).map_err(|_| "历史恢复文件完整性检查失败".to_owned())?
    {
        return Err("历史恢复文件完整性检查失败".to_owned());
    }
    let foreign_key_failure = connection
        .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
        .optional()
        .map_err(|_| "历史恢复文件外键检查失败".to_owned())?;
    if foreign_key_failure.is_some() {
        return Err("历史恢复文件外键检查失败".to_owned());
    }
    let policy = history_policy(connection)?;
    if policy.retention_days.is_some_and(|days| days < 0) {
        return Err("历史存储策略无效".to_owned());
    }

    let mut collection_names = BTreeSet::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT id, name, created_at, updated_at, sort_order
                 FROM collections ORDER BY id",
            )
            .map_err(|_| "历史恢复文件集合数据无效".to_owned())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|_| "历史恢复文件集合数据无效".to_owned())?;
        for row in rows {
            let (id, name, created_at, updated_at, sort_order) =
                row.map_err(|_| "历史恢复文件集合数据无效".to_owned())?;
            let canonical_created = normalize_timestamp(&created_at)
                .map_err(|_| "历史恢复文件集合数据无效".to_owned())?;
            let canonical_updated = normalize_timestamp(&updated_at)
                .map_err(|_| "历史恢复文件集合数据无效".to_owned())?;
            if !history_id_is_cursor_safe(&id)
                || name.is_empty()
                || trim_query_value(&name) != name
                || name.chars().any(char::is_control)
                || name.encode_utf16().count() > 512
                || canonical_created != created_at
                || canonical_updated != updated_at
                || created_at > updated_at
                || !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&sort_order)
                || !collection_names.insert(name)
            {
                return Err("历史恢复文件集合数据无效".to_owned());
            }
        }
    }

    let item_count = {
        let mut statement = connection
            .prepare("SELECT id FROM clips ORDER BY id")
            .map_err(|_| "历史恢复文件包含无效记录".to_owned())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "历史恢复文件包含无效记录".to_owned())?;
        let mut item_count = 0_u64;
        for row in rows {
            let id = row.map_err(|_| "历史恢复文件包含无效记录".to_owned())?;
            let item = get_clip_payload(connection, &id)
                .map_err(|_| "历史恢复文件包含无效记录".to_owned())?
                .ok_or_else(|| "历史恢复文件包含无效记录".to_owned())?;
            if normalize_timestamp(&item.copied_at).as_deref() != Ok(item.copied_at.as_str())
                || normalize_timestamp(&item.updated_at).as_deref() != Ok(item.updated_at.as_str())
            {
                return Err("历史恢复文件包含无效记录".to_owned());
            }
            for file in &item.files {
                if let Some(modified_at) = file.modified_at.as_deref() {
                    if normalize_timestamp(modified_at).as_deref() != Ok(modified_at) {
                        return Err("历史恢复文件包含无效记录".to_owned());
                    }
                }
            }
            let stored_logical_bytes: i64 = connection
                .query_row(
                    "SELECT logical_bytes FROM clips WHERE id = ?1",
                    [&item.id],
                    |row| row.get(0),
                )
                .map_err(|_| "历史恢复文件包含无效记录".to_owned())?;
            if !(0..=JS_MAX_SAFE_INTEGER_I64).contains(&stored_logical_bytes)
                || stored_logical_bytes != logical_bytes(&item)?
            {
                return Err("历史恢复文件包含无效记录".to_owned());
            }
            if verify_derived_search {
                let expected = build_search_projection(
                    &item.title,
                    &item.content,
                    &item.source_app,
                    &item.search_terms,
                    item.ocr_text.as_deref(),
                    &item
                        .files
                        .iter()
                        .map(|file| (file.path.clone(), file.name.clone()))
                        .collect::<Vec<_>>(),
                );
                let stored: String = connection
                    .query_row(
                        "SELECT normalized_text FROM clip_search WHERE clip_id = ?1",
                        [&item.id],
                        |row| row.get(0),
                    )
                    .map_err(|_| "历史恢复文件搜索索引无效".to_owned())?;
                if stored != expected {
                    return Err("历史恢复文件搜索索引无效".to_owned());
                }
            }
            item_count = item_count
                .checked_add(1)
                .ok_or_else(|| "历史记录数量无效".to_owned())?;
        }
        item_count
    };
    if verify_derived_search {
        let search_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM clip_search", [], |row| row.get(0))
            .map_err(|_| "历史恢复文件搜索索引无效".to_owned())?;
        if u64::try_from(search_count).ok() != Some(item_count) {
            return Err("历史恢复文件搜索索引无效".to_owned());
        }
        connection
            .execute(
                "INSERT INTO clip_search_fts(clip_search_fts) VALUES('integrity-check')",
                [],
            )
            .map_err(|_| "历史恢复文件搜索索引无效".to_owned())?;
    }

    let mut icon_statement = connection
        .prepare("SELECT icon_png FROM source_app_icons")
        .map_err(|_| "历史恢复文件来源图标无效".to_owned())?;
    let icons = icon_statement
        .query_map([], |row| row.get::<_, Vec<u8>>(0))
        .map_err(|_| "历史恢复文件来源图标无效".to_owned())?;
    for icon in icons {
        let icon = icon.map_err(|_| "历史恢复文件来源图标无效".to_owned())?;
        if !source_app_icon_png_is_safe(&icon) {
            return Err("历史恢复文件来源图标无效".to_owned());
        }
    }
    drop(icon_statement);

    let mut thumbnail_statement = connection
        .prepare(
            "SELECT clip_thumbnails.clip_id, typeof(clip_thumbnails.thumbnail_png),
                    length(clip_thumbnails.thumbnail_png), clips.kind
             FROM clip_thumbnails
             JOIN clips ON clips.id = clip_thumbnails.clip_id
             ORDER BY clip_thumbnails.clip_id",
        )
        .map_err(|_| "历史恢复文件图片缩略图无效".to_owned())?;
    let thumbnails = thumbnail_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| "历史恢复文件图片缩略图无效".to_owned())?;
    for thumbnail in thumbnails {
        let (clip_id, storage_class, length, kind) =
            thumbnail.map_err(|_| "历史恢复文件图片缩略图无效".to_owned())?;
        let Some(length) = length else {
            return Err("历史恢复文件图片缩略图无效".to_owned());
        };
        if kind != "image"
            || storage_class != "blob"
            || !(1..=HISTORY_THUMBNAIL_PNG_MAX_BYTES as i64).contains(&length)
        {
            return Err("历史恢复文件图片缩略图无效".to_owned());
        }
        let png: Vec<u8> = connection
            .query_row(
                "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = ?1",
                [&clip_id],
                |row| row.get(0),
            )
            .map_err(|_| "历史恢复文件图片缩略图无效".to_owned())?;
        if usize::try_from(length).ok() != Some(png.len()) || !thumbnail_png_is_safe(&png) {
            return Err("历史恢复文件图片缩略图无效".to_owned());
        }
    }
    Ok(item_count)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RestoreSourceStamp {
    length: u64,
    modified: std::time::SystemTime,
}

fn restore_source_stamp(path: &Path) -> Result<Option<RestoreSourceStamp>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法检查历史恢复文件".to_owned()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("历史恢复来源必须是普通文件".to_owned());
    }
    Ok(Some(RestoreSourceStamp {
        length: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|_| "无法检查历史恢复文件时间".to_owned())?,
    }))
}

fn copy_restore_source_to_owned_staging(
    source_path: &Path,
    staging_path: &Path,
) -> Result<(), String> {
    let source_paths = [
        source_path.to_path_buf(),
        path_with_suffix(source_path, "-wal"),
        path_with_suffix(source_path, "-journal"),
    ];
    let before = source_paths
        .iter()
        .map(|path| restore_source_stamp(path))
        .collect::<Result<Vec<_>, _>>()?;
    if before.first().and_then(Option::as_ref).is_none() {
        return Err("历史恢复文件不存在".to_owned());
    }

    for (index, (source, stamp)) in source_paths.iter().zip(&before).enumerate() {
        let Some(stamp) = stamp else {
            continue;
        };
        let destination = if index == 0 {
            staging_path.to_path_buf()
        } else if index == 1 {
            path_with_suffix(staging_path, "-wal")
        } else {
            path_with_suffix(staging_path, "-journal")
        };
        let mut input = OpenOptions::new()
            .read(true)
            .open(source)
            .map_err(|_| "无法读取历史恢复文件".to_owned())?;
        let mut output = OpenOptions::new()
            .write(true)
            .truncate(index == 0)
            .create_new(index != 0)
            .open(&destination)
            .map_err(|_| "无法创建历史恢复来源快照".to_owned())?;
        let copied = std::io::copy(&mut input, &mut output)
            .map_err(|_| "无法复制历史恢复文件".to_owned())?;
        output
            .sync_all()
            .map_err(|_| "无法同步历史恢复来源快照".to_owned())?;
        if copied != stamp.length {
            return Err("历史恢复文件在读取时发生变化".to_owned());
        }
    }

    let after = source_paths
        .iter()
        .map(|path| restore_source_stamp(path))
        .collect::<Result<Vec<_>, _>>()?;
    if after != before {
        return Err("历史恢复文件在读取时发生变化".to_owned());
    }
    Ok(())
}

fn prepare_history_restore_at(
    source_path: &Path,
    staging_directory: &Path,
    live: &Connection,
    token: &str,
) -> Result<PreparedHistoryRestore, PrepareHistoryRestoreFailure> {
    if !restore_token_is_valid(token) {
        return Err(PrepareHistoryRestoreFailure::without_staging(
            "历史恢复令牌无效".to_owned(),
        ));
    }
    let staging = create_restore_staging_file(staging_directory, token)
        .map_err(PrepareHistoryRestoreFailure::without_staging)?;
    let prepared = (|| -> Result<(u64, u64, i64, i64), String> {
        copy_restore_source_to_owned_staging(source_path, &staging.path)?;

        let mut staged =
            Connection::open(&staging.path).map_err(|_| "无法打开历史恢复暂存快照".to_owned())?;
        staged
            .busy_timeout(HISTORY_DATABASE_BUSY_TIMEOUT)
            .map_err(|_| "无法配置历史恢复暂存快照".to_owned())?;
        let application_id: i64 = staged
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(|_| "历史恢复文件不是有效数据库".to_owned())?;
        let source_version: i64 = staged
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| "历史恢复文件不是有效数据库".to_owned())?;
        if application_id != APPLICATION_ID {
            return Err("不是 QuickPaste 历史备份".to_owned());
        }
        if source_version > SCHEMA_VERSION {
            return Err("历史恢复文件版本高于当前版本".to_owned());
        }
        if !quick_check_is_ok(&staged).map_err(|_| "历史恢复文件完整性检查失败".to_owned())?
        {
            return Err("历史恢复文件完整性检查失败".to_owned());
        }
        configure_history_database_connection(&staged)
            .map_err(|_| "无法配置历史恢复暂存快照".to_owned())?;
        initialize_history_database(&mut staged).map_err(|_| "历史恢复文件迁移失败".to_owned())?;
        let application_id: i64 = staged
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(|_| "历史恢复文件迁移失败".to_owned())?;
        let schema_version: i64 = staged
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| "历史恢复文件迁移失败".to_owned())?;
        if application_id != APPLICATION_ID || schema_version != SCHEMA_VERSION {
            return Err("历史恢复文件迁移失败".to_owned());
        }
        let incoming_count = validate_restore_runtime_contracts(&staged, true)
            .map_err(|_| "历史恢复文件包含无效数据".to_owned())?;
        staged
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
            .map_err(|_| "无法固化历史恢复暂存快照".to_owned())?;
        drop(staged);
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&staging.path)
            .and_then(|file| file.sync_all())
            .map_err(|_| "无法同步历史恢复暂存快照".to_owned())?;

        Ok((
            history_count(live)?,
            incoming_count,
            schema_version,
            history_revision(live)?,
        ))
    })();

    match prepared {
        Ok((current_count, incoming_count, schema_version, captured_revision)) => {
            Ok(PreparedHistoryRestore {
                staging,
                current_count,
                incoming_count,
                schema_version,
                captured_revision,
            })
        }
        Err(message) => Err(PrepareHistoryRestoreFailure::with_staging(message, staging)),
    }
}

fn commit_prepared_history_restore_with_hook<F>(
    live: &mut Connection,
    prepared: &PreparedHistoryRestore,
    after_table: F,
) -> Result<RestoreCommitSummary, String>
where
    F: FnMut(&str) -> Result<(), String>,
{
    commit_prepared_history_restore_with_operations(
        live,
        prepared,
        after_table,
        get_storage_stats,
        |connection| {
            connection
                .execute_batch("DETACH DATABASE restore_source")
                .map_err(|_| "无法卸载历史恢复暂存快照".to_owned())
        },
    )
}

fn commit_prepared_history_restore_with_operations<F, S, D>(
    live: &mut Connection,
    prepared: &PreparedHistoryRestore,
    mut after_table: F,
    sample_post_commit_stats: S,
    detach_restore_source: D,
) -> Result<RestoreCommitSummary, String>
where
    F: FnMut(&str) -> Result<(), String>,
    S: FnOnce(&Connection) -> Result<StorageStats, String>,
    D: FnOnce(&Connection) -> Result<(), String>,
{
    let staging =
        Connection::open_with_flags(&prepared.staging.path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|_| "历史恢复暂存快照不可用".to_owned())?;
    let application_id: i64 = staging
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .map_err(|_| "历史恢复暂存快照不可用".to_owned())?;
    let schema_version: i64 = staging
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| "历史恢复暂存快照不可用".to_owned())?;
    if application_id != APPLICATION_ID || schema_version != SCHEMA_VERSION {
        return Err("历史恢复暂存快照不可用".to_owned());
    }
    let incoming_count = validate_restore_runtime_contracts(&staging, false)
        .map_err(|_| "历史恢复暂存快照包含无效数据".to_owned())?;
    if incoming_count != prepared.incoming_count {
        return Err("历史恢复暂存快照已改变".to_owned());
    }
    let policy = history_policy(&staging)?;
    drop(staging);

    let staging_path = prepared
        .staging
        .path
        .to_str()
        .ok_or_else(|| "历史恢复暂存路径不是有效 Unicode".to_owned())?;
    live.execute("ATTACH DATABASE ?1 AS restore_source", [staging_path])
        .map_err(|_| "无法挂载历史恢复暂存快照".to_owned())?;
    let transaction_result = (|| {
        let transaction = live
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let current_revision: i64 = transaction
            .query_row(
                "SELECT revision FROM history_settings WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if current_revision != prepared.captured_revision {
            return Err("准备恢复后历史记录已发生变化".to_owned());
        }
        let next_revision = current_revision
            .checked_add(1)
            .ok_or_else(|| "历史修订号已耗尽".to_owned())?;

        transaction
            .execute_batch(
                "DELETE FROM clip_search;
                 DELETE FROM clip_thumbnails;
                 DELETE FROM clip_formats;
                 DELETE FROM clip_files;
                 DELETE FROM clips;
                 DELETE FROM collections;
                 DELETE FROM source_app_icons;",
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 SELECT id, name, created_at, updated_at, sort_order
                 FROM restore_source.collections",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("collections")?;
        transaction
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   search_terms, ocr_text, ocr_status, logical_bytes, color, dimensions,
                   permanent, collection_id, omitted_formats, image_hash
                 )
                 SELECT id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                        search_terms, ocr_text, ocr_status, logical_bytes, color, dimensions,
                        permanent, collection_id, omitted_formats, image_hash
                 FROM restore_source.clips",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("clips")?;
        transaction
            .execute(
                "INSERT INTO clip_formats(clip_id, format, mime, data)
                 SELECT clip_id, format, mime, data FROM restore_source.clip_formats",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("clip_formats")?;
        transaction
            .execute(
                "INSERT INTO clip_thumbnails(clip_id, thumbnail_png)
                 SELECT clip_id, thumbnail_png FROM restore_source.clip_thumbnails",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("clip_thumbnails")?;
        transaction
            .execute(
                "INSERT INTO clip_files(
                   clip_id, ordinal, path, name, extension, size, modified_at,
                   directory, exists_at_capture
                 )
                 SELECT clip_id, ordinal, path, name, extension, size, modified_at,
                        directory, exists_at_capture
                 FROM restore_source.clip_files",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("clip_files")?;
        transaction
            .execute(
                "INSERT INTO source_app_icons(source_app, icon_png)
                 SELECT source_app, icon_png FROM restore_source.source_app_icons",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("source_app_icons")?;

        let clip_ids = {
            let mut statement = transaction
                .prepare("SELECT id FROM clips ORDER BY id")
                .map_err(|error| error.to_string())?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            ids
        };
        for clip_id in clip_ids {
            refresh_search_projection(&transaction, &clip_id).map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "INSERT INTO clip_search_fts(clip_search_fts) VALUES('rebuild')",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO clip_search_fts(clip_search_fts) VALUES('integrity-check')",
                [],
            )
            .map_err(|error| error.to_string())?;
        after_table("clip_search")?;
        let foreign_key_failure = transaction
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .map_err(|error| error.to_string())?;
        if foreign_key_failure.is_some() {
            return Err("恢复后的历史数据库外键检查失败".to_owned());
        }
        let imported_count: i64 = transaction
            .query_row("SELECT COUNT(*) FROM clips", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if u64::try_from(imported_count).ok() != Some(prepared.incoming_count) {
            return Err("恢复后的历史记录数量不一致".to_owned());
        }
        let max_records =
            i64::try_from(policy.max_records).map_err(|_| "恢复文件的记录上限无效".to_owned())?;
        let max_image_bytes = i64::try_from(policy.max_image_bytes)
            .map_err(|_| "恢复文件的图片上限无效".to_owned())?;
        transaction
            .execute(
                "UPDATE history_settings
                 SET max_records = ?1, max_image_bytes = ?2, retention_days = ?3, revision = ?4
                 WHERE singleton = 1",
                params![
                    max_records,
                    max_image_bytes,
                    policy.retention_days,
                    next_revision
                ],
            )
            .map_err(|error| error.to_string())?;
        after_table("history_settings")?;
        let fallback_stats = get_storage_stats(&transaction)?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(fallback_stats)
    })();
    let fallback_stats = match transaction_result {
        Ok(stats) => stats,
        Err(error) => {
            let _ = detach_restore_source(live);
            return Err(error);
        }
    };
    // COMMIT 后恢复已经生效；卸载和重新采样失败都不能把它伪装成失败响应。
    let detached = detach_restore_source(live).is_ok();
    let stats = sample_post_commit_stats(live).unwrap_or(fallback_stats);

    Ok(RestoreCommitSummary {
        imported_count: prepared.incoming_count,
        schema_version: prepared.schema_version,
        policy,
        stats,
        needs_connection_reopen: !detached,
    })
}

pub(crate) fn compact_history_database(connection: &Connection) -> Result<StorageStats, String> {
    connection
        .execute_batch("VACUUM")
        .map_err(|error| error.to_string())?;
    get_storage_stats(connection)
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        fs,
        io::Cursor,
        time::{SystemTime, UNIX_EPOCH},
    };

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::{DynamicImage, ImageFormat, RgbaImage};
    use rusqlite::{
        params,
        trace::{TraceEvent, TraceEventCodes},
        Connection,
    };

    use super::*;

    thread_local! {
        static HISTORY_QUERY_SELECT_COUNT: Cell<usize> = const { Cell::new(0) };
    }

    fn trace_history_query_select(event: TraceEvent<'_>) {
        let TraceEvent::Stmt(_, statement) = event else {
            return;
        };
        let statement = statement.trim_start();
        // SQLite 以 `--` 标出 FTS 虚表的内部语句；这里只统计生产查询显式发出的 SELECT。
        if statement.starts_with("SELECT") {
            HISTORY_QUERY_SELECT_COUNT.with(|count| count.set(count.get() + 1));
        }
    }

    fn traced_history_query_select_count(database: &mut Connection, limit: u32) -> usize {
        HISTORY_QUERY_SELECT_COUNT.with(|count| count.set(0));
        database.trace_v2(
            TraceEventCodes::SQLITE_TRACE_STMT,
            Some(trace_history_query_select),
        );
        let result = query_history(
            database,
            HistoryQuery {
                limit,
                ..HistoryQuery::default()
            },
        );
        database.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, None);
        result.expect("traced history query");
        HISTORY_QUERY_SELECT_COUNT.with(Cell::get)
    }

    fn pragma_i64(connection: &Connection, name: &str) -> i64 {
        connection
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .expect("read pragma")
    }

    fn table_exists(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
                |row| row.get::<_, i64>(0),
            )
            .expect("find table")
            == 1
    }

    fn rgba_icon_data_url(rgba: [u8; 4]) -> String {
        let image = RgbaImage::from_pixel(64, 64, image::Rgba(rgba));
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, ImageFormat::Png)
            .expect("encode icon");
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(cursor.into_inner())
        )
    }

    fn rgba_png_bytes(rgba: [u8; 4]) -> Vec<u8> {
        STANDARD
            .decode(
                rgba_icon_data_url(rgba)
                    .strip_prefix(SOURCE_APP_ICON_DATA_URL_PREFIX)
                    .expect("PNG data URL"),
            )
            .expect("decode fixture PNG")
    }

    fn data_url_bytes(bytes: &[u8]) -> String {
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    fn text_item(id: &str, copied_at: &str) -> HistoryItem {
        HistoryItem {
            id: id.into(),
            kind: "text".into(),
            title: format!("标题 {id}"),
            content: format!("正文 {id}"),
            source_app: "Test App".into(),
            source_app_icon: None,
            copied_at: copied_at.into(),
            updated_at: copied_at.into(),
            pinned: false,
            permanent: false,
            collection_id: None,
            search_terms: vec!["test".into()],
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

    fn image_item(id: &str, copied_at: &str, bytes: &[u8]) -> HistoryItem {
        let mut item = text_item(id, copied_at);
        item.kind = "image".into();
        item.formats = vec!["image".into()];
        item.image_url = Some(data_url_bytes(bytes));
        item
    }

    fn store_png_image(database: &mut Connection, id: &str, rgba: [u8; 4]) {
        apply_history_mutation(
            database,
            mutation(
                vec![image_item(
                    id,
                    "2026-07-01T00:00:00.000Z",
                    &rgba_png_bytes(rgba),
                )],
                CapacityPolicy::default(),
            ),
        )
        .expect("store PNG image");
    }

    fn mutation(upserts: Vec<HistoryItem>, policy: CapacityPolicy) -> HistoryMutation {
        HistoryMutation {
            upserts,
            delete_ids: Vec::new(),
            policy,
        }
    }

    fn history_query(text: &str) -> HistoryQuery {
        HistoryQuery {
            text: text.into(),
            kinds: Vec::new(),
            source_apps: Vec::new(),
            collection: CollectionScope::Any {},
            pinned: None,
            permanent: None,
            limit: 50,
            cursor: None,
        }
    }

    fn batch_query(text: &str) -> BatchHistoryQuery {
        BatchHistoryQuery {
            text: text.into(),
            kinds: Vec::new(),
            source_apps: Vec::new(),
            collection: CollectionScope::Any {},
            pinned: None,
        }
    }

    fn query_ids(database: &Connection, query: HistoryQuery) -> Vec<String> {
        query_history(database, query)
            .expect("query history")
            .items
            .into_iter()
            .map(|item| item.id)
            .collect()
    }

    fn serialized_object_keys(item: &HistoryItem) -> Vec<String> {
        let mut keys = serde_json::to_value(item)
            .expect("serialize history item")
            .as_object()
            .expect("history item object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    fn sorted_keys(keys: &[&str]) -> Vec<String> {
        let mut keys = keys.iter().map(|key| (*key).to_owned()).collect::<Vec<_>>();
        keys.sort();
        keys
    }

    fn expected_item_keys(extras: &[&str]) -> Vec<String> {
        let mut keys = vec![
            "id",
            "kind",
            "title",
            "content",
            "sourceApp",
            "copiedAt",
            "updatedAt",
            "pinned",
            "permanent",
            "searchTerms",
            "formats",
            "payloadLoaded",
            "files",
        ];
        keys.extend_from_slice(extras);
        sorted_keys(&keys)
    }

    fn temporary_database_path(name: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "quickpaste-history-{name}-{}-{nonce}.sqlite3",
            std::process::id()
        ))
    }

    fn temporary_history_directory(name: &str) -> std::path::PathBuf {
        let path = temporary_database_path(name).with_extension("fixture");
        fs::create_dir(&path).expect("create isolated history fixture directory");
        path
    }

    fn create_closed_restore_fixture(path: &Path, id: &str) {
        let mut database = Connection::open(path).expect("open restore fixture");
        configure_history_database_connection(&database).expect("configure restore fixture");
        initialize_history_database(&mut database).expect("initialize restore fixture");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item(id, "2026-07-01T00:00:00.000Z")],
                CapacityPolicy {
                    max_records: 777,
                    max_image_bytes: 98_765,
                    retention_days: Some(45),
                },
            ),
        )
        .expect("seed restore fixture");
        database
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
            .expect("consolidate restore fixture");
    }

    #[test]
    fn restore_validation_streams_large_image_ocr_and_icon_rows() {
        let source = include_str!("history.rs");
        let validator = source
            .split_once("fn validate_restore_runtime_contracts(")
            .expect("restore validator source")
            .1
            .split_once("struct RestoreSourceStamp")
            .expect("restore validator end")
            .0;
        assert!(
            !validator.contains("load_history(connection)"),
            "restore validation must not retain every full payload at once"
        );

        let mut database = Connection::open_in_memory().expect("open streaming restore fixture");
        initialize_history_database(&mut database).expect("initialize streaming restore fixture");
        let icon_url = rgba_icon_data_url([17, 34, 51, 255]);
        let png = STANDARD
            .decode(
                icon_url
                    .strip_prefix("data:image/png;base64,")
                    .expect("fixture PNG prefix"),
            )
            .expect("decode fixture PNG");
        let items = (0..24)
            .map(|index| {
                let mut item = image_item(
                    &format!("streamed-{index:02}"),
                    "2026-07-01T00:00:00.000Z",
                    &png,
                );
                item.pinned = true;
                item.source_app = format!("Streaming Source {index:02}");
                item.source_app_icon = Some(icon_url.clone());
                item.image_hash = Some(format!("{index:064x}"));
                item.ocr_status = Some("completed".into());
                item.ocr_text = Some("本地 OCR 结果\r\n".repeat(8_192));
                item
            })
            .collect();
        apply_history_mutation(
            &mut database,
            mutation(
                items,
                CapacityPolicy {
                    max_records: 1,
                    max_image_bytes: 1,
                    retention_days: None,
                },
            ),
        )
        .expect("seed protected large restore fixture");

        assert_eq!(
            validate_restore_runtime_contracts(&database, true)
                .expect("stream-validate every restore row"),
            24
        );
        database
            .execute(
                "UPDATE clips SET ocr_text = 'invalid' || char(10) || 'newline'
                 WHERE id = 'streamed-00'",
                [],
            )
            .expect("inject noncanonical restored OCR text");
        assert!(
            validate_restore_runtime_contracts(&database, true).is_err(),
            "restore validation must reject OCR text outside the native output contract"
        );
    }

    #[test]
    fn restore_validation_rejects_malformed_thumbnail_rows() {
        let mut database = Connection::open_in_memory().expect("open thumbnail restore fixture");
        store_png_image(&mut database, "restore-thumbnail", [17, 34, 51, 255]);
        database
            .execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("allow malformed restore cache fixture");
        database
            .execute(
                "UPDATE clip_thumbnails SET thumbnail_png = 'not a PNG'
                 WHERE clip_id = 'restore-thumbnail'",
                [],
            )
            .expect("inject malformed restored thumbnail");

        assert!(validate_restore_runtime_contracts(&database, false).is_err());
    }

    fn create_v4_schema(database: &mut Connection) {
        let transaction = database.transaction().expect("begin v4 fixture");
        transaction
            .pragma_update(None, "application_id", APPLICATION_ID)
            .expect("set application id");
        migrate_to_v1(&transaction).expect("create v1 schema");
        migrate_to_v2(&transaction).expect("create v2 schema");
        migrate_to_v3(&transaction).expect("create v3 schema");
        migrate_to_v4(&transaction).expect("create v4 schema");
        transaction
            .execute_batch("PRAGMA user_version = 4")
            .expect("set v4 schema version");
        transaction.commit().expect("commit v4 fixture");
    }

    fn create_v5_schema(database: &mut Connection) {
        create_v4_schema(database);
        let transaction = database.transaction().expect("begin v5 fixture");
        migrate_to_v5(&transaction).expect("create v5 schema");
        transaction
            .execute_batch("PRAGMA user_version = 5")
            .expect("set v5 schema version");
        transaction.commit().expect("commit v5 fixture");
    }

    fn create_v7_schema(database: &mut Connection) {
        create_v5_schema(database);
        let transaction = database.transaction().expect("begin v7 fixture");
        migrate_to_v6(&transaction).expect("create v6 schema");
        migrate_to_v7(&transaction).expect("create v7 schema");
        transaction
            .execute_batch("PRAGMA user_version = 7")
            .expect("set v7 schema version");
        transaction.commit().expect("commit v7 fixture");
    }

    fn create_v8_schema(database: &mut Connection) {
        create_v7_schema(database);
        let transaction = database.transaction().expect("begin v8 fixture");
        migrate_to_v8(&transaction).expect("create v8 schema");
        transaction
            .execute_batch("PRAGMA user_version = 8")
            .expect("set v8 schema version");
        transaction.commit().expect("commit v8 fixture");
    }

    fn create_v9_schema(database: &mut Connection) {
        create_v8_schema(database);
        let transaction = database.transaction().expect("begin v9 fixture");
        migrate_to_v9(&transaction).expect("create v9 schema");
        transaction
            .execute_batch("PRAGMA user_version = 9")
            .expect("set v9 schema version");
        transaction.commit().expect("commit v9 fixture");
    }

    fn create_v10_schema(database: &mut Connection) {
        create_v9_schema(database);
        let transaction = database.transaction().expect("begin v10 fixture");
        migrate_to_v10(&transaction).expect("create v10 schema");
        transaction
            .execute_batch("PRAGMA user_version = 10")
            .expect("set v10 schema version");
        transaction.commit().expect("commit v10 fixture");
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("read table columns");
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
            .iter()
            .any(|name| name == column)
    }

    #[test]
    fn fresh_schema_uses_version_eleven_with_one_default_settings_row() {
        let mut database = Connection::open_in_memory().expect("in-memory database");

        initialize_history_database(&mut database).expect("initialize fresh database");

        assert_eq!(pragma_i64(&database, "application_id"), 0x5150_5354);
        assert_eq!(pragma_i64(&database, "user_version"), 11);
        assert_eq!(pragma_i64(&database, "foreign_keys"), 1);
        assert!(column_exists(&database, "clips", "omitted_formats"));
        for table in [
            "clips",
            "clip_formats",
            "clip_files",
            "collections",
            "source_app_icons",
            "clip_thumbnails",
            "history_settings",
        ] {
            assert!(table_exists(&database, table), "missing {table}");
        }
        let settings = database
            .query_row(
                "SELECT singleton, max_records, max_image_bytes, retention_days, revision
                 FROM history_settings",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .expect("read singleton history settings");
        assert_eq!(settings, (1, 500, 256 * 1024 * 1024, Some(30), 0));
        let stats = get_storage_stats(&database).expect("read stats before first mutation");
        assert_eq!(stats.record_count, 0);
        assert_eq!(stats.max_records, 500);
        assert_eq!(stats.max_image_bytes, 256 * 1024 * 1024);
        assert_eq!(stats.retention_days, Some(30));
        assert!(database
            .execute(
                "INSERT INTO history_settings(
                   singleton, max_records, max_image_bytes, retention_days, revision
                 ) VALUES (2, 1, 1, NULL, 0)",
                [],
            )
            .is_err());
        assert!(database
            .execute(
                "INSERT INTO source_app_icons(source_app, icon_png) VALUES ('Too Big', ?1)",
                [vec![0_u8; 32 * 1024 + 1]],
            )
            .is_err());
    }

    #[test]
    fn current_schema_contract_rejects_a_missing_thumbnail_table() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize current schema");
        database
            .execute_batch("DROP TABLE clip_thumbnails")
            .expect("remove thumbnail table fixture");

        assert!(validate_current_history_contract(&database).is_err());
    }

    #[test]
    fn v10_to_v11_migration_creates_thumbnail_table_and_preserves_existing_rows() {
        let mut database = Connection::open_in_memory().expect("open v10 thumbnail fixture");
        create_v10_schema(&mut database);
        database
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, logical_bytes, omitted_formats
                 ) VALUES (
                   'v10-kept', 'text', 'kept', 'body', 'Test',
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0,
                   '[]', 4, '[]'
                 )",
                [],
            )
            .expect("seed v10 clip");

        initialize_history_database(&mut database).expect("migrate v10 thumbnail schema");

        assert_eq!(pragma_i64(&database, "user_version"), 11);
        assert!(table_exists(&database, "clip_thumbnails"));
        assert_eq!(
            database
                .query_row("SELECT title FROM clips WHERE id = 'v10-kept'", [], |row| {
                    row.get::<_, String>(0)
                })
                .expect("read preserved v10 clip"),
            "kept"
        );
        assert_eq!(
            database
                .query_row("SELECT COUNT(*) FROM clip_thumbnails", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("count migrated thumbnails"),
            0
        );
    }

    #[test]
    fn schema_v8_then_v9_migrates_atomically_and_rejects_invalid_v7_rows() {
        let mut database = Connection::open_in_memory().expect("open v7 migration fixture");
        create_v7_schema(&mut database);
        database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES ('kept', ' Work ', '2026-07-01T00:00:00.000Z',
                         '2026-07-01T00:00:00.000Z', 0)",
                [],
            )
            .expect("insert invalid trimmed v7 collection");

        assert!(initialize_history_database(&mut database).is_err());
        assert_eq!(pragma_i64(&database, "user_version"), 7);
        assert_eq!(
            database
                .query_row(
                    "SELECT name FROM collections WHERE id = 'kept'",
                    [],
                    |row| { row.get::<_, String>(0) }
                )
                .expect("migration rollback keeps original collection"),
            " Work "
        );

        database
            .execute("DELETE FROM collections", [])
            .expect("remove invalid v7 collection");
        database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES ('kept', 'Work', '2026-07-01T00:00:00.000Z',
                         '2026-07-01T00:00:00.000Z', 0)",
                [],
            )
            .expect("insert valid v7 collection");

        initialize_history_database(&mut database).expect("migrate valid v7 collection");
        assert_eq!(pragma_i64(&database, "user_version"), 11);
        assert_eq!(
            list_history_collections(&database)
                .expect("list migrated collections")
                .into_iter()
                .map(|collection| collection.name)
                .collect::<Vec<_>>(),
            vec!["Work"]
        );
    }

    #[test]
    fn v9_migration_preserves_legacy_images_but_atomically_drops_unverifiable_ocr() {
        let mut database = Connection::open_in_memory().expect("open v8 OCR fixture");
        create_v8_schema(&mut database);
        let image_bytes = b"legacy-image-payload".to_vec();
        database
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at,
                   pinned, search_terms, ocr_text, ocr_status, logical_bytes,
                   color, dimensions, permanent, collection_id, omitted_formats
                 ) VALUES(
                   'legacy-image', 'image', '旧图片', '保留的图片记录', 'Test App',
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
                   0, '[]', 'legacyorczebra', 'completed', ?1,
                   '#123456', '1 × 1', 0, NULL, '[]'
                 )",
                [i64::try_from(image_bytes.len()).expect("payload length")],
            )
            .expect("insert v8 image metadata");
        database
            .execute(
                "INSERT INTO clip_formats(clip_id, format, mime, data)
                 VALUES ('legacy-image', 'image', 'image/png', ?1)",
                [&image_bytes],
            )
            .expect("insert v8 image payload");
        database
            .execute(
                "INSERT INTO clip_search(clip_id, normalized_text)
                 VALUES ('legacy-image', '旧图片 保留的图片记录 test app legacyorczebra')",
                [],
            )
            .expect("insert v8 OCR search projection");
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_search_fts WHERE clip_search_fts MATCH ?1",
                    ["\"legacyorczebra\""],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query v8 OCR projection"),
            1
        );

        initialize_history_database(&mut database).expect("migrate v8 OCR fixture");

        assert_eq!(pragma_i64(&database, "user_version"), 11);
        let migrated = get_clip_payload(&database, "legacy-image")
            .expect("load migrated image")
            .expect("legacy image remains");
        assert_eq!(migrated.content, "保留的图片记录");
        assert_eq!(
            migrated.image_url.as_deref(),
            Some(data_url_bytes(&image_bytes).as_str())
        );
        assert_eq!(migrated.color.as_deref(), Some("#123456"));
        assert_eq!(migrated.dimensions.as_deref(), Some("1 × 1"));
        assert_eq!(migrated.image_hash, None);
        assert_eq!(migrated.ocr_status, None);
        assert_eq!(migrated.ocr_text, None);
        assert!(query_ids(&database, history_query("legacyorczebra")).is_empty());
        assert_eq!(
            query_ids(&database, history_query("保留的图片记录")),
            vec!["legacy-image"]
        );
        database
            .execute(
                "INSERT INTO clip_search_fts(clip_search_fts) VALUES ('integrity-check')",
                [],
            )
            .expect("validate migrated FTS index");
    }

    #[test]
    fn v10_migration_requeues_hashed_images_and_removes_stale_ocr_from_search() {
        let mut database = Connection::open_in_memory().expect("open v9 OCR fixture");
        create_v9_schema(&mut database);
        let image_bytes = b"current-image-payload".to_vec();
        let image_hash = "a".repeat(64);
        database
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at,
                   pinned, search_terms, ocr_text, ocr_status, logical_bytes,
                   color, dimensions, permanent, collection_id, omitted_formats, image_hash
                 ) VALUES(
                   'current-image', 'image', '当前图片', '保留的图片记录', 'Test App',
                   '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
                   0, '[]', 'wrongenglishocr', 'completed', ?1,
                   '#123456', '10 × 10', 0, NULL, '[]', ?2
                 )",
                params![
                    i64::try_from(image_bytes.len()).expect("payload length"),
                    image_hash
                ],
            )
            .expect("insert v9 image metadata");
        database
            .execute(
                "INSERT INTO clip_formats(clip_id, format, mime, data)
                 VALUES ('current-image', 'image', 'image/png', ?1)",
                [&image_bytes],
            )
            .expect("insert v9 image payload");
        database
            .execute(
                "INSERT INTO clip_search(clip_id, normalized_text)
                 VALUES ('current-image', '当前图片 保留的图片记录 test app wrongenglishocr')",
                [],
            )
            .expect("insert v9 OCR search projection");

        initialize_history_database(&mut database).expect("migrate v9 OCR fixture");

        assert_eq!(pragma_i64(&database, "user_version"), 11);
        let migrated = get_clip_payload(&database, "current-image")
            .expect("load migrated image")
            .expect("current image remains");
        assert_eq!(migrated.ocr_status.as_deref(), Some("pending"));
        assert_eq!(migrated.ocr_text, None);
        assert_eq!(migrated.image_hash.as_deref(), Some(image_hash.as_str()));
        assert_eq!(
            migrated.image_url.as_deref(),
            Some(data_url_bytes(&image_bytes).as_str())
        );
        assert!(query_ids(&database, history_query("wrongenglishocr")).is_empty());
        assert_eq!(
            query_ids(&database, history_query("保留的图片记录")),
            vec!["current-image"]
        );
    }

    #[test]
    fn collection_crud_trims_exactly_orders_checked_values_and_uses_closed_shapes() {
        let mut database = Connection::open_in_memory().expect("open collection database");
        initialize_history_database(&mut database).expect("initialize collection database");

        let work = create_history_collection(&mut database, "\u{feff} Work \u{0085}")
            .expect("create trimmed collection");
        let lower = create_history_collection(&mut database, "work")
            .expect("BINARY uniqueness remains case-sensitive");
        assert_eq!(work.name, "Work");
        assert_eq!(work.sort_order, 0);
        assert_eq!(lower.sort_order, 1);
        assert_eq!(
            normalize_timestamp(&work.created_at).as_deref(),
            Ok(work.created_at.as_str())
        );
        assert_eq!(work.created_at, work.updated_at);
        assert!(history_id_is_cursor_safe(&work.id));
        assert_eq!(
            serde_json::to_value(&work)
                .expect("serialize collection")
                .as_object()
                .expect("collection object")
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            ["createdAt", "id", "name", "sortOrder", "updatedAt"]
                .into_iter()
                .map(str::to_owned)
                .collect()
        );
        assert!(create_history_collection(&mut database, "  Work  ").is_err());
        assert!(create_history_collection(&mut database, "\u{feff} \u{0085}").is_err());

        let renamed = rename_history_collection(&mut database, &work.id, "  Archive  ")
            .expect("rename collection excluding itself");
        assert_eq!(renamed.name, "Archive");
        assert_eq!(renamed.created_at, work.created_at);
        assert_eq!(renamed.sort_order, work.sort_order);
        assert!(renamed.updated_at >= work.updated_at);
        assert!(rename_history_collection(&mut database, &lower.id, "Archive").is_err());
        assert!(rename_history_collection(&mut database, "missing", "Missing").is_err());

        database
            .execute(
                "UPDATE collections SET sort_order = ?1 WHERE id = ?2",
                params![JS_MAX_SAFE_INTEGER_I64, lower.id],
            )
            .expect("set maximum safe sort order");
        assert!(create_history_collection(&mut database, "Overflow").is_err());
        assert!(database
            .execute(
                "UPDATE collections SET sort_order = ?1 WHERE id = ?2",
                params![JS_MAX_SAFE_INTEGER_I64 + 1, lower.id],
            )
            .is_err());
    }

    #[test]
    fn collection_delete_moves_clips_to_unfiled_and_rolls_back_partial_failure() {
        let mut database = Connection::open_in_memory().expect("open collection delete database");
        initialize_history_database(&mut database).expect("initialize collection delete database");
        let collection =
            create_history_collection(&mut database, "Work").expect("create delete collection");
        let mut first = text_item("first", "2026-07-01T00:00:00.000Z");
        first.collection_id = Some(collection.id.clone());
        let mut second = text_item("second", "2026-07-02T00:00:00.000Z");
        second.collection_id = Some(collection.id.clone());
        apply_history_mutation(
            &mut database,
            mutation(vec![first, second], CapacityPolicy::default()),
        )
        .expect("seed collected clips");
        database
            .execute_batch(
                "CREATE TRIGGER injected_collection_delete_failure
                 BEFORE DELETE ON collections BEGIN
                   SELECT RAISE(ABORT, 'injected collection delete failure');
                 END;",
            )
            .expect("inject delete failure after explicit unfile update");

        assert!(delete_history_collection(&mut database, &collection.id).is_err());
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clips WHERE collection_id = ?1",
                    [&collection.id],
                    |row| row.get::<_, i64>(0),
                )
                .expect("rollback preserves collection relations"),
            2
        );

        database
            .execute_batch("DROP TRIGGER injected_collection_delete_failure")
            .expect("remove injected delete failure");
        let result = delete_history_collection(&mut database, &collection.id)
            .expect("delete collection to unfiled");
        assert_eq!(result.affected_count, 2);
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clips WHERE collection_id IS NULL",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count unfiled clips"),
            2
        );
        assert!(delete_history_collection(&mut database, &collection.id).is_err());
        assert!(database
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .expect("check collection foreign keys")
            .is_none());
    }

    #[test]
    fn snippet_create_and_edit_are_plain_only_preserve_copied_at_and_refresh_fts() {
        let mut database = Connection::open_in_memory().expect("open snippet database");
        initialize_history_database(&mut database).expect("initialize snippet database");
        let collection = create_history_collection(&mut database, "Snippets")
            .expect("create snippet collection");
        let created = save_history_snippet(
            &mut database,
            SnippetDraft {
                id: None,
                title: "  Build command  ".into(),
                content: " npm run build\n".into(),
                collection_id: Some(collection.id.clone()),
                kind: "code".into(),
            },
        )
        .expect("create plain snippet");
        assert_eq!(created.title, "Build command");
        assert_eq!(created.content, " npm run build\n");
        assert_eq!(created.kind, "code");
        assert_eq!(created.source_app, "QuickPaste");
        assert!(created.permanent);
        assert!(!created.pinned);
        assert_eq!(
            created.collection_id.as_deref(),
            Some(collection.id.as_str())
        );
        assert_eq!(created.formats, vec!["text"]);
        assert!(created.omitted_formats.is_empty());
        assert_eq!(created.copied_at, created.updated_at);
        assert_eq!(
            normalize_timestamp(&created.copied_at).as_deref(),
            Ok(created.copied_at.as_str())
        );
        assert_eq!(
            query_ids(&database, history_query("npm")),
            vec![created.id.clone()]
        );

        database
            .execute(
                "INSERT INTO clip_formats(clip_id, format, mime, data)
                 VALUES (?1, 'html', 'text/html', '<b>stale</b>'),
                        (?1, 'rtf', 'application/rtf', X'727466'),
                        (?1, 'image', 'image/png', X'89504E47')",
                [&created.id],
            )
            .expect("inject stale rich payload");
        database
            .execute(
                "INSERT INTO clip_files(
                   clip_id, ordinal, path, name, directory, exists_at_capture
                 ) VALUES (?1, 0, 'C:\\stale.txt', 'stale.txt', 0, 1)",
                [&created.id],
            )
            .expect("inject stale file payload");
        database
            .execute(
                "UPDATE clips SET omitted_formats = '[\"html\",\"rtf\"]',
                                  ocr_text = 'stale OCR', ocr_status = 'completed',
                                  color = '#123456', dimensions = '1x1'
                 WHERE id = ?1",
                [&created.id],
            )
            .expect("inject stale optional payload metadata");

        let edited = save_history_snippet(
            &mut database,
            SnippetDraft {
                id: Some(created.id.clone()),
                title: "  Release note  ".into(),
                content: "new exact body  \n".into(),
                collection_id: None,
                kind: "text".into(),
            },
        )
        .expect("edit snippet and clear stale payload");
        assert_eq!(edited.copied_at, created.copied_at);
        assert!(edited.updated_at > created.updated_at);
        assert_eq!(edited.title, "Release note");
        assert_eq!(edited.content, "new exact body  \n");
        assert_eq!(edited.kind, "text");
        assert_eq!(edited.collection_id, None);
        assert_eq!(edited.formats, vec!["text"]);
        assert!(edited.html.is_none());
        assert!(edited.rtf_base64.is_none());
        assert!(edited.image_url.is_none());
        assert!(edited.files.is_empty());
        assert!(edited.omitted_formats.is_empty());
        assert!(edited.ocr_text.is_none());
        assert!(edited.ocr_status.is_none());
        assert!(edited.color.is_none());
        assert!(edited.dimensions.is_none());
        assert!(query_ids(&database, history_query("npm")).is_empty());
        assert_eq!(
            query_ids(&database, history_query("exact body")),
            vec![created.id]
        );
    }

    #[test]
    fn snippet_validation_and_mid_write_failure_leave_existing_state_unchanged() {
        let mut database = Connection::open_in_memory().expect("open snippet validation database");
        initialize_history_database(&mut database).expect("initialize snippet validation database");
        let collection =
            create_history_collection(&mut database, "Valid").expect("create valid collection");
        for draft in [
            SnippetDraft {
                id: None,
                title: "Empty".into(),
                content: " \u{feff} \u{0085}".into(),
                collection_id: None,
                kind: "text".into(),
            },
            SnippetDraft {
                id: None,
                title: "Invalid kind".into(),
                content: "body".into(),
                collection_id: None,
                kind: "link".into(),
            },
            SnippetDraft {
                id: None,
                title: "Missing collection".into(),
                content: "body".into(),
                collection_id: Some("missing".into()),
                kind: "code".into(),
            },
        ] {
            assert!(save_history_snippet(&mut database, draft).is_err());
        }
        assert!(save_history_snippet(
            &mut database,
            SnippetDraft {
                id: Some("missing".into()),
                title: "Missing".into(),
                content: "body".into(),
                collection_id: Some(collection.id.clone()),
                kind: "text".into(),
            },
        )
        .is_err());
        let ordinary = text_item("ordinary", "2026-07-01T00:00:00.000Z");
        apply_history_mutation(
            &mut database,
            mutation(vec![ordinary], CapacityPolicy::default()),
        )
        .expect("seed ordinary row");
        assert!(save_history_snippet(
            &mut database,
            SnippetDraft {
                id: Some("ordinary".into()),
                title: "Not editable".into(),
                content: "body".into(),
                collection_id: None,
                kind: "text".into(),
            },
        )
        .is_err());

        let created = save_history_snippet(
            &mut database,
            SnippetDraft {
                id: None,
                title: "Stable".into(),
                content: "before".into(),
                collection_id: Some(collection.id),
                kind: "text".into(),
            },
        )
        .expect("create rollback snippet");
        database
            .execute_batch(
                "CREATE TRIGGER injected_snippet_format_failure BEFORE DELETE ON clip_formats BEGIN
                   SELECT RAISE(ABORT, 'injected snippet format failure');
                 END;",
            )
            .expect("inject snippet write failure");
        assert!(save_history_snippet(
            &mut database,
            SnippetDraft {
                id: Some(created.id.clone()),
                title: "Changed".into(),
                content: "after".into(),
                collection_id: None,
                kind: "code".into(),
            },
        )
        .is_err());
        database
            .execute_batch("DROP TRIGGER injected_snippet_format_failure")
            .expect("remove snippet write failure");
        let unchanged = get_clip_payload(&database, &created.id)
            .expect("load unchanged snippet")
            .expect("snippet remains");
        assert_eq!(unchanged.title, created.title);
        assert_eq!(unchanged.content, created.content);
        assert_eq!(unchanged.updated_at, created.updated_at);
    }

    #[test]
    fn permanent_records_are_plain_text_or_code_and_survive_all_automatic_capacity_pruning() {
        let mut database = Connection::open_in_memory().expect("open permanent snippet database");
        initialize_history_database(&mut database).expect("initialize permanent snippet database");
        let snippet = save_history_snippet(
            &mut database,
            SnippetDraft {
                id: None,
                title: "Protected".into(),
                content: "permanent body".into(),
                collection_id: None,
                kind: "code".into(),
            },
        )
        .expect("create protected snippet");
        let mut invalid = image_item("invalid-permanent", "2026-07-01T00:00:00.000Z", b"image");
        invalid.permanent = true;
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![invalid], CapacityPolicy::default()),
        )
        .is_err());

        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("ordinary", "2000-01-01T00:00:00.000Z")],
                CapacityPolicy {
                    max_records: 0,
                    max_image_bytes: 0,
                    retention_days: Some(0),
                },
            ),
        )
        .expect("apply most restrictive automatic policy");
        assert!(get_clip_payload(&database, &snippet.id)
            .expect("load protected snippet")
            .is_some());
        assert!(get_clip_payload(&database, "ordinary")
            .expect("load pruned ordinary row")
            .is_none());
    }

    #[test]
    fn batch_explicit_targets_are_deduped_idempotent_and_allow_confirmed_permanent_delete() {
        let mut database = Connection::open_in_memory().expect("open explicit batch database");
        initialize_history_database(&mut database).expect("initialize explicit batch database");
        let work =
            create_history_collection(&mut database, "Work").expect("create work collection");
        let archive =
            create_history_collection(&mut database, "Archive").expect("create archive collection");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("first", "2026-07-01T00:00:00.000Z"),
                    text_item("second", "2026-07-02T00:00:00.000Z"),
                ],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed explicit batch rows");
        let snippet = save_history_snippet(
            &mut database,
            SnippetDraft {
                id: None,
                title: "Permanent".into(),
                content: "delete only after confirmation".into(),
                collection_id: Some(work.id.clone()),
                kind: "text".into(),
            },
        )
        .expect("create permanent batch row");

        let moved = apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["second".into(), "first".into(), "second".into()],
            },
            BatchAction::Move {
                collection_id: Some(archive.id.clone()),
            },
        )
        .expect("move deduplicated explicit rows");
        assert_eq!(moved.matched_count, 2);
        assert_eq!(moved.changed_count, 2);
        assert_eq!(moved.deleted_count, 0);
        assert!(moved.pruned_ids.is_empty());
        let repeated = apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["first".into(), "second".into()],
            },
            BatchAction::Move {
                collection_id: Some(archive.id.clone()),
            },
        )
        .expect("repeat idempotent move");
        assert_eq!(repeated.changed_count, 0);

        let pinned = apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["first".into(), "second".into()],
            },
            BatchAction::SetPinned { pinned: true },
        )
        .expect("pin explicit rows");
        assert_eq!(pinned.changed_count, 2);
        assert_eq!(
            apply_history_batch(
                &mut database,
                BatchTarget::Ids {
                    ids: vec!["first".into(), "second".into()],
                },
                BatchAction::SetPinned { pinned: true },
            )
            .expect("repeat idempotent pin")
            .changed_count,
            0
        );
        assert!(apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["first".into(), "missing".into()],
            },
            BatchAction::SetPinned { pinned: false },
        )
        .is_err());
        assert!(apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["first".into()],
            },
            BatchAction::Move {
                collection_id: Some("missing".into()),
            },
        )
        .is_err());
        assert!(
            get_clip_payload(&database, "first")
                .expect("load first after rejected batches")
                .expect("first remains")
                .pinned
        );

        let revision_before_empty =
            history_revision(&database).expect("read revision before no-op");
        assert_eq!(
            apply_history_batch(
                &mut database,
                BatchTarget::Ids { ids: Vec::new() },
                BatchAction::Delete {},
            )
            .expect("empty explicit target is a no-op"),
            BatchResult {
                matched_count: 0,
                changed_count: 0,
                deleted_count: 0,
                pruned_ids: Vec::new(),
            }
        );
        assert_eq!(
            history_revision(&database).expect("read revision after no-op"),
            revision_before_empty
        );

        let deleted = apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec![snippet.id.clone()],
            },
            BatchAction::Delete {},
        )
        .expect("explicitly delete confirmed permanent snippet");
        assert_eq!(deleted.matched_count, 1);
        assert_eq!(deleted.changed_count, 1);
        assert_eq!(deleted.deleted_count, 1);
        assert!(get_clip_payload(&database, &snippet.id)
            .expect("load explicitly deleted snippet")
            .is_none());
    }

    #[test]
    fn batch_query_reuses_history_predicates_upper_bound_and_bounded_exclusions() {
        let mut database = Connection::open_in_memory().expect("open query batch database");
        initialize_history_database(&mut database).expect("initialize query batch database");
        let work =
            create_history_collection(&mut database, "Work").expect("create query collection");
        let mut older = text_item("older", "2026-07-01T00:00:00.000Z");
        older.title = "火 alpha older".into();
        older.content = "火箭 alpha".into();
        older.collection_id = Some(work.id.clone());
        let mut selected = text_item("selected", "2026-07-02T00:00:00.000Z");
        selected.title = "火 alpha selected".into();
        selected.content = "火箭 alpha".into();
        selected.collection_id = Some(work.id.clone());
        let mut captured_after = text_item("captured-after", "2026-07-03T00:00:00.000Z");
        captured_after.title = "火 alpha new".into();
        captured_after.content = "火箭 alpha".into();
        captured_after.collection_id = Some(work.id.clone());
        let mut wrong_source = text_item("wrong-source", "2026-07-01T00:00:00.000Z");
        wrong_source.title = "火 alpha wrong".into();
        wrong_source.content = "火箭 alpha".into();
        wrong_source.source_app = "Other App".into();
        wrong_source.collection_id = Some(work.id.clone());
        apply_history_mutation(
            &mut database,
            mutation(
                vec![older, selected, captured_after, wrong_source],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed query batch rows");
        let target = BatchTarget::Query {
            query: BatchHistoryQuery {
                text: "火".into(),
                kinds: vec!["text".into()],
                source_apps: vec![" Test App ".into(), "Test App".into()],
                collection: CollectionScope::Collection {
                    id: work.id.clone(),
                },
                pinned: Some(false),
            },
            upper_bound: QueryUpperBound {
                copied_at: "2026-07-02T00:00:00.000Z".into(),
                id: "selected".into(),
            },
            excluded_ids: vec!["older".into(), "older".into()],
        };
        let result = apply_history_batch(
            &mut database,
            target,
            BatchAction::SetPinned { pinned: true },
        )
        .expect("apply frozen short-LIKE query target");
        assert_eq!(result.matched_count, 1);
        assert_eq!(result.changed_count, 1);
        assert!(
            get_clip_payload(&database, "selected")
                .expect("load selected query row")
                .expect("selected row exists")
                .pinned
        );
        assert!(
            !get_clip_payload(&database, "captured-after")
                .expect("load post-bound row")
                .expect("post-bound row exists")
                .pinned
        );
        assert!(
            !get_clip_payload(&database, "older")
                .expect("load excluded row")
                .expect("excluded row exists")
                .pinned
        );
        assert!(
            !get_clip_payload(&database, "wrong-source")
                .expect("load source-filtered row")
                .expect("source-filtered row exists")
                .pinned
        );

        let fts_result = apply_history_batch(
            &mut database,
            BatchTarget::Query {
                query: BatchHistoryQuery {
                    collection: CollectionScope::Collection { id: work.id },
                    ..batch_query("alpha")
                },
                upper_bound: QueryUpperBound {
                    copied_at: "2026-07-03T00:00:00.000Z".into(),
                    id: "captured-after".into(),
                },
                excluded_ids: vec!["selected".into(), "wrong-source".into()],
            },
            BatchAction::Move {
                collection_id: None,
            },
        )
        .expect("apply FTS query target to unfiled");
        assert_eq!(fts_result.matched_count, 2);
        assert_eq!(fts_result.changed_count, 2);
        assert_eq!(
            query_ids(
                &database,
                HistoryQuery {
                    collection: CollectionScope::Unfiled {},
                    ..history_query("alpha")
                },
            ),
            vec!["captured-after", "older"]
        );

        assert!(apply_history_batch(
            &mut database,
            BatchTarget::Query {
                query: batch_query(""),
                upper_bound: QueryUpperBound {
                    copied_at: "2026-07-03T08:00:00+08:00".into(),
                    id: "captured-after".into(),
                },
                excluded_ids: Vec::new(),
            },
            BatchAction::Delete {},
        )
        .is_err());
    }

    #[test]
    fn batch_mid_update_failure_rolls_back_every_row_revision_and_capacity_prune() {
        let mut database = Connection::open_in_memory().expect("open rollback batch database");
        initialize_history_database(&mut database).expect("initialize rollback batch database");
        let mut first = text_item("first", "2026-07-01T00:00:00.000Z");
        first.pinned = true;
        let mut second = text_item("second", "2026-07-02T00:00:00.000Z");
        second.pinned = true;
        apply_history_mutation(
            &mut database,
            mutation(
                vec![first, second],
                CapacityPolicy {
                    max_records: 1,
                    max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
                    retention_days: None,
                },
            ),
        )
        .expect("seed protected rollback rows");
        let revision = history_revision(&database).expect("read rollback revision");

        assert!(apply_history_batch_with_hook(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["first".into(), "second".into()],
            },
            BatchAction::SetPinned { pinned: false },
            |updated| {
                if updated == 1 {
                    Err("injected partial batch failure".to_owned())
                } else {
                    Ok(())
                }
            },
        )
        .is_err());
        for id in ["first", "second"] {
            assert!(
                get_clip_payload(&database, id)
                    .expect("load rolled back row")
                    .expect("rolled back row remains")
                    .pinned
            );
        }
        assert_eq!(
            history_revision(&database).expect("read rolled back revision"),
            revision
        );

        let committed = apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["first".into(), "second".into()],
            },
            BatchAction::SetPinned { pinned: false },
        )
        .expect("commit unpin and capacity bookkeeping");
        assert_eq!(committed.matched_count, 2);
        assert_eq!(committed.changed_count, 2);
        assert_eq!(committed.deleted_count, 0);
        assert_eq!(committed.pruned_ids, vec!["first"]);
        assert!(get_clip_payload(&database, "first")
            .expect("load pruned first row")
            .is_none());
        assert!(get_clip_payload(&database, "second")
            .expect("load kept second row")
            .is_some());
    }

    #[test]
    fn task8_native_contracts_are_closed_camel_case_and_enforce_raw_id_limits() {
        assert_eq!(
            serde_json::to_value(CollectionDeleteResult { affected_count: 2 })
                .expect("serialize collection delete result"),
            serde_json::json!({ "affectedCount": 2 })
        );
        assert_eq!(
            serde_json::to_value(BatchResult {
                matched_count: 4,
                changed_count: 3,
                deleted_count: 2,
                pruned_ids: vec!["old".into()],
            })
            .expect("serialize batch result"),
            serde_json::json!({
                "matchedCount": 4,
                "changedCount": 3,
                "deletedCount": 2,
                "prunedIds": ["old"],
            })
        );

        assert!(serde_json::from_value::<SnippetDraft>(serde_json::json!({
            "title": "Reusable",
            "content": "body",
            "kind": "text",
        }))
        .is_ok());
        for invalid in [
            serde_json::json!({
                "id": null,
                "title": "Reusable",
                "content": "body",
                "kind": "text",
            }),
            serde_json::json!({
                "title": "Reusable",
                "content": "body",
                "collectionId": null,
                "kind": "text",
            }),
            serde_json::json!({
                "title": "Reusable",
                "content": "body",
                "kind": "text",
                "unexpected": true,
            }),
        ] {
            assert!(serde_json::from_value::<SnippetDraft>(invalid).is_err());
        }
        assert!(serde_json::from_value::<Collection>(serde_json::json!({
            "id": "collection",
            "name": "Collection",
            "createdAt": "2026-07-01T00:00:00.000Z",
            "updatedAt": "2026-07-01T00:00:00.000Z",
            "sortOrder": 0,
            "unexpected": true,
        }))
        .is_err());
        assert!(serde_json::from_value::<BatchAction>(serde_json::json!({
            "type": "move",
            "collectionId": null,
        }))
        .is_ok());
        assert!(serde_json::from_value::<BatchAction>(serde_json::json!({
            "type": "setPinned",
            "pinned": true,
        }))
        .is_ok());
        for invalid in [
            serde_json::json!({ "type": "move" }),
            serde_json::json!({ "type": "delete", "unexpected": true }),
            serde_json::json!({ "type": "set_pinned", "pinned": true }),
        ] {
            assert!(serde_json::from_value::<BatchAction>(invalid).is_err());
        }
        assert!(serde_json::from_value::<BatchTarget>(serde_json::json!({
            "mode": "query",
            "query": {
                "text": "",
                "kinds": [],
                "sourceApps": [],
                "collection": { "mode": "any" },
                "pinned": null,
            },
            "upperBound": {
                "copiedAt": "2026-07-01T00:00:00.000Z",
                "id": "upper",
            },
            "excludedIds": [],
        }))
        .is_err());
        let valid_query_target = serde_json::json!({
            "mode": "query",
            "query": {
                "text": "",
                "kinds": [],
                "sourceApps": [],
                "collection": { "mode": "any" },
            },
            "upperBound": {
                "copiedAt": "2026-07-01T00:00:00.000Z",
                "id": "upper",
            },
            "excludedIds": [],
        });
        let parsed_query_target = serde_json::from_value::<BatchTarget>(valid_query_target.clone())
            .expect("deserialize camelCase query target");
        assert_eq!(
            serde_json::to_value(parsed_query_target).expect("serialize camelCase query target"),
            valid_query_target
        );

        let mut database = Connection::open_in_memory().expect("open batch limit database");
        initialize_history_database(&mut database).expect("initialize batch limit database");
        assert!(apply_history_batch(
            &mut database,
            BatchTarget::Ids {
                ids: vec!["duplicate".into(); MAX_BATCH_TARGET_IDS + 1],
            },
            BatchAction::Delete {},
        )
        .is_err());
        assert!(apply_history_batch(
            &mut database,
            BatchTarget::Query {
                query: batch_query(""),
                upper_bound: QueryUpperBound {
                    copied_at: "2026-07-01T00:00:00.000Z".into(),
                    id: "upper".into(),
                },
                excluded_ids: vec!["duplicate".into(); MAX_BATCH_TARGET_IDS + 1],
            },
            BatchAction::Delete {},
        )
        .is_err());
    }

    #[test]
    fn mutations_update_policy_and_revision_atomically_with_pruning() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let first_policy = CapacityPolicy {
            max_records: 25,
            max_image_bytes: 1_024,
            retention_days: Some(30),
        };
        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("policy-row", "2026-07-01T00:00:00.000Z")],
                first_policy.clone(),
            ),
        )
        .expect("store first policy and row");

        let read_settings = |connection: &Connection| {
            connection
                .query_row(
                    "SELECT max_records, max_image_bytes, retention_days, revision
                     FROM history_settings WHERE singleton = 1",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, u64>(0)?,
                            row.get::<_, u64>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, u64>(3)?,
                        ))
                    },
                )
                .expect("read history settings")
        };
        assert_eq!(read_settings(&database), (25, 1_024, Some(30), 1));

        database
            .execute_batch(
                "CREATE TRIGGER injected_prune_failure BEFORE DELETE ON clips BEGIN
                   SELECT RAISE(ABORT, 'injected prune failure');
                 END;",
            )
            .expect("inject prune failure");
        let replacement_policy = CapacityPolicy {
            max_records: 0,
            max_image_bytes: 512,
            retention_days: None,
        };
        assert!(apply_history_mutation(
            &mut database,
            mutation(Vec::new(), replacement_policy.clone()),
        )
        .is_err());
        assert_eq!(read_settings(&database), (25, 1_024, Some(30), 1));
        assert!(get_clip_payload(&database, "policy-row")
            .expect("read row after rollback")
            .is_some());

        database
            .execute_batch("DROP TRIGGER injected_prune_failure")
            .expect("remove prune failure");
        apply_history_mutation(&mut database, mutation(Vec::new(), replacement_policy))
            .expect("commit replacement policy");
        assert_eq!(read_settings(&database), (0, 512, None, 2));
        assert!(get_clip_payload(&database, "policy-row")
            .expect("read pruned row")
            .is_none());
    }

    #[test]
    fn v4_migration_backfills_empty_omitted_formats_without_touching_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        create_v4_schema(&mut database);
        database
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, logical_bytes
                 ) VALUES ('v4-row', 'text', 'V4', 'body', 'Test', ?1, ?1, 0, 0, '[]', 4)",
                ["2026-07-01T00:00:00.000Z"],
            )
            .expect("insert v4 row");

        initialize_history_database(&mut database).expect("migrate v4 database");

        assert_eq!(pragma_i64(&database, "user_version"), SCHEMA_VERSION);
        let stored: String = database
            .query_row(
                "SELECT omitted_formats FROM clips WHERE id = 'v4-row'",
                [],
                |row| row.get(0),
            )
            .expect("read backfilled omitted formats");
        assert_eq!(stored, "[]");
        let loaded = get_clip_payload(&database, "v4-row")
            .expect("load v4 row")
            .expect("v4 row exists");
        assert!(loaded.omitted_formats.is_empty());
    }

    #[test]
    fn current_schema_is_v11_and_rejects_noncanonical_image_hashes() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize current schema");

        assert_eq!(SCHEMA_VERSION, 11);
        let image_hash_column = database
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name = 'image_hash'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("inspect image_hash column");
        assert_eq!(image_hash_column, 1);
        let insert = database.execute(
            "INSERT INTO clips(
               id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
               permanent, search_terms, logical_bytes, image_hash
             ) VALUES (
               'bad-hash', 'image', 'bad', '', 'Test',
               '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0, '[]', 0, ?1
             )",
            ["A".repeat(64)],
        );
        assert!(
            insert.is_err(),
            "uppercase hashes must fail at the schema boundary"
        );
    }

    #[test]
    fn ocr_reads_only_the_hashed_png_and_conditionally_refreshes_search() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize current schema");
        let png_url = rgba_icon_data_url([10, 20, 30, 255]);
        let png = STANDARD
            .decode(
                png_url
                    .strip_prefix("data:image/png;base64,")
                    .expect("PNG URL"),
            )
            .expect("decode PNG fixture");
        let image_hash = "a".repeat(64);
        let mut image = image_item("ocr-image", "2026-07-01T00:00:00.000Z", &png);
        image.image_hash = Some(image_hash.clone());
        image.ocr_status = Some("pending".into());
        apply_history_mutation(
            &mut database,
            mutation(vec![image], CapacityPolicy::default()),
        )
        .expect("store OCR fixture");

        assert_eq!(
            load_stored_ocr_image(&database, "ocr-image", &image_hash)
                .expect("load stored OCR image"),
            StoredOcrImage::Ready(png.clone())
        );
        assert_eq!(
            load_stored_image_for_analysis(&database, "ocr-image")
                .expect("load stored image for local analysis"),
            Some(png.clone())
        );
        assert_eq!(
            load_stored_image_for_analysis(&database, " missing-id")
                .expect("invalid analysis id is not loaded"),
            None
        );
        assert_eq!(
            load_stored_ocr_image(&database, "ocr-image", &"b".repeat(64))
                .expect("mismatched hash is stale"),
            StoredOcrImage::Stale
        );
        let before: (String, i64, i64) = database
            .query_row(
                "SELECT updated_at, logical_bytes,
                        (SELECT length(data) FROM clip_formats
                         WHERE clip_id = clips.id AND format = 'image')
                 FROM clips WHERE id = 'ocr-image'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read immutable OCR columns");

        for invalid in [
            "含有\0空字节".to_owned(),
            "裸换行\n".to_owned(),
            "裸回车\r".to_owned(),
            "a".repeat(crate::ocr::OCR_TEXT_MAX_BYTES + 1),
        ] {
            assert!(apply_ocr_patch(
                &mut database,
                "ocr-image",
                &image_hash,
                "completed",
                Some(&invalid),
            )
            .is_err());
        }
        assert_eq!(
            load_stored_ocr_image(&database, "ocr-image", &image_hash)
                .expect("invalid OCR writes leave the image pending"),
            StoredOcrImage::Ready(png.clone())
        );

        assert!(apply_ocr_patch(
            &mut database,
            "ocr-image",
            &image_hash,
            "completed",
            Some("本地识别 alpha")
        )
        .expect("apply OCR patch"));
        let loaded = get_clip_payload(&database, "ocr-image")
            .expect("load OCR fixture")
            .expect("OCR fixture exists");
        assert_eq!(loaded.image_hash.as_deref(), Some(image_hash.as_str()));
        assert_eq!(loaded.ocr_status.as_deref(), Some("completed"));
        assert_eq!(loaded.ocr_text.as_deref(), Some("本地识别 alpha"));
        assert_eq!(
            query_ids(&database, history_query("本地识别")),
            ["ocr-image"]
        );
        assert_eq!(
            load_stored_ocr_image(&database, "ocr-image", &image_hash)
                .expect("terminal OCR request is stale"),
            StoredOcrImage::Stale
        );
        let after: (String, i64, i64) = database
            .query_row(
                "SELECT updated_at, logical_bytes,
                        (SELECT length(data) FROM clip_formats
                         WHERE clip_id = clips.id AND format = 'image')
                 FROM clips WHERE id = 'ocr-image'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read immutable OCR columns after patch");
        assert_eq!(after, before);
        assert!(
            !apply_ocr_patch(&mut database, "ocr-image", &"b".repeat(64), "failed", None)
                .expect("hash mismatch stays stale")
        );
        assert!(!apply_ocr_patch(
            &mut database,
            "ocr-image",
            &image_hash,
            "completed",
            Some("must not replace terminal OCR")
        )
        .expect("terminal OCR cannot be repeated"));
    }

    #[test]
    fn native_ocr_item_contract_is_image_only_and_status_text_pairs_are_closed() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut text = text_item("text-ocr", "2026-07-01T00:00:00.000Z");
        text.ocr_status = Some("completed".into());
        text.ocr_text = Some("forbidden".into());
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![text], CapacityPolicy::default())
        )
        .is_err());

        let mut pending_without_hash =
            image_item("pending-no-hash", "2026-07-01T00:00:00.000Z", b"image");
        pending_without_hash.ocr_status = Some("pending".into());
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![pending_without_hash], CapacityPolicy::default())
        )
        .is_err());

        let mut completed_without_text =
            image_item("completed-no-text", "2026-07-01T00:00:00.000Z", b"image");
        completed_without_text.image_hash = Some("f".repeat(64));
        completed_without_text.ocr_status = Some("completed".into());
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![completed_without_text], CapacityPolicy::default())
        )
        .is_err());

        let mut pending_with_text =
            image_item("pending-text", "2026-07-01T00:00:00.000Z", b"image");
        pending_with_text.image_hash = Some("0".repeat(64));
        pending_with_text.ocr_status = Some("pending".into());
        pending_with_text.ocr_text = Some("forbidden".into());
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![pending_with_text], CapacityPolicy::default())
        )
        .is_err());

        let mut completed = image_item("completed-canonical", "2026-07-01T00:00:00.000Z", b"image");
        completed.image_hash = Some("1".repeat(64));
        completed.ocr_status = Some("completed".into());
        completed.ocr_text = Some(String::new());
        assert!(validate_history_item(&completed).is_ok());
        completed.ocr_text = Some("第一行\r\n第二行".into());
        assert!(validate_history_item(&completed).is_ok());
        completed.ocr_text = Some("a".repeat(crate::ocr::OCR_TEXT_MAX_BYTES));
        assert!(validate_history_item(&completed).is_ok());
        for invalid in [
            "含有\0空字节".to_owned(),
            "裸换行\n".to_owned(),
            "裸回车\r".to_owned(),
            "a".repeat(crate::ocr::OCR_TEXT_MAX_BYTES + 1),
        ] {
            completed.ocr_text = Some(invalid);
            assert!(validate_history_item(&completed).is_err());
        }
    }

    #[test]
    fn pending_image_reuses_hidden_terminal_ocr_and_atomically_preserves_managed_metadata() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize current schema");
        database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES ('images', 'Images', '2026-07-01T00:00:00.000Z',
                         '2026-07-01T00:00:00.000Z', 0)",
                [],
            )
            .expect("insert image collection");
        let hash = "c".repeat(64);
        let mut old = image_item("old-image", "2026-07-01T00:00:00.000Z", b"old");
        old.image_hash = Some(hash.clone());
        old.ocr_status = Some("completed".into());
        old.ocr_text = Some("reused OCR".into());
        old.pinned = true;
        old.collection_id = Some("images".into());
        apply_history_mutation(
            &mut database,
            mutation(vec![old], CapacityPolicy::default()),
        )
        .expect("store terminal OCR row");

        let mut replacement = image_item("new-image", "2026-07-02T00:00:00.000Z", b"new");
        replacement.image_hash = Some(hash);
        replacement.ocr_status = Some("pending".into());
        let result = apply_history_mutation(
            &mut database,
            mutation(vec![replacement], CapacityPolicy::default()),
        )
        .expect("replace hidden duplicate image");

        let replacement = get_clip_payload(&database, "new-image")
            .expect("load replacement")
            .expect("replacement exists");
        assert_eq!(replacement.ocr_status.as_deref(), Some("completed"));
        assert_eq!(replacement.ocr_text.as_deref(), Some("reused OCR"));
        assert!(replacement.pinned);
        assert_eq!(replacement.collection_id.as_deref(), Some("images"));
        assert!(!replacement.permanent);
        assert_eq!(result.pruned_ids, vec!["old-image"]);
        assert!(get_clip_payload(&database, "old-image")
            .expect("load removed duplicate")
            .is_none());
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clips WHERE image_hash = ?1",
                    [replacement.image_hash.as_deref().expect("replacement hash")],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count same-hash rows"),
            1
        );
    }

    #[test]
    fn pending_ocr_listing_is_payload_free_bounded_and_pages_past_the_first_history_window() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize current schema");
        let mut pending = (0..19)
            .map(|index| {
                let mut image = image_item(
                    &format!("pending-{index:02}"),
                    &format!("2026-07-01T00:{index:02}:00.000Z"),
                    &[u8::try_from(index).expect("fixture byte")],
                );
                image.image_hash = Some(format!("{index:064x}"));
                image.ocr_status = Some("pending".into());
                image
            })
            .collect::<Vec<_>>();
        let mut completed = image_item("completed", "2026-07-01T01:00:00.000Z", b"done");
        completed.image_hash = Some("f".repeat(64));
        completed.ocr_status = Some("completed".into());
        completed.ocr_text = Some("done".into());
        pending.push(completed);
        apply_history_mutation(&mut database, mutation(pending, CapacityPolicy::default()))
            .expect("seed pending OCR pages");

        let mut cursor = None;
        let mut collected = Vec::new();
        loop {
            let page = list_pending_ocr_images(
                &database,
                PendingOcrQuery {
                    limit: 8,
                    cursor: cursor.clone(),
                },
            )
            .expect("list pending OCR page");
            assert!(!page.items.is_empty());
            assert!(page.items.len() <= 8);
            for item in &page.items {
                let value = serde_json::to_value(item).expect("serialize pending candidate");
                assert_eq!(
                    value
                        .as_object()
                        .expect("candidate object")
                        .keys()
                        .cloned()
                        .collect::<BTreeSet<_>>(),
                    ["id".to_owned(), "imageHash".to_owned()]
                        .into_iter()
                        .collect()
                );
                collected.push(item.id.clone());
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            collected,
            (0..19)
                .rev()
                .map(|index| format!("pending-{index:02}"))
                .collect::<Vec<_>>()
        );
        assert!(list_pending_ocr_images(
            &database,
            PendingOcrQuery {
                limit: 9,
                cursor: None,
            }
        )
        .is_err());
        assert!(list_pending_ocr_images(
            &database,
            PendingOcrQuery {
                limit: 8,
                cursor: Some("not-a-cursor".into()),
            }
        )
        .is_err());
    }

    #[test]
    fn failed_v5_migration_rolls_back_version_and_preserves_v4_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        create_v4_schema(&mut database);
        database
            .execute_batch(
                "ALTER TABLE clips ADD COLUMN omitted_formats TEXT NOT NULL DEFAULT '[]';
                 INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, logical_bytes
                 ) VALUES (
                   'rollback-row', 'text', 'Rollback', 'body', 'Test',
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0, '[]', 4
                 );",
            )
            .expect("create inconsistent v4 fixture");

        let error = initialize_history_database(&mut database).expect_err("migration must fail");

        assert!(
            error.contains("duplicate column"),
            "unexpected error: {error}"
        );
        assert_eq!(pragma_i64(&database, "user_version"), 4);
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clips WHERE id = 'rollback-row'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count preserved row"),
            1
        );
    }

    #[test]
    fn initialization_preserves_sqlite_and_contract_error_provenance() {
        let mut deep_sql_failure = Connection::open_in_memory().expect("deep SQL fixture");
        create_v5_schema(&mut deep_sql_failure);
        deep_sql_failure
            .execute_batch("CREATE TABLE clip_search(conflict INTEGER)")
            .expect("seed deep migration SQL conflict");
        let failure = initialize_history_database_classified(&mut deep_sql_failure)
            .expect_err("deep migration SQL failure must retain its rusqlite error");
        assert!(
            matches!(failure, HistoryInitializationFailure::Sqlite(_)),
            "deep SQL failure was downgraded: {failure:?}"
        );

        let mut stale_code = Connection::open_in_memory().expect("stale-code fixture");
        stale_code
            .execute_batch("SELECT * FROM definitely_missing_table")
            .expect_err("seed the connection's previous SQLite error code");
        stale_code
            .pragma_update(None, "application_id", APPLICATION_ID + 1)
            .expect("set incompatible application id");
        let failure = initialize_history_database_classified(&mut stale_code)
            .expect_err("application contract must be rejected");
        assert!(
            matches!(failure, HistoryInitializationFailure::Contract(_)),
            "contract failure inherited a stale SQLite code: {failure:?}"
        );
        assert_eq!(
            failure.open_failure(),
            HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Incompatible)
        );

        for (code, expected) in [
            (
                rusqlite::ffi::SQLITE_CORRUPT,
                HistoryOpenFailure::ConfirmedCorruption(RecoveryReason::Corrupt),
            ),
            (
                rusqlite::ffi::SQLITE_NOTADB,
                HistoryOpenFailure::ConfirmedCorruption(RecoveryReason::NotADatabase),
            ),
            (
                rusqlite::ffi::SQLITE_BUSY,
                HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::Busy),
            ),
            (
                rusqlite::ffi::SQLITE_FULL,
                HistoryOpenFailure::ReadOnly(HistoryReadOnlyReason::DiskFull),
            ),
        ] {
            let failure = HistoryInitializationFailure::Sqlite(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                None,
            ));
            assert_eq!(failure.open_failure(), expected);
        }
    }

    #[test]
    fn legacy_backfill_keeps_sqlite_failures_typed_as_sqlite() {
        let mut database = Connection::open_in_memory().expect("legacy backfill fixture");
        initialize_history_database(&mut database).expect("initialize legacy backfill fixture");
        let transaction = database
            .transaction()
            .expect("begin legacy backfill fixture");
        transaction
            .execute_batch(
                "CREATE TEMP TRIGGER inject_legacy_sql_failure
                 BEFORE INSERT ON clips BEGIN
                   SELECT RAISE(ABORT, 'injected legacy SQL failure');
                 END;",
            )
            .expect("install legacy SQL failure trigger");
        let legacy = LegacyData {
            rows: vec![LegacyRow {
                id: "legacy-sql".to_owned(),
                payload: serde_json::json!({
                    "id": "legacy-sql",
                    "content": "legacy body",
                    "copiedAt": "2026-07-01T00:00:00.000Z"
                })
                .to_string(),
                image_mime: None,
                image_data: None,
            }],
            source_icons: Vec::new(),
        };

        let failure = backfill_legacy_data(&transaction, legacy)
            .expect_err("injected legacy SQL failure must propagate");
        assert!(
            matches!(failure, HistoryInitializationFailure::Sqlite(_)),
            "legacy SQL failure was downgraded: {failure:?}"
        );
    }

    #[test]
    fn current_schema_initialization_does_not_require_a_writer_lock() {
        let path = temporary_database_path("read-only-init");
        let result = {
            let mut current = Connection::open(&path).expect("open current connection");
            initialize_history_database(&mut current).expect("initialize current schema");
            let lock = Connection::open(&path).expect("open lock connection");
            lock.execute_batch("BEGIN IMMEDIATE")
                .expect("hold writer lock");

            initialize_history_database(&mut current)
        };
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(format!("{}-wal", path.display()));
        let _ = fs::remove_file(format!("{}-shm", path.display()));

        result.expect("current schema initialization must stay read-only");
    }

    #[test]
    fn startup_rejects_incomplete_v7_schema_and_foreign_key_drift_without_quarantine() {
        for (case, damage_sql) in [
            ("missing-settings", "DROP TABLE history_settings;"),
            ("missing-clips", ""),
            ("missing-fts", "DROP TABLE clip_search_fts;"),
            (
                "broken-foreign-key",
                "PRAGMA foreign_keys = OFF;
                 INSERT INTO clip_files(
                   clip_id, ordinal, path, name, directory, exists_at_capture
                 ) VALUES ('missing-parent', 0, 'C:\\missing', 'missing', 0, 1);",
            ),
        ] {
            let directory = temporary_history_directory(&format!("v7-contract-{case}"));
            let live_path = directory.join("history.sqlite3");
            if case != "missing-clips" {
                create_closed_restore_fixture(&live_path, "valid-before-damage");
            }
            let damaged = Connection::open(&live_path).expect("open v7 contract fixture");
            if case == "missing-clips" {
                damaged
                    .pragma_update(None, "application_id", APPLICATION_ID)
                    .expect("set bare v7 application id");
                damaged
                    .pragma_update(None, "user_version", SCHEMA_VERSION)
                    .expect("set bare v7 schema header");
            }
            damaged
                .execute_batch(damage_sql)
                .unwrap_or_else(|error| panic!("damage v7 contract invariant {case}: {error}"));
            damaged
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")
                .expect("consolidate damaged v7 fixture");
            drop(damaged);

            let health = open_history_database_with_recovery(&directory)
                .expect_err("structurally incomplete v7 database must fail at startup");
            assert_eq!(
                serde_json::to_value(health).expect("serialize v7 contract health"),
                serde_json::json!({
                    "status": "readOnlyError",
                    "reason": "incompatible"
                }),
                "unexpected startup result for {case}"
            );
            assert!(live_path.is_file());
            assert!(!directory.join(HISTORY_RECOVERY_NOTICE_FILE).exists());
            assert_eq!(
                fs::read_dir(&directory)
                    .expect("list v7 contract fixture")
                    .filter_map(|entry| {
                        let entry = entry.ok()?;
                        entry.file_type().ok()?.is_dir().then_some(())
                    })
                    .count(),
                0,
                "contract drift must never quarantine {case}"
            );

            for path in [
                live_path.clone(),
                path_with_suffix(&live_path, "-wal"),
                path_with_suffix(&live_path, "-shm"),
            ] {
                if path.exists() {
                    fs::remove_file(path).expect("remove v7 contract fixture");
                }
            }
            fs::remove_dir(directory).expect("remove v7 contract directory");
        }
    }

    #[test]
    fn v02_json_history_migrates_to_normalized_tables_without_legacy_runtime_table() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        database
            .execute_batch(
                "CREATE TABLE clipboard_items (
                   position INTEGER NOT NULL,
                   id TEXT PRIMARY KEY NOT NULL,
                   payload TEXT NOT NULL,
                   image_mime TEXT,
                   image_data BLOB
                 );
                 CREATE TABLE source_app_icons (
                   source_app TEXT PRIMARY KEY NOT NULL,
                   icon_png BLOB NOT NULL
                 );",
            )
            .expect("create v0.2 schema");
        database
            .execute(
                "INSERT INTO clipboard_items(position, id, payload) VALUES (0, 'legacy', ?1)",
                [serde_json::json!({
                    "id": "legacy",
                    "kind": "text",
                    "title": "旧记录",
                    "content": "旧版本正文",
                    "sourceApp": "Legacy App",
                    "copiedAt": "2026-07-01T00:00:00.000Z",
                    "pinned": true,
                    "searchTerms": ["legacy"],
                    "omittedFormats": ["rtf", "html"]
                })
                .to_string()],
            )
            .expect("insert v0.2 row");

        initialize_history_database(&mut database).expect("migrate v0.2 database");

        assert_eq!(pragma_i64(&database, "user_version"), SCHEMA_VERSION);
        assert!(!table_exists(&database, "clipboard_items"));
        let loaded = load_history(&database).expect("load migrated history");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "legacy");
        assert_eq!(loaded[0].content, "旧版本正文");
        assert_eq!(loaded[0].source_app, "Legacy App");
        assert!(loaded[0].pinned);
        assert_eq!(
            loaded[0].omitted_formats,
            vec![ClipboardFormat::Html, ClipboardFormat::Rtf]
        );
    }

    #[test]
    fn failed_v02_migration_rolls_back_schema_and_legacy_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        database
            .execute_batch(
                "CREATE TABLE clipboard_items (
                   position INTEGER NOT NULL,
                   id TEXT PRIMARY KEY NOT NULL,
                   payload TEXT NOT NULL,
                   image_mime TEXT,
                   image_data BLOB
                 );
                 INSERT INTO clipboard_items(position, id, payload)
                   VALUES (0, 'broken', '{not json}');",
            )
            .expect("create broken v0.2 fixture");

        let error = initialize_history_database(&mut database).expect_err("migration must fail");

        assert!(
            error.contains("legacy"),
            "unexpected migration error: {error}"
        );
        assert_eq!(pragma_i64(&database, "user_version"), 0);
        assert!(table_exists(&database, "clipboard_items"));
        assert!(!table_exists(&database, "clips"));
        let legacy_rows: i64 = database
            .query_row("SELECT COUNT(*) FROM clipboard_items", [], |row| row.get(0))
            .expect("count legacy rows");
        assert_eq!(legacy_rows, 1);
    }

    #[test]
    fn mutation_upserts_and_deletes_only_the_requested_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let policy = CapacityPolicy::default();
        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("untouched", "2026-07-01T00:00:00.000Z")],
                policy.clone(),
            ),
        )
        .expect("insert untouched row");
        database
            .execute_batch(
                "CREATE TABLE clip_audit (changes INTEGER NOT NULL DEFAULT 0);
                 INSERT INTO clip_audit DEFAULT VALUES;
                 CREATE TRIGGER untouched_updated AFTER UPDATE ON clips
                 WHEN OLD.id = 'untouched'
                 BEGIN UPDATE clip_audit SET changes = changes + 1; END;
                 CREATE TRIGGER untouched_deleted AFTER DELETE ON clips
                 WHEN OLD.id = 'untouched'
                 BEGIN UPDATE clip_audit SET changes = changes + 1; END;",
            )
            .expect("track untouched row");

        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("new", "2026-07-02T00:00:00.000Z")],
                policy.clone(),
            ),
        )
        .expect("upsert one row");
        apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: Vec::new(),
                delete_ids: vec!["new".into()],
                policy,
            },
        )
        .expect("delete one row");

        let untouched_changes: i64 = database
            .query_row("SELECT changes FROM clip_audit", [], |row| row.get(0))
            .expect("read untouched change count");
        assert_eq!(untouched_changes, 0);
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clips WHERE id = 'untouched'",
                    [],
                    |row| { row.get::<_, i64>(0) }
                )
                .expect("untouched exists"),
            1
        );
        assert_eq!(
            database
                .query_row("SELECT COUNT(*) FROM clips WHERE id = 'new'", [], |row| {
                    row.get::<_, i64>(0)
                })
                .expect("new row removed"),
            0
        );
    }

    #[test]
    fn capacity_prunes_oldest_unprotected_rows_with_a_stable_id_tiebreaker() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let timestamp = "2026-07-01T00:00:00.000Z";
        let mut pinned = text_item("pinned", timestamp);
        pinned.pinned = true;
        let mut permanent = text_item("permanent", timestamp);
        permanent.permanent = true;
        let result = apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("clip-a", timestamp),
                    text_item("clip-b", timestamp),
                    text_item("clip-c", timestamp),
                    pinned,
                    permanent,
                ],
                CapacityPolicy {
                    max_records: 1,
                    max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
                    retention_days: None,
                },
            ),
        )
        .expect("apply deterministic count pruning");

        assert_eq!(result.pruned_ids, vec!["clip-a", "clip-b"]);

        let ids = load_history(&database)
            .expect("load retained rows")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert!(!ids.contains(&"clip-a".into()));
        assert!(!ids.contains(&"clip-b".into()));
        assert!(ids.contains(&"clip-c".into()));
        assert!(ids.contains(&"pinned".into()));
        assert!(ids.contains(&"permanent".into()));
    }

    #[test]
    fn capacity_prunes_oldest_unprotected_images_before_protected_images() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut pinned = image_item("pinned-image", "2026-07-01T00:00:00.000Z", b"123");
        pinned.pinned = true;
        let result = apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    image_item("image-old", "2026-07-01T00:00:00.000Z", b"123"),
                    image_item("image-middle", "2026-07-02T00:00:00.000Z", b"456"),
                    image_item("image-new", "2026-07-03T00:00:00.000Z", b"789"),
                    pinned,
                ],
                CapacityPolicy {
                    max_records: 100,
                    max_image_bytes: 6,
                    retention_days: None,
                },
            ),
        )
        .expect("apply image-byte pruning");

        assert_eq!(result.pruned_ids, vec!["image-middle", "image-old"]);

        let ids = load_history(&database)
            .expect("load retained rows")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert!(!ids.contains(&"image-old".into()));
        assert!(!ids.contains(&"image-middle".into()));
        assert!(ids.contains(&"image-new".into()));
        assert!(ids.contains(&"pinned-image".into()));
    }

    #[test]
    fn retention_cutoff_uses_canonical_utc_millisecond_timestamp() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-07-19T12:34:56.789123+08:00")
            .expect("parse deterministic current time")
            .with_timezone(&Utc);

        assert_eq!(retention_cutoff(now, 2), "2026-07-17T04:34:56.789Z");
    }

    #[test]
    fn capacity_retention_prunes_only_expired_unprotected_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut pinned = text_item("expired-pinned", "2000-01-01T00:00:00.000Z");
        pinned.pinned = true;
        let mut permanent = text_item("expired-permanent", "2000-01-01T00:00:00.000Z");
        permanent.permanent = true;
        let result = apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("expired", "2000-01-01T00:00:00.000Z"),
                    text_item("current", "2999-01-01T00:00:00.000Z"),
                    pinned,
                    permanent,
                ],
                CapacityPolicy {
                    max_records: 100,
                    max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
                    retention_days: Some(1),
                },
            ),
        )
        .expect("apply retention pruning");

        assert_eq!(result.pruned_ids, vec!["expired"]);

        let ids = load_history(&database)
            .expect("load retained rows")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert!(!ids.contains(&"expired".into()));
        assert!(ids.contains(&"current".into()));
        assert!(ids.contains(&"expired-pinned".into()));
        assert!(ids.contains(&"expired-permanent".into()));
    }

    #[test]
    fn capacity_result_is_deduplicated_and_sorted_across_pruning_stages() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut pinned = image_item("protected-pinned", "2000-01-01T00:00:00.000Z", b"1234");
        pinned.pinned = true;
        let mut permanent = text_item("protected-permanent", "2000-01-01T00:00:00.000Z");
        permanent.permanent = true;

        let result = apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("z-retention", "2000-01-01T00:00:00.000Z"),
                    text_item("a-count", "2999-01-01T00:00:00.000Z"),
                    image_item("m-image", "2999-01-02T00:00:00.000Z", b"1234"),
                    text_item("keep", "2999-01-03T00:00:00.000Z"),
                    pinned,
                    permanent,
                ],
                CapacityPolicy {
                    max_records: 2,
                    max_image_bytes: 4,
                    retention_days: Some(1),
                },
            ),
        )
        .expect("apply all pruning stages");

        assert_eq!(result.pruned_ids, vec!["a-count", "m-image", "z-retention"]);
        assert!(!result
            .pruned_ids
            .iter()
            .any(|id| id.starts_with("protected-")));
    }

    #[test]
    fn explicitly_deleted_ids_are_not_reported_as_capacity_pruned() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("explicit", "2026-07-01T00:00:00.000Z"),
                    text_item("capacity", "2026-07-02T00:00:00.000Z"),
                ],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed rows");

        let result = apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: Vec::new(),
                delete_ids: vec!["explicit".into()],
                policy: CapacityPolicy {
                    max_records: 0,
                    max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
                    retention_days: None,
                },
            },
        )
        .expect("delete explicit row and prune capacity row");

        assert_eq!(result.pruned_ids, vec!["capacity"]);
    }

    #[test]
    fn prune_failure_rolls_back_every_deletion_without_returning_a_result() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("prune-a", "2026-07-01T00:00:00.000Z"),
                    text_item("prune-b", "2026-07-02T00:00:00.000Z"),
                ],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed rows");
        database
            .execute_batch(
                "CREATE TRIGGER fail_second_capacity_delete BEFORE DELETE ON clips
                 WHEN OLD.id = 'prune-b'
                 BEGIN SELECT RAISE(ABORT, 'injected capacity failure'); END;",
            )
            .expect("install failure injection");

        let result: Result<HistoryMutationResult, String> = apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: Vec::new(),
                delete_ids: Vec::new(),
                policy: CapacityPolicy {
                    max_records: 0,
                    max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
                    retention_days: None,
                },
            },
        );

        assert!(result.is_err());
        assert!(get_clip_payload(&database, "prune-a")
            .expect("read first rolled-back row")
            .is_some());
        assert!(get_clip_payload(&database, "prune-b")
            .expect("read second rolled-back row")
            .is_some());
    }

    #[test]
    fn file_only_records_round_trip_in_ordinal_order_with_metadata() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut item = text_item("files", "2026-07-01T00:00:00.000Z");
        item.kind = "file".into();
        item.formats = vec!["files".into()];
        item.files = vec![
            ClipboardFile {
                path: r"C:\\first.txt".into(),
                name: "first.txt".into(),
                extension: Some("txt".into()),
                size: Some(12),
                modified_at: Some("2026-07-01T00:00:00.000Z".into()),
                directory: false,
                exists: true,
            },
            ClipboardFile {
                path: r"C:\\folder".into(),
                name: "folder".into(),
                extension: None,
                size: None,
                modified_at: None,
                directory: true,
                exists: false,
            },
        ];

        apply_history_mutation(
            &mut database,
            mutation(vec![item], CapacityPolicy::default()),
        )
        .expect("store file-only record");

        let loaded = get_clip_payload(&database, "files")
            .expect("load file record")
            .expect("file record exists");
        assert_eq!(loaded.formats, vec!["files"]);
        assert_eq!(loaded.files.len(), 2);
        assert_eq!(loaded.files[0].path, r"C:\\first.txt");
        assert_eq!(loaded.files[0].size, Some(12));
        assert!(loaded.files[1].directory);
        assert!(!loaded.files[1].exists);
    }

    #[test]
    fn current_frontend_items_without_v03_optional_fields_deserialize_and_normalize() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let item: HistoryItem = serde_json::from_value(serde_json::json!({
            "id": "current-frontend",
            "kind": "text",
            "title": "当前记录",
            "content": "正文",
            "sourceApp": "Notepad",
            "copiedAt": "2026-07-01T00:00:00.000Z",
            "pinned": false,
            "searchTerms": []
        }))
        .expect("deserialize current frontend item");

        apply_history_mutation(
            &mut database,
            mutation(vec![item], CapacityPolicy::default()),
        )
        .expect("store current frontend item");

        let loaded = get_clip_payload(&database, "current-frontend")
            .expect("load normalized item")
            .expect("item exists");
        assert!(!loaded.permanent);
        assert_eq!(loaded.updated_at, loaded.copied_at);
        assert!(loaded.omitted_formats.is_empty());
    }

    #[test]
    fn history_item_serde_canonicalizes_omitted_formats_and_uses_camel_case() {
        let mut item = text_item("serde", "2026-07-01T00:00:00.000Z");
        item.omitted_formats = vec![
            ClipboardFormat::Object,
            ClipboardFormat::Rtf,
            ClipboardFormat::Html,
        ];

        let value = serde_json::to_value(&item).expect("serialize history item");
        assert_eq!(
            value["omittedFormats"],
            serde_json::json!(["html", "rtf", "object"])
        );
        assert!(value.get("omitted_formats").is_none());

        let mut unsorted = value;
        unsorted["omittedFormats"] = serde_json::json!(["object", "rtf", "html"]);
        let decoded: HistoryItem =
            serde_json::from_value(unsorted).expect("deserialize known omitted formats");
        assert_eq!(
            decoded.omitted_formats,
            vec![
                ClipboardFormat::Html,
                ClipboardFormat::Rtf,
                ClipboardFormat::Object,
            ]
        );
    }

    #[test]
    fn history_item_deserialization_rejects_unknown_and_duplicate_omitted_formats() {
        let base = serde_json::to_value(text_item("strict", "2026-07-01T00:00:00.000Z"))
            .expect("serialize base item");
        for invalid in [
            serde_json::json!(["html", "html"]),
            serde_json::json!(["html", "markdown"]),
        ] {
            let mut value = base.clone();
            value["omittedFormats"] = invalid;
            assert!(serde_json::from_value::<HistoryItem>(value).is_err());
        }
    }

    #[test]
    fn full_and_summary_reads_round_trip_omitted_formats_without_creating_payload_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut item = text_item("omitted-round-trip", "2026-07-01T00:00:00.000Z");
        let logical_without_omitted = logical_bytes(&item).expect("measure base item");
        item.omitted_formats = vec![ClipboardFormat::Rtf, ClipboardFormat::Html];
        assert_eq!(
            logical_bytes(&item).expect("measure omitted metadata"),
            logical_without_omitted
        );

        apply_history_mutation(
            &mut database,
            mutation(vec![item], CapacityPolicy::default()),
        )
        .expect("store omitted metadata");

        let stored: String = database
            .query_row(
                "SELECT omitted_formats FROM clips WHERE id = 'omitted-round-trip'",
                [],
                |row| row.get(0),
            )
            .expect("read stored omitted metadata");
        assert_eq!(stored, r#"["html","rtf"]"#);
        let format_rows: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM clip_formats WHERE clip_id = 'omitted-round-trip'",
                [],
                |row| row.get(0),
            )
            .expect("count actual format rows");
        assert_eq!(format_rows, 1);

        let full = get_clip_payload(&database, "omitted-round-trip")
            .expect("load full payload")
            .expect("full payload exists");
        assert_eq!(
            full.omitted_formats,
            vec![ClipboardFormat::Html, ClipboardFormat::Rtf]
        );
        let loaded_history = load_history(&database).expect("load full history");
        assert_eq!(loaded_history.len(), 1);
        assert_eq!(loaded_history[0].omitted_formats, full.omitted_formats);
        let mut summary = query_history(&database, HistoryQuery::default())
            .expect("query summary")
            .items
            .pop()
            .expect("summary exists");
        assert_eq!(summary.omitted_formats, full.omitted_formats);

        summary.omitted_formats.clear();
        summary.title = "metadata update".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![summary], CapacityPolicy::default()),
        )
        .expect("update metadata summary");
        let after_summary = get_clip_payload(&database, "omitted-round-trip")
            .expect("reload full payload")
            .expect("payload remains");
        assert_eq!(after_summary.omitted_formats, full.omitted_formats);
    }

    #[test]
    fn full_mutations_reject_actual_and_omitted_format_overlap() {
        for (id, format, omitted) in [
            ("text-overlap", "text", ClipboardFormat::Text),
            ("html-overlap", "html", ClipboardFormat::Html),
        ] {
            let mut database = Connection::open_in_memory().expect("in-memory database");
            let mut item = text_item(id, "2026-07-01T00:00:00.000Z");
            if format == "html" {
                item.formats.push("html".into());
                item.html = Some("<b>HTML</b>".into());
            }
            item.omitted_formats = vec![omitted];

            assert!(apply_history_mutation(
                &mut database,
                mutation(vec![item], CapacityPolicy::default()),
            )
            .is_err());
        }
    }

    #[test]
    fn rich_formats_and_omitted_formats_load_in_canonical_order() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut item = text_item("ordered", "2026-07-01T00:00:00.000Z");
        item.formats = vec!["rtf".into(), "text".into(), "html".into()];
        item.html = Some("<b>HTML</b>".into());
        item.rtf_base64 = Some(STANDARD.encode(b"{\\rtf1 ordered}"));
        item.omitted_formats = vec![ClipboardFormat::Files, ClipboardFormat::Image];

        apply_history_mutation(
            &mut database,
            mutation(vec![item], CapacityPolicy::default()),
        )
        .expect("store ordered metadata");

        let loaded = get_clip_payload(&database, "ordered")
            .expect("load ordered payload")
            .expect("ordered payload exists");
        assert_eq!(loaded.formats, vec!["text", "html", "rtf"]);
        assert_eq!(
            loaded.omitted_formats,
            vec![ClipboardFormat::Image, ClipboardFormat::Files]
        );
    }

    #[test]
    fn malformed_persisted_omitted_formats_fail_full_and_summary_reads() {
        let invalid_values = [
            "not-json",
            r#"["markdown"]"#,
            r#"["html","html"]"#,
            r#"["rtf","html"]"#,
        ];
        for (index, invalid) in invalid_values.into_iter().enumerate() {
            let mut database = Connection::open_in_memory().expect("in-memory database");
            let id = format!("corrupt-{index}");
            apply_history_mutation(
                &mut database,
                mutation(
                    vec![text_item(&id, "2026-07-01T00:00:00.000Z")],
                    CapacityPolicy::default(),
                ),
            )
            .expect("seed valid payload");
            database
                .execute(
                    "UPDATE clips SET omitted_formats = ?2 WHERE id = ?1",
                    params![id, invalid],
                )
                .expect("corrupt omitted metadata");

            assert!(get_clip_payload(&database, &id).is_err());
            assert!(query_history(&database, HistoryQuery::default()).is_err());
        }
    }

    #[test]
    fn paged_query_returns_image_metadata_without_the_image_blob() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![image_item(
                    "query-image",
                    "2026-07-01T00:00:00.000Z",
                    b"image",
                )],
                CapacityPolicy::default(),
            ),
        )
        .expect("store image");

        let page = query_history(&database, HistoryQuery::default()).expect("query metadata");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].formats, vec!["image"]);
        assert_eq!(page.items[0].image_url, None);
        assert!(get_clip_payload(&database, "query-image")
            .expect("load payload")
            .expect("image exists")
            .image_url
            .is_some());
    }

    #[test]
    fn invalid_mutations_roll_back_requested_deletes_and_upserts() {
        let file = ClipboardFile {
            path: r"C:\\file.txt".into(),
            name: "file.txt".into(),
            extension: Some("txt".into()),
            size: Some(1),
            modified_at: None,
            directory: false,
            exists: true,
        };
        let mut missing_file = text_item("missing-file", "2026-07-01T00:00:00.000Z");
        missing_file.kind = "file".into();
        missing_file.formats = vec!["files".into()];
        let mut mixed_file = missing_file.clone();
        mixed_file.id = "mixed-file".into();
        mixed_file.formats = vec!["text".into(), "files".into()];
        mixed_file.files = vec![file.clone()];
        let mut text_with_file = text_item("text-file", "2026-07-01T00:00:00.000Z");
        text_with_file.files = vec![file];
        let mut smuggled_html = text_item("html", "2026-07-01T00:00:00.000Z");
        smuggled_html.html = Some("<b>html</b>".into());
        let mut smuggled_rtf = text_item("rtf", "2026-07-01T00:00:00.000Z");
        smuggled_rtf.rtf_base64 = Some(STANDARD.encode(b"rtf"));
        let mut smuggled_image = image_item("image", "2026-07-01T00:00:00.000Z", b"image");
        smuggled_image.formats = vec!["text".into()];
        let mut missing_html = text_item("missing-html", "2026-07-01T00:00:00.000Z");
        missing_html.formats = vec!["text".into(), "html".into()];
        let mut missing_rtf = text_item("missing-rtf", "2026-07-01T00:00:00.000Z");
        missing_rtf.formats = vec!["text".into(), "rtf".into()];
        let mut missing_image = text_item("missing-image", "2026-07-01T00:00:00.000Z");
        missing_image.kind = "image".into();
        missing_image.formats = vec!["image".into()];
        let mut duplicate_format = text_item("duplicate-format", "2026-07-01T00:00:00.000Z");
        duplicate_format.formats = vec!["text".into(), "text".into()];
        let mut invalid_ocr_status = text_item("invalid-ocr-status", "2026-07-01T00:00:00.000Z");
        invalid_ocr_status.ocr_status = Some("complete".into());

        for invalid in [
            missing_file,
            mixed_file,
            text_with_file,
            smuggled_html,
            smuggled_rtf,
            smuggled_image,
            missing_html,
            missing_rtf,
            missing_image,
            duplicate_format,
            invalid_ocr_status,
        ] {
            let mut database = Connection::open_in_memory().expect("in-memory database");
            apply_history_mutation(
                &mut database,
                mutation(
                    vec![text_item("untouched", "2026-07-01T00:00:00.000Z")],
                    CapacityPolicy::default(),
                ),
            )
            .expect("seed untouched row");

            assert!(apply_history_mutation(
                &mut database,
                HistoryMutation {
                    upserts: vec![invalid],
                    delete_ids: vec!["untouched".into()],
                    policy: CapacityPolicy::default(),
                },
            )
            .is_err());
            assert!(get_clip_payload(&database, "untouched")
                .expect("read after rollback")
                .is_some());
        }
    }

    #[test]
    fn oversized_inbound_payloads_are_rejected_without_partial_history_mutation() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize history");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("preserved", "2026-07-01T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed preserved row");

        let mut oversized_text = text_item("oversized-text", "2026-07-02T00:00:00.000Z");
        oversized_text.content = "x".repeat(crate::clipboard_formats::MAX_FORMAT_BYTES + 1);
        let rejected = apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: vec![oversized_text],
                delete_ids: vec!["preserved".into()],
                policy: CapacityPolicy::default(),
            },
        );
        assert!(rejected.is_err());
        assert!(get_clip_payload(&database, "preserved")
            .expect("query preserved row")
            .is_some());
        assert!(get_clip_payload(&database, "oversized-text")
            .expect("query rejected row")
            .is_none());

        let mut oversized_html = text_item("oversized-html", "2026-07-02T00:00:00.000Z");
        oversized_html.formats = vec!["text".into(), "html".into()];
        oversized_html.html = Some("x".repeat(crate::clipboard_formats::MAX_FORMAT_BYTES + 1));
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![oversized_html], CapacityPolicy::default()),
        )
        .is_err());

        let mut oversized_rtf = text_item("oversized-rtf", "2026-07-02T00:00:00.000Z");
        oversized_rtf.formats = vec!["text".into(), "rtf".into()];
        oversized_rtf.rtf_base64 =
            Some(STANDARD.encode(vec![0; crate::clipboard_formats::MAX_FORMAT_BYTES + 1]));
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![oversized_rtf], CapacityPolicy::default()),
        )
        .is_err());

        assert!(data_url_parts_with_limit("data:image/png;base64,AAAA", 3).is_ok());
        assert!(data_url_parts_with_limit("data:image/png;base64,AAAAAA==", 3).is_err());
        assert_eq!(HISTORY_IMAGE_BLOB_MAX_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn persisted_body_lengths_are_rejected_before_sqlite_copies_the_blob_or_text() {
        assert!(persisted_plain_text_length_is_safe(
            crate::clipboard_formats::MAX_FORMAT_BYTES as i64
        ));
        assert!(!persisted_plain_text_length_is_safe(
            crate::clipboard_formats::MAX_FORMAT_BYTES as i64 + 1
        ));
        assert!(persisted_format_blob_length_is_safe(
            "html",
            Some(crate::clipboard_formats::MAX_FORMAT_BYTES as i64)
        ));
        assert!(!persisted_format_blob_length_is_safe(
            "rtf",
            Some(crate::clipboard_formats::MAX_FORMAT_BYTES as i64 + 1)
        ));
        assert!(persisted_format_blob_length_is_safe(
            "image",
            Some(HISTORY_IMAGE_BLOB_MAX_BYTES as i64)
        ));
        assert!(!persisted_format_blob_length_is_safe(
            "image",
            Some(HISTORY_IMAGE_BLOB_MAX_BYTES as i64 + 1)
        ));
        assert!(!persisted_format_blob_length_is_safe("image", Some(-1)));
    }

    #[test]
    fn cursor_pages_are_stable_without_duplicates_or_skips() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("a", "2026-07-01T00:00:00.000Z"),
                    text_item("b", "2026-07-02T00:00:00.000Z"),
                    text_item("c", "2026-07-03T00:00:00.000Z"),
                    text_item("d", "2026-07-04T00:00:00.000Z"),
                    text_item("e", "2026-07-05T00:00:00.000Z"),
                ],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed pages");

        let first = query_history(
            &database,
            HistoryQuery {
                limit: 2,
                ..HistoryQuery::default()
            },
        )
        .expect("first page");
        let second = query_history(
            &database,
            HistoryQuery {
                limit: 2,
                cursor: first.next_cursor.clone(),
                ..HistoryQuery::default()
            },
        )
        .expect("second page");
        let third = query_history(
            &database,
            HistoryQuery {
                limit: 2,
                cursor: second.next_cursor.clone(),
                ..HistoryQuery::default()
            },
        )
        .expect("third page");
        let ids = [first.items, second.items, third.items]
            .into_iter()
            .flatten()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["e", "d", "c", "b", "a"]);
    }

    #[test]
    fn summary_updates_preserve_unloaded_payloads_and_reject_unknown_summary_ids() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut html = text_item("html", "2026-07-02T00:00:00.000Z");
        html.formats = vec!["text".into(), "html".into()];
        html.html = Some("<b>HTML</b>".into());
        let mut rtf = text_item("rtf", "2026-07-03T00:00:00.000Z");
        rtf.formats = vec!["text".into(), "rtf".into()];
        rtf.rtf_base64 = Some(STANDARD.encode(b"RTF"));
        apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    image_item("image", "2026-07-01T00:00:00.000Z", b"IMAGE"),
                    html,
                    rtf,
                ],
                CapacityPolicy::default(),
            ),
        )
        .expect("store payloads");

        let mut summaries = query_history(&database, HistoryQuery::default())
            .expect("load summaries")
            .items;
        assert!(summaries.iter().all(|item| !item.payload_loaded));
        for summary in &mut summaries {
            summary.title.push_str(" updated");
        }
        apply_history_mutation(
            &mut database,
            mutation(summaries, CapacityPolicy::default()),
        )
        .expect("update summaries");
        assert_eq!(
            get_clip_payload(&database, "image")
                .expect("image payload")
                .expect("image exists")
                .image_url
                .as_deref(),
            Some("data:image/png;base64,SU1BR0U=")
        );
        assert_eq!(
            get_clip_payload(&database, "html")
                .expect("html payload")
                .expect("html exists")
                .html
                .as_deref(),
            Some("<b>HTML</b>")
        );
        assert_eq!(
            get_clip_payload(&database, "rtf")
                .expect("rtf payload")
                .expect("rtf exists")
                .rtf_base64
                .as_deref(),
            Some(STANDARD.encode(b"RTF").as_str())
        );

        let mut unknown = text_item("unknown-summary", "2026-07-04T00:00:00.000Z");
        unknown.payload_loaded = false;
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![unknown], CapacityPolicy::default()),
        )
        .is_err());
    }

    #[test]
    fn summary_updates_recency_metadata_without_changing_payload_identity() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let original_icon = rgba_icon_data_url([12, 34, 56, 255]);
        let mut original = text_item("summary-identity", "2026-07-01T00:00:00.000Z");
        original.content = "original rich payload".into();
        original.source_app = "Original App".into();
        original.source_app_icon = Some(original_icon.clone());
        original.dimensions = Some("40x20".into());
        original.formats = vec!["text".into(), "html".into(), "rtf".into()];
        original.html = Some("<b>original HTML</b>".into());
        original.rtf_base64 = Some(STANDARD.encode(b"{\\rtf1 original RTF}"));
        apply_history_mutation(
            &mut database,
            mutation(vec![original], CapacityPolicy::default()),
        )
        .expect("store full payload");
        database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES ('updated-collection', 'Updated collection', ?1, ?1, 0)",
                ["2026-07-01T00:00:00.000Z"],
            )
            .expect("seed updated collection");
        let original_payload = get_clip_payload(&database, "summary-identity")
            .expect("load original payload")
            .expect("original exists");
        let original_logical_bytes = get_storage_stats(&database)
            .expect("read original stats")
            .logical_bytes;

        let mut summary = query_history(&database, HistoryQuery::default())
            .expect("load summary")
            .items
            .pop()
            .expect("summary exists");
        assert!(!summary.payload_loaded);
        assert_eq!(
            summary.source_app_icon.as_deref(),
            Some(original_icon.as_str())
        );
        // 前端只把可编辑摘要字段回传，来源图标属于只读查询元数据。
        summary.source_app_icon = None;
        summary.kind = "file".into();
        summary.content = "tampered payload body".into();
        summary.source_app = "Tampered App".into();
        summary.copied_at = "2026-08-10T00:00:00.000Z".into();
        summary.dimensions = Some("999x999".into());
        summary.formats = vec!["files".into()];
        summary.files = vec![ClipboardFile {
            path: "C:\\tampered.txt".into(),
            name: "tampered.txt".into(),
            extension: Some("txt".into()),
            size: Some(123),
            modified_at: Some("2026-07-10T00:00:00.000Z".into()),
            directory: false,
            exists: true,
        }];
        summary.title = "updated title".into();
        summary.pinned = true;
        summary.permanent = false;
        summary.collection_id = Some("updated-collection".into());
        summary.color = Some("#123456".into());
        summary.updated_at = "2026-07-10T08:09:10.987654+08:00".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![summary], CapacityPolicy::default()),
        )
        .expect("apply summary metadata update");

        let updated = get_clip_payload(&database, "summary-identity")
            .expect("load updated payload")
            .expect("updated exists");
        assert_eq!(updated.kind, original_payload.kind);
        assert_eq!(updated.content, original_payload.content);
        assert_eq!(updated.source_app, original_payload.source_app);
        assert_eq!(updated.source_app_icon, original_payload.source_app_icon);
        assert_eq!(updated.copied_at, "2026-08-10T00:00:00.000Z");
        assert_eq!(updated.dimensions, original_payload.dimensions);
        assert_eq!(updated.formats, original_payload.formats);
        assert!(updated.files.is_empty());
        assert!(original_payload.files.is_empty());
        assert_eq!(updated.html, original_payload.html);
        assert_eq!(updated.rtf_base64, original_payload.rtf_base64);
        assert_eq!(
            get_storage_stats(&database)
                .expect("read updated stats")
                .logical_bytes,
            original_logical_bytes
        );
        assert_eq!(updated.title, "updated title");
        assert!(updated.pinned);
        assert!(!updated.permanent);
        assert_eq!(updated.collection_id.as_deref(), Some("updated-collection"));
        assert_eq!(updated.search_terms, original_payload.search_terms);
        assert_eq!(updated.ocr_text, original_payload.ocr_text);
        assert_eq!(updated.ocr_status, original_payload.ocr_status);
        assert_eq!(updated.color.as_deref(), Some("#123456"));
        assert_eq!(updated.updated_at, "2026-07-10T00:09:10.987Z");
    }

    #[test]
    fn summary_upserts_cannot_overlap_requested_deletes() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![image_item("overlap", "2026-07-01T00:00:00.000Z", b"IMAGE")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed payload");
        let summary = query_history(&database, HistoryQuery::default())
            .expect("load summary")
            .items
            .pop()
            .expect("summary exists");

        assert!(apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: vec![summary],
                delete_ids: vec!["overlap".into()],
                policy: CapacityPolicy::default(),
            },
        )
        .is_err());
        assert!(get_clip_payload(&database, "overlap")
            .expect("read rollback")
            .is_some());
    }

    #[test]
    fn copied_timestamps_normalize_before_pruning_and_invalid_values_roll_back() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![
                    text_item("same-a", "2026-01-01T00:00:00+08:00"),
                    text_item("same-b", "2025-12-31T16:00:00.000000Z"),
                    text_item("new", "2026-01-02T00:00:00Z"),
                ],
                CapacityPolicy {
                    max_records: 2,
                    max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
                    retention_days: None,
                },
            ),
        )
        .expect("store normalized times");
        let ids = load_history(&database)
            .expect("load normalized times")
            .into_iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["new", "same-b"]);

        let invalid = text_item("invalid", "not-a-timestamp");
        assert!(apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: vec![invalid],
                delete_ids: vec!["new".into()],
                policy: CapacityPolicy::default(),
            },
        )
        .is_err());
        assert!(get_clip_payload(&database, "new")
            .expect("read rollback")
            .is_some());
    }

    #[test]
    fn storage_stats_report_exact_logical_categories_timestamps_and_policy() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut html = text_item("html-bytes", "2026-07-01T00:00:00.000Z");
        html.title = "H".into();
        html.content = "P".into();
        html.pinned = true;
        html.formats = vec!["text".into(), "html".into()];
        html.html = Some("HTML".into());
        let mut rtf = text_item("rtf-bytes", "2026-07-02T00:00:00.000Z");
        rtf.title = "R".into();
        rtf.content = "T".into();
        rtf.formats = vec!["text".into(), "rtf".into()];
        rtf.rtf_base64 = Some(STANDARD.encode(b"RTF"));
        let mut permanent = text_item("permanent-bytes", "2026-07-02T00:00:00.000Z");
        permanent.permanent = true;
        let mut image = image_item("image-bytes", "2026-07-03T00:00:00.000Z", b"IMAGE");
        image.title = "I".into();
        image.content = "M".into();
        let mut file = text_item("file-record", "2026-07-04T00:00:00.000Z");
        file.kind = "file".into();
        file.formats = vec!["files".into()];
        file.files = vec![ClipboardFile {
            path: r"C:\资料\报告.txt".into(),
            name: "报告.txt".into(),
            extension: Some("txt".into()),
            size: Some(42),
            modified_at: Some("2026-07-04T00:00:00.000Z".into()),
            directory: false,
            exists: true,
        }];
        let expected_logical = [&html, &rtf, &permanent, &image, &file]
            .into_iter()
            .map(|item| logical_bytes(item).expect("measure logical payload"))
            .sum::<i64>() as u64;
        let policy = CapacityPolicy {
            max_records: 88,
            max_image_bytes: 4_096,
            retention_days: Some(3_650),
        };
        apply_history_mutation(
            &mut database,
            mutation(vec![html, rtf, permanent, image, file], policy.clone()),
        )
        .expect("store known payload sizes");

        let stats = get_storage_stats(&database).expect("read stats");
        assert_eq!(stats.database_bytes, 0);
        assert_eq!(stats.wal_bytes, 0);
        assert_eq!(stats.shm_bytes, 0);
        assert_eq!(stats.total_physical_bytes, 0);
        assert_eq!(stats.record_count, 5);
        assert_eq!(stats.pinned_count, 1);
        assert_eq!(stats.permanent_count, 1);
        assert_eq!(stats.image_bytes, 5);
        assert_eq!(stats.rich_format_bytes, 7);
        assert_eq!(stats.file_record_count, 1);
        assert_eq!(stats.logical_bytes, expected_logical);
        assert_eq!(
            stats.oldest_copied_at.as_deref(),
            Some("2026-07-01T00:00:00.000Z")
        );
        assert_eq!(
            stats.newest_copied_at.as_deref(),
            Some("2026-07-04T00:00:00.000Z")
        );
        assert_eq!(stats.max_records, policy.max_records);
        assert_eq!(stats.max_image_bytes, policy.max_image_bytes);
        assert_eq!(stats.retention_days, policy.retention_days);
    }

    #[test]
    fn compact_returns_fresh_storage_stats_without_promising_a_decrease() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("compact", "2026-07-01T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed compact fixture");

        let compacted = compact_history_database(&database).expect("compact database");
        let sampled = get_storage_stats(&database).expect("sample after compact");
        assert_eq!(compacted, sampled);
        assert_eq!(compacted.record_count, 1);
    }

    #[test]
    fn physical_storage_stats_match_exact_database_wal_and_shm_lengths() {
        let path = temporary_database_path("physical-stats");
        let wal_path = path_with_suffix(&path, "-wal");
        let shm_path = path_with_suffix(&path, "-shm");
        let unrelated_path = path_with_suffix(&path, "-wal.unrelated");
        let observed = (|| -> Result<_, String> {
            let mut database = Connection::open(&path).map_err(|error| error.to_string())?;
            configure_history_database_connection(&database)?;
            initialize_history_database(&mut database)?;
            database
                .execute_batch("PRAGMA wal_autocheckpoint = 0")
                .map_err(|error| error.to_string())?;
            apply_history_mutation(
                &mut database,
                mutation(
                    vec![text_item("physical", "2026-07-01T00:00:00.000Z")],
                    CapacityPolicy::default(),
                ),
            )?;
            fs::write(&unrelated_path, b"must not be counted")
                .map_err(|error| error.to_string())?;
            let _ = get_storage_stats(&database)?;
            let expected_database = fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .len();
            let expected_wal = fs::metadata(&wal_path).map_or(0, |metadata| metadata.len());
            let expected_shm = fs::metadata(&shm_path).map_or(0, |metadata| metadata.len());
            let stats = get_storage_stats(&database)?;
            drop(database);
            Ok((stats, expected_database, expected_wal, expected_shm))
        })();

        for cleanup_path in [&path, &wal_path, &shm_path, &unrelated_path] {
            if cleanup_path.exists() {
                fs::remove_file(cleanup_path).expect("remove exact physical stats fixture");
            }
        }
        let (stats, expected_database, expected_wal, expected_shm) =
            observed.expect("sample physical storage fixture");
        assert_eq!(stats.database_bytes, expected_database);
        assert_eq!(stats.wal_bytes, expected_wal);
        assert_eq!(stats.shm_bytes, expected_shm);
        assert_eq!(
            stats.total_physical_bytes,
            expected_database + expected_wal + expected_shm
        );
        assert!(checked_physical_total(u64::MAX, 1, 0).is_err());
        assert!(checked_physical_total(1, u64::MAX, 1).is_err());
    }

    #[test]
    fn live_wal_rows_are_included_in_a_valid_sqlite_backup_snapshot() {
        let directory = temporary_history_directory("backup-wal");
        let live_path = directory.join("history.sqlite3");
        let backup_path = directory.join("QuickPaste-backup.sqlite3");
        let mut live = Connection::open(&live_path).expect("open live database");
        configure_history_database_connection(&live).expect("configure live database");
        initialize_history_database(&mut live).expect("initialize live database");
        live.execute_batch("PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("start empty live WAL");
        apply_history_mutation(
            &mut live,
            mutation(
                vec![text_item("wal-only", "2026-07-01T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("commit row into live WAL");
        assert!(
            fs::metadata(path_with_suffix(&live_path, "-wal"))
                .expect("live WAL exists")
                .len()
                > 0
        );

        create_history_backup_at(&live, &live_path, &backup_path).expect("create backup snapshot");
        let backup_header = fs::read(&backup_path).expect("read published backup header");
        assert!(backup_header.len() >= 100);
        assert_eq!(
            &backup_header[18..20],
            &[1_u8, 1_u8],
            "published backup must use standalone rollback-journal header"
        );
        assert!(!path_with_suffix(&backup_path, "-wal").exists());
        assert!(!path_with_suffix(&backup_path, "-shm").exists());
        let backup = Connection::open(&backup_path).expect("open backup snapshot");
        assert_eq!(pragma_i64(&backup, "application_id"), APPLICATION_ID);
        assert_eq!(pragma_i64(&backup, "user_version"), SCHEMA_VERSION);
        assert_eq!(
            backup
                .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .expect("quick-check backup"),
            "ok"
        );
        assert!(get_clip_payload(&backup, "wal-only")
            .expect("read backed-up WAL row")
            .is_some());
        drop(backup);
        drop(live);

        let leftovers = fs::read_dir(&directory)
            .expect("list backup fixture")
            .map(|entry| {
                entry
                    .expect("read backup entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert!(!leftovers.iter().any(|name| name.contains("quickpaste-tmp")));
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            backup_path.clone(),
            path_with_suffix(&backup_path, "-wal"),
            path_with_suffix(&backup_path, "-shm"),
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact backup fixture file");
            }
        }
        fs::remove_dir(directory).expect("remove empty backup fixture directory");
    }

    #[test]
    fn backup_failures_preserve_existing_destination_and_clean_only_owned_temporary() {
        let directory = temporary_history_directory("backup-failures");
        let live_path = directory.join("history.sqlite3");
        let destination = directory.join("existing.sqlite3");
        let unrelated = directory.join("existing.sqlite3.quickpaste-tmp-unrelated.sqlite3");
        let mut live = Connection::open(&live_path).expect("open live database");
        configure_history_database_connection(&live).expect("configure live database");
        initialize_history_database(&mut live).expect("initialize live database");
        apply_history_mutation(
            &mut live,
            mutation(
                vec![text_item("backup", "2026-07-01T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed live database");
        fs::write(&destination, b"original destination").expect("seed existing destination");
        fs::write(&unrelated, b"unrelated").expect("seed unrelated sibling");

        let validation_temporary = std::cell::RefCell::new(None::<PathBuf>);
        assert!(create_history_backup_with(
            &live,
            &live_path,
            &destination,
            |temporary| {
                validation_temporary.replace(Some(temporary.to_path_buf()));
                Err("injected validation failure".into())
            },
            |_, _| panic!("publish must not run after validation failure"),
        )
        .is_err());
        let validation_temporary = validation_temporary
            .into_inner()
            .expect("validation saw owned temporary");
        for owned_path in [
            validation_temporary.clone(),
            path_with_suffix(&validation_temporary, "-wal"),
            path_with_suffix(&validation_temporary, "-shm"),
            path_with_suffix(&validation_temporary, "-journal"),
        ] {
            assert!(!owned_path.exists(), "owned validation temporary survived");
        }
        assert_eq!(
            fs::read(&destination).expect("read destination after validation failure"),
            b"original destination"
        );
        assert_eq!(
            fs::read(&unrelated).expect("read unrelated file"),
            b"unrelated"
        );

        let publish_temporary = std::cell::RefCell::new(None::<PathBuf>);
        assert!(create_history_backup_with(
            &live,
            &live_path,
            &destination,
            validate_current_history_snapshot,
            |temporary, selected_destination| {
                assert_eq!(selected_destination, destination);
                publish_temporary.replace(Some(temporary.to_path_buf()));
                Err("injected publish failure".into())
            },
        )
        .is_err());
        let publish_temporary = publish_temporary
            .into_inner()
            .expect("publisher saw owned temporary");
        for owned_path in [
            publish_temporary.clone(),
            path_with_suffix(&publish_temporary, "-wal"),
            path_with_suffix(&publish_temporary, "-shm"),
            path_with_suffix(&publish_temporary, "-journal"),
        ] {
            assert!(!owned_path.exists(), "owned publish temporary survived");
        }
        assert_eq!(
            fs::read(&destination).expect("read destination after publish failure"),
            b"original destination"
        );
        assert_eq!(
            fs::read(&unrelated).expect("read unrelated file"),
            b"unrelated"
        );
        drop(live);

        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            destination,
            unrelated,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact failed backup fixture");
            }
        }
        fs::remove_dir(directory).expect("remove empty failed backup directory");
    }

    #[test]
    fn backup_api_failure_and_cleanup_failure_are_explicit_before_destination_publish() {
        let directory = temporary_history_directory("backup-step-failure");
        let live_path = directory.join("history.sqlite3");
        let destination = directory.join("existing.sqlite3");
        let mut live = Connection::open(&live_path).expect("open backup failure live database");
        configure_history_database_connection(&live).expect("configure backup failure live");
        initialize_history_database(&mut live).expect("initialize backup failure live");
        fs::write(&destination, b"original destination").expect("seed backup destination");

        let backup_temporary = std::cell::RefCell::new(None::<PathBuf>);
        let error = create_history_backup_with_steps(
            &live,
            &live_path,
            &destination,
            |_, temporary| {
                backup_temporary.replace(Some(temporary.to_path_buf()));
                Err("injected SQLite backup failure".to_owned())
            },
            |_| panic!("validation must not run after backup API failure"),
            |_, _| panic!("publish must not run after backup API failure"),
            |path| fs::remove_file(path),
        )
        .expect_err("backup API failure must surface");
        assert!(error.contains("injected SQLite backup failure"));
        let backup_temporary = backup_temporary
            .into_inner()
            .expect("backup step observed owned temporary");
        assert!(!backup_temporary.exists());
        assert_eq!(
            fs::read(&destination).expect("read preserved destination"),
            b"original destination"
        );

        let cleanup_temporary = std::cell::RefCell::new(None::<PathBuf>);
        let cleanup_error = create_history_backup_with_steps(
            &live,
            &live_path,
            &destination,
            |source, temporary| {
                source
                    .backup(rusqlite::MAIN_DB, temporary, None)
                    .map_err(|error| error.to_string())
            },
            |temporary| {
                cleanup_temporary.replace(Some(temporary.to_path_buf()));
                Err("injected validation failure".to_owned())
            },
            |_, _| panic!("publish must not run after validation failure"),
            |path| {
                if cleanup_temporary.borrow().as_deref() == Some(path) {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected cleanup denial",
                    ))
                } else {
                    fs::remove_file(path)
                }
            },
        )
        .expect_err("cleanup failure must be reported");
        assert_eq!(cleanup_error, "历史备份失败，且无法清理临时文件");
        assert_eq!(
            fs::read(&destination).expect("read unchanged destination"),
            b"original destination"
        );
        let cleanup_temporary = cleanup_temporary
            .into_inner()
            .expect("validation observed cleanup temporary");
        assert!(
            !cleanup_temporary.exists(),
            "Drop fallback should retry exact cleanup"
        );

        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            destination,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact backup failure fixture");
            }
        }
        fs::remove_dir(directory).expect("remove empty backup failure directory");
    }

    #[test]
    fn existing_backup_destination_is_resolved_before_protected_path_comparison() {
        let directory = temporary_history_directory("backup-alias");
        let live_path = directory.join("history.sqlite3");
        let destination = directory.join("selected.sqlite3");
        fs::write(&live_path, b"live").expect("seed live path");
        fs::write(&destination, b"selected").expect("seed selected path");
        let live_canonical = fs::canonicalize(&live_path).expect("canonical live path");

        let result = validate_backup_destination_with(&live_path, &destination, |path| {
            if path == destination {
                Ok(live_canonical.clone())
            } else {
                fs::canonicalize(path)
            }
        });
        assert!(result.is_err());

        fs::remove_file(live_path).expect("remove live alias fixture");
        fs::remove_file(destination).expect("remove destination alias fixture");
        fs::remove_dir(directory).expect("remove empty alias fixture directory");
    }

    #[test]
    fn backup_round_trip_preserves_every_history_payload_and_search_projection() {
        let directory = temporary_history_directory("backup-round-trip");
        let live_path = directory.join("history.sqlite3");
        let backup_path = directory.join("round-trip.sqlite3");
        let mut live = Connection::open(&live_path).expect("open round-trip live database");
        configure_history_database_connection(&live).expect("configure round-trip live database");
        initialize_history_database(&mut live).expect("initialize round-trip live database");
        live.execute(
            "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
             VALUES ('work', '工作', '2026-07-01T00:00:00.000Z',
                     '2026-07-01T00:00:00.000Z', 1)",
            [],
        )
        .expect("seed backed-up collection");

        let mut rich = text_item("rich-backup", "2026-07-03T00:00:00.000Z");
        rich.title = "火箭计划".into();
        rich.content = "Rich plain text".into();
        rich.source_app = "Word".into();
        rich.source_app_icon = Some(rgba_icon_data_url([77, 111, 206, 255]));
        rich.formats = vec!["text".into(), "html".into(), "rtf".into()];
        rich.html = Some("<b>Rich HTML</b>".into());
        rich.rtf_base64 = Some(STANDARD.encode(b"{\\rtf1 Rich RTF}"));
        rich.omitted_formats = vec![ClipboardFormat::Image, ClipboardFormat::Files];
        rich.search_terms = vec!["huojian".into(), "hj".into()];
        rich.collection_id = Some("work".into());
        let mut snippet = text_item("snippet-backup", "2026-07-04T00:00:00.000Z");
        snippet.title = "永久片段".into();
        snippet.content = "Reusable plain text".into();
        snippet.collection_id = Some("work".into());
        snippet.permanent = true;

        let mut file = text_item("file-backup", "2026-07-02T00:00:00.000Z");
        file.kind = "file".into();
        file.title = "季度文件".into();
        file.formats = vec!["files".into()];
        file.search_terms.clear();
        file.files = vec![ClipboardFile {
            path: r"C:\资料\季度报表.xlsx".into(),
            name: "季度报表.xlsx".into(),
            extension: Some("xlsx".into()),
            size: Some(42),
            modified_at: Some("2026-07-02T00:00:00.000Z".into()),
            directory: false,
            exists: true,
        }];

        let image_png = rgba_png_bytes([45, 90, 135, 255]);
        let mut image = image_item("image-backup", "2026-07-01T00:00:00.000Z", &image_png);
        image.image_hash = Some("b".repeat(64));
        image.ocr_text = Some("OCR searchable receipt".into());
        image.ocr_status = Some("completed".into());
        let policy = CapacityPolicy {
            max_records: 321,
            max_image_bytes: 12_345,
            retention_days: Some(90),
        };
        apply_history_mutation(
            &mut live,
            mutation(vec![rich, file, image, snippet], policy.clone()),
        )
        .expect("seed all backup payloads");
        let expected_history =
            serde_json::to_value(load_history(&live).expect("load live history"))
                .expect("serialize live history");
        let expected_collections: Vec<(String, String, i64)> = live
            .prepare("SELECT id, name, sort_order FROM collections ORDER BY id")
            .expect("prepare live collection query")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query live collections")
            .collect::<Result<_, _>>()
            .expect("collect live collections");
        let expected_thumbnail: Vec<u8> = live
            .query_row(
                "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = 'image-backup'",
                [],
                |row| row.get(0),
            )
            .expect("read live backup thumbnail");

        create_history_backup_at(&live, &live_path, &backup_path)
            .expect("create complete round-trip backup");
        let backup = Connection::open(&backup_path).expect("open round-trip backup");
        let backed_history =
            serde_json::to_value(load_history(&backup).expect("load backup history"))
                .expect("serialize backup history");
        assert_eq!(backed_history, expected_history);
        let backed_collections: Vec<(String, String, i64)> = backup
            .prepare("SELECT id, name, sort_order FROM collections ORDER BY id")
            .expect("prepare backup collection query")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .expect("query backup collections")
            .collect::<Result<_, _>>()
            .expect("collect backup collections");
        assert_eq!(backed_collections, expected_collections);
        assert_eq!(
            backup
                .query_row(
                    "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = 'image-backup'",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .expect("read backed-up thumbnail"),
            expected_thumbnail
        );
        for (query, expected_id) in [
            ("huojian", "rich-backup"),
            ("receipt", "image-backup"),
            ("季度报表", "file-backup"),
        ] {
            assert_eq!(query_ids(&backup, history_query(query)), vec![expected_id]);
        }
        let backup_stats = get_storage_stats(&backup).expect("read backup settings and stats");
        assert_eq!(backup_stats.record_count, 4);
        assert_eq!(backup_stats.max_records, policy.max_records);
        assert_eq!(backup_stats.max_image_bytes, policy.max_image_bytes);
        assert_eq!(backup_stats.retention_days, policy.retention_days);
        assert_eq!(
            backup
                .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .expect("quick-check complete backup"),
            "ok"
        );
        drop(backup);
        drop(live);

        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            backup_path.clone(),
            path_with_suffix(&backup_path, "-wal"),
            path_with_suffix(&backup_path, "-shm"),
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact round-trip backup fixture");
            }
        }
        fs::remove_dir(directory).expect("remove empty round-trip backup directory");
    }

    #[test]
    fn restore_prepare_never_changes_published_backup_directory_or_requires_source_writes() {
        fn directory_bytes(path: &Path) -> BTreeMap<String, Vec<u8>> {
            fs::read_dir(path)
                .expect("list source directory")
                .map(|entry| {
                    let entry = entry.expect("read source directory entry");
                    (
                        entry.file_name().to_string_lossy().into_owned(),
                        fs::read(entry.path()).expect("read source directory file"),
                    )
                })
                .collect()
        }

        let directory = temporary_history_directory("restore-source-immutable");
        let source_directory = directory.join("selected-backup-directory");
        let staging_directory = directory.join("staging");
        fs::create_dir(&source_directory).expect("create selected backup directory");
        fs::create_dir(&staging_directory).expect("create restore staging directory");
        let live_path = directory.join("live.sqlite3");
        let backup_path = source_directory.join("QuickPaste-backup.sqlite3");
        let mut live = Connection::open(&live_path).expect("open immutable-source live database");
        configure_history_database_connection(&live).expect("configure immutable-source live");
        initialize_history_database(&mut live).expect("initialize immutable-source live");
        live.execute_batch("PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("start immutable-source WAL fixture");
        apply_history_mutation(
            &mut live,
            mutation(
                vec![text_item("immutable-source", "2026-07-01T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed immutable-source WAL row");
        create_history_backup_at(&live, &live_path, &backup_path)
            .expect("publish immutable restore source");
        let original_permissions = fs::metadata(&backup_path)
            .expect("read backup permissions")
            .permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&backup_path, permissions).expect("make selected source read-only");
        let before = directory_bytes(&source_directory);

        let prepared =
            prepare_history_restore_at(&backup_path, &staging_directory, &live, &"d".repeat(64))
                .expect("prepare restore from read-only standalone source");
        assert_eq!(before, directory_bytes(&source_directory));
        let staged =
            Connection::open(&prepared.staging.path).expect("open immutable-source staging");
        assert!(get_clip_payload(&staged, "immutable-source")
            .expect("read immutable-source staged payload")
            .is_some());
        drop(staged);
        drop(prepared);

        fs::set_permissions(&backup_path, original_permissions)
            .expect("restore cleanup permissions");
        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            backup_path,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove immutable-source fixture");
            }
        }
        fs::remove_dir(source_directory).expect("remove selected backup directory");
        fs::remove_dir(staging_directory).expect("remove restore staging directory");
        fs::remove_dir(directory).expect("remove immutable-source directory");
    }

    #[test]
    fn restore_prepare_rejects_bad_sources_before_live_mutation_and_cleans_exact_staging() {
        let directory = temporary_history_directory("restore-reject");
        let staging_directory = directory.join("staging");
        fs::create_dir(&staging_directory).expect("create restore staging directory");
        let live_path = directory.join("live.sqlite3");
        let mut live = Connection::open(&live_path).expect("open restore live database");
        configure_history_database_connection(&live).expect("configure restore live database");
        initialize_history_database(&mut live).expect("initialize restore live database");
        apply_history_mutation(
            &mut live,
            mutation(
                vec![text_item("secret-current", "2026-07-02T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed current history");
        let before = serde_json::to_value(load_history(&live).expect("load current history"))
            .expect("serialize current history");

        let valid = directory.join("valid.sqlite3");
        create_closed_restore_fixture(&valid, "incoming");

        let truncated = directory.join("truncated.sqlite3");
        let valid_bytes = fs::read(&valid).expect("read valid source bytes");
        fs::write(&truncated, &valid_bytes[..valid_bytes.len() / 2])
            .expect("write truncated source");

        let random = directory.join("random.sqlite3");
        fs::write(&random, b"this is not a sqlite database").expect("write random source");

        let wrong_id = directory.join("wrong-id.sqlite3");
        fs::copy(&valid, &wrong_id).expect("copy wrong-id fixture");
        Connection::open(&wrong_id)
            .expect("open wrong-id fixture")
            .pragma_update(None, "application_id", APPLICATION_ID + 1)
            .expect("set wrong application id");

        let future = directory.join("future.sqlite3");
        fs::copy(&valid, &future).expect("copy future fixture");
        Connection::open(&future)
            .expect("open future fixture")
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("set future schema version");

        let corrupt = directory.join("corrupt.sqlite3");
        let mut corrupt_bytes = valid_bytes.clone();
        corrupt_bytes[100] = 0xff;
        fs::write(&corrupt, corrupt_bytes).expect("write corrupt sqlite source");

        let invalid_row = directory.join("invalid-row.sqlite3");
        fs::copy(&valid, &invalid_row).expect("copy invalid-row fixture");
        Connection::open(&invalid_row)
            .expect("open invalid-row fixture")
            .execute("UPDATE clips SET search_terms = 'not-json'", [])
            .expect("inject invalid runtime row");

        let invalid_collection = directory.join("invalid-collection.sqlite3");
        fs::copy(&valid, &invalid_collection).expect("copy invalid-collection fixture");
        let invalid_collection_database =
            Connection::open(&invalid_collection).expect("open invalid-collection fixture");
        invalid_collection_database
            .execute_batch(
                "DROP TRIGGER collections_validate_insert;
                 DROP TRIGGER collections_validate_update;
                 DROP INDEX collections_name_binary;
                 DROP INDEX collections_sort_order_id;
                 PRAGMA user_version = 7;",
            )
            .expect("downgrade invalid collection fixture to v7");
        invalid_collection_database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES (' padded-id ', ' ', 'not-a-timestamp',
                         '2026-07-01T00:00:00.000Z', 9007199254740992)",
                [],
            )
            .expect("inject invalid collection row");
        drop(invalid_collection_database);

        let missing = directory.join("missing.sqlite3");
        for (ordinal, source) in [
            &missing,
            &truncated,
            &random,
            &wrong_id,
            &future,
            &corrupt,
            &invalid_row,
            &invalid_collection,
        ]
        .into_iter()
        .enumerate()
        {
            let error = prepare_history_restore_at(
                source,
                &staging_directory,
                &live,
                &format!("{ordinal:064x}"),
            )
            .expect_err("bad restore source must be rejected")
            .into_message();
            assert!(!error.contains("secret-current"));
            assert_eq!(
                serde_json::to_value(load_history(&live).expect("reload unchanged live history"))
                    .expect("serialize unchanged live history"),
                before
            );
            assert_eq!(
                fs::read_dir(&staging_directory)
                    .expect("list exact staging directory")
                    .count(),
                0,
                "failed prepare left an owned staging artifact"
            );
        }

        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            valid,
            truncated,
            random,
            wrong_id,
            future,
            corrupt,
            invalid_row,
            invalid_collection,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact restore rejection fixture");
            }
        }
        fs::remove_dir(staging_directory).expect("remove empty staging directory");
        fs::remove_dir(directory).expect("remove empty restore rejection directory");
    }

    #[test]
    fn restore_policy_accepts_js_safe_maximum_and_rejects_each_maximum_plus_one() {
        const JS_MAX: i64 = 9_007_199_254_740_991;
        let directory = temporary_history_directory("restore-safe-policy");
        let staging_directory = directory.join("staging");
        fs::create_dir(&staging_directory).expect("create safe-policy staging");
        let live_path = directory.join("live.sqlite3");
        let mut live = Connection::open(&live_path).expect("open safe-policy live");
        configure_history_database_connection(&live).expect("configure safe-policy live");
        initialize_history_database(&mut live).expect("initialize safe-policy live");
        let valid_path = directory.join("valid-safe-policy.sqlite3");
        create_closed_restore_fixture(&valid_path, "safe-policy");
        Connection::open(&valid_path)
            .expect("open valid safe-policy source")
            .execute(
                "UPDATE history_settings
                 SET max_records = ?1, max_image_bytes = ?1, retention_days = ?2",
                params![JS_MAX, MAX_RETENTION_DAYS],
            )
            .expect("set JS safe maximum policy");
        let prepared =
            prepare_history_restore_at(&valid_path, &staging_directory, &live, &"1".repeat(64))
                .expect("JS safe maximum policy must remain valid");
        drop(prepared);

        let mut unsafe_paths = Vec::new();
        for (ordinal, column) in ["max_records", "max_image_bytes", "retention_days"]
            .into_iter()
            .enumerate()
        {
            let path = directory.join(format!("unsafe-{column}.sqlite3"));
            fs::copy(&valid_path, &path).expect("copy unsafe policy fixture");
            Connection::open(&path)
                .expect("open unsafe policy fixture")
                .execute(
                    &format!("UPDATE history_settings SET {column} = ?1"),
                    [JS_MAX + 1],
                )
                .expect("set unsafe policy value");
            assert!(prepare_history_restore_at(
                &path,
                &staging_directory,
                &live,
                &format!("{:064x}", ordinal + 2),
            )
            .is_err());
            unsafe_paths.push(path);
        }
        assert_eq!(
            fs::read_dir(&staging_directory)
                .expect("list safe-policy staging")
                .count(),
            0
        );

        drop(live);
        unsafe_paths.push(valid_path);
        for path in unsafe_paths.into_iter().chain([
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
        ]) {
            if path.exists() {
                fs::remove_file(path).expect("remove exact safe-policy fixture");
            }
        }
        fs::remove_dir(staging_directory).expect("remove empty safe-policy staging");
        fs::remove_dir(directory).expect("remove empty safe-policy directory");
    }

    #[test]
    fn mutation_rejects_renderer_bound_policy_and_file_sizes_above_js_safe_integer() {
        let mut database = Connection::open_in_memory().expect("open safe mutation database");
        initialize_history_database(&mut database).expect("initialize safe mutation database");
        let safe_policy = CapacityPolicy {
            max_records: JS_MAX_SAFE_INTEGER_U64,
            max_image_bytes: JS_MAX_SAFE_INTEGER_U64,
            retention_days: Some(MAX_RETENTION_DAYS),
        };
        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("safe-policy", "2026-07-01T00:00:00.000Z")],
                safe_policy.clone(),
            ),
        )
        .expect("JS safe maximum mutation policy");
        let revision_before: i64 = database
            .query_row("SELECT revision FROM history_settings", [], |row| {
                row.get(0)
            })
            .expect("read revision before unsafe mutations");
        for policy in [
            CapacityPolicy {
                max_records: JS_MAX_SAFE_INTEGER_U64 + 1,
                ..safe_policy.clone()
            },
            CapacityPolicy {
                max_image_bytes: JS_MAX_SAFE_INTEGER_U64 + 1,
                ..safe_policy.clone()
            },
            CapacityPolicy {
                retention_days: Some(JS_MAX_SAFE_INTEGER_I64 + 1),
                ..safe_policy.clone()
            },
        ] {
            assert!(apply_history_mutation(&mut database, mutation(Vec::new(), policy),).is_err());
        }
        assert_eq!(
            database
                .query_row("SELECT revision FROM history_settings", [], |row| row
                    .get::<_, i64>(0))
                .expect("read unchanged revision"),
            revision_before
        );

        let mut safe_file = text_item("safe-file", "2026-07-02T00:00:00.000Z");
        safe_file.kind = "file".into();
        safe_file.formats = vec!["files".into()];
        safe_file.files = vec![ClipboardFile {
            path: r"C:\safe.bin".into(),
            name: "safe.bin".into(),
            extension: Some("bin".into()),
            size: Some(JS_MAX_SAFE_INTEGER_U64),
            modified_at: None,
            directory: false,
            exists: true,
        }];
        apply_history_mutation(
            &mut database,
            mutation(vec![safe_file.clone()], safe_policy.clone()),
        )
        .expect("JS safe maximum file size");
        safe_file.id = "unsafe-file".into();
        safe_file.files[0].size = Some(JS_MAX_SAFE_INTEGER_U64 + 1);
        assert!(
            apply_history_mutation(&mut database, mutation(vec![safe_file], safe_policy),).is_err()
        );
        assert!(get_clip_payload(&database, "unsafe-file")
            .expect("query rejected unsafe file")
            .is_none());
    }

    #[test]
    fn restore_prepare_uses_owned_snapshot_for_live_wal_and_migrates_old_schema_in_isolation() {
        let directory = temporary_history_directory("restore-prepare");
        let staging_directory = directory.join("staging");
        fs::create_dir(&staging_directory).expect("create staging directory");
        let live_path = directory.join("live.sqlite3");
        let mut live = Connection::open(&live_path).expect("open restore live");
        configure_history_database_connection(&live).expect("configure restore live");
        initialize_history_database(&mut live).expect("initialize restore live");

        let source_path = directory.join("source.sqlite3");
        let mut source = Connection::open(&source_path).expect("open live WAL restore source");
        configure_history_database_connection(&source).expect("configure live WAL source");
        initialize_history_database(&mut source).expect("initialize live WAL source");
        source
            .execute_batch("PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("start source WAL fixture");
        apply_history_mutation(
            &mut source,
            mutation(
                vec![text_item("wal-restore", "2026-07-03T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("write source row only committed through WAL");
        assert!(
            fs::metadata(path_with_suffix(&source_path, "-wal"))
                .expect("source WAL exists")
                .len()
                > 0
        );
        let source_before = [
            source_path.clone(),
            path_with_suffix(&source_path, "-wal"),
            path_with_suffix(&source_path, "-shm"),
        ]
        .into_iter()
        .map(|path| {
            (
                path.file_name()
                    .expect("source fixture file name")
                    .to_string_lossy()
                    .into_owned(),
                fs::read(path).expect("read source fixture before prepare"),
            )
        })
        .collect::<BTreeMap<_, _>>();
        let prepared =
            prepare_history_restore_at(&source_path, &staging_directory, &live, &"a".repeat(64))
                .expect("prepare consistent WAL snapshot");
        let source_after = [
            source_path.clone(),
            path_with_suffix(&source_path, "-wal"),
            path_with_suffix(&source_path, "-shm"),
        ]
        .into_iter()
        .map(|path| {
            (
                path.file_name()
                    .expect("source fixture file name")
                    .to_string_lossy()
                    .into_owned(),
                fs::read(path).expect("read source fixture after prepare"),
            )
        })
        .collect::<BTreeMap<_, _>>();
        assert_eq!(source_after, source_before);
        let staged = Connection::open(&prepared.staging.path).expect("open staged WAL snapshot");
        assert!(get_clip_payload(&staged, "wal-restore")
            .expect("read WAL row from staging")
            .is_some());
        drop(staged);
        drop(prepared);

        let old_path = directory.join("old-v6.sqlite3");
        create_closed_restore_fixture(&old_path, "old-schema");
        let old = Connection::open(&old_path).expect("open old schema fixture");
        old.execute_batch(
            "DROP TABLE clip_thumbnails;
             DROP TRIGGER collections_validate_insert;
             DROP TRIGGER collections_validate_update;
             DROP INDEX collections_name_binary;
             DROP INDEX collections_sort_order_id;
             DROP TABLE history_settings;
             DROP INDEX clips_image_hash_ocr;
             ALTER TABLE clips DROP COLUMN image_hash;
             PRAGMA user_version = 6;",
        )
        .expect("downgrade fixture to supported v6");
        drop(old);
        let prepared =
            prepare_history_restore_at(&old_path, &staging_directory, &live, &"b".repeat(64))
                .expect("migrate supported source in staging");
        assert_eq!(prepared.schema_version, SCHEMA_VERSION);
        let staged = Connection::open(&prepared.staging.path).expect("open migrated staging");
        assert_eq!(pragma_i64(&staged, "user_version"), SCHEMA_VERSION);
        assert!(table_exists(&staged, "history_settings"));
        assert_eq!(
            pragma_i64(
                &Connection::open(&old_path).expect("reopen old source"),
                "user_version"
            ),
            6
        );
        drop(staged);
        drop(prepared);

        drop(source);
        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            source_path.clone(),
            path_with_suffix(&source_path, "-wal"),
            path_with_suffix(&source_path, "-shm"),
            old_path,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact prepare fixture");
            }
        }
        assert_eq!(
            fs::read_dir(&staging_directory)
                .expect("list staging")
                .count(),
            0
        );
        fs::remove_dir(staging_directory).expect("remove empty staging directory");
        fs::remove_dir(directory).expect("remove empty prepare directory");
    }

    #[test]
    fn restore_commit_is_atomic_rechecks_revision_and_rebuilds_search_from_payload() {
        let directory = temporary_history_directory("restore-commit");
        let staging_directory = directory.join("staging");
        fs::create_dir(&staging_directory).expect("create staging directory");
        let live_path = directory.join("live.sqlite3");
        let mut live = Connection::open(&live_path).expect("open live restore target");
        configure_history_database_connection(&live).expect("configure live restore target");
        initialize_history_database(&mut live).expect("initialize live restore target");
        apply_history_mutation(
            &mut live,
            mutation(
                vec![text_item("original-live", "2026-07-01T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("seed live restore target");

        let source_path = directory.join("incoming.sqlite3");
        create_closed_restore_fixture(&source_path, "canonical-incoming");
        let mut source = Connection::open(&source_path).expect("open incoming restore fixture");
        configure_history_database_connection(&source).expect("configure incoming restore fixture");
        let collection = create_history_collection(&mut source, "Restored snippets")
            .expect("create source collection");
        let snippet = save_history_snippet(
            &mut source,
            SnippetDraft {
                id: None,
                title: "Restored command".into(),
                content: "restore-snippet-searchable".into(),
                collection_id: Some(collection.id.clone()),
                kind: "code".into(),
            },
        )
        .expect("create source permanent snippet");
        let image_png = rgba_png_bytes([12, 34, 56, 255]);
        apply_history_mutation(
            &mut source,
            mutation(
                vec![image_item(
                    "restored-thumbnail",
                    "2026-07-02T00:00:00.000Z",
                    &image_png,
                )],
                CapacityPolicy {
                    max_records: 777,
                    max_image_bytes: 98_765,
                    retention_days: Some(45),
                },
            ),
        )
        .expect("create source image thumbnail");
        drop(source);
        let prepared =
            prepare_history_restore_at(&source_path, &staging_directory, &live, &"c".repeat(64))
                .expect("prepare incoming restore");
        let before = serde_json::to_value(load_history(&live).expect("load original live"))
            .expect("serialize original live");
        let error = commit_prepared_history_restore_with_hook(&mut live, &prepared, |table| {
            if table == "clips" {
                Err("injected second-table failure".to_owned())
            } else {
                Ok(())
            }
        })
        .expect_err("second-table failure must roll back all live replacement");
        assert!(error.contains("injected"));
        assert_eq!(
            serde_json::to_value(load_history(&live).expect("reload rolled-back live"))
                .expect("serialize rolled-back live"),
            before
        );

        let staged = Connection::open(&prepared.staging.path).expect("open owned staging");
        staged
            .execute(
                "UPDATE clip_search SET normalized_text = 'poisoned projection'",
                [],
            )
            .expect("tamper staged derived search projection");
        drop(staged);
        let result = commit_prepared_history_restore_with_hook(&mut live, &prepared, |_| Ok(()))
            .expect("atomically restore validated staging");
        assert_eq!(result.imported_count, 3);
        assert_eq!(result.schema_version, SCHEMA_VERSION);
        assert_eq!(result.stats.record_count, 3);
        assert_eq!(result.policy.max_records, 777);
        assert_eq!(
            query_ids(&live, history_query("canonical-incoming")),
            vec!["canonical-incoming"]
        );
        assert!(query_ids(&live, history_query("poisoned projection")).is_empty());
        assert_eq!(
            list_history_collections(&live).expect("list restored collections"),
            vec![collection]
        );
        let restored_snippet = get_clip_payload(&live, &snippet.id)
            .expect("load restored snippet")
            .expect("restored snippet exists");
        assert!(restored_snippet.permanent);
        assert_eq!(restored_snippet.collection_id, snippet.collection_id);
        assert_eq!(
            query_ids(&live, history_query("restore-snippet-searchable")),
            vec![snippet.id]
        );
        assert_eq!(
            live.query_row(
                "SELECT COUNT(*) FROM clip_thumbnails WHERE clip_id = 'restored-thumbnail'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("count restored thumbnail cache"),
            1
        );
        let revision: i64 = live
            .query_row(
                "SELECT revision FROM history_settings WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .expect("read post-restore revision");
        assert_eq!(revision, prepared.captured_revision + 1);
        assert_eq!(
            live.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                .expect("quick-check restored live database"),
            "ok"
        );
        assert_eq!(
            live.query_row(
                "SELECT COUNT(*) FROM pragma_database_list WHERE name = 'restore_source'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("verify restore source detached"),
            0
        );

        let stale =
            prepare_history_restore_at(&source_path, &staging_directory, &live, &"d".repeat(64))
                .expect("prepare revision-conflict fixture");
        apply_history_mutation(
            &mut live,
            mutation(
                vec![text_item("intervening-write", "2026-07-04T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("perform intervening live write");
        let conflict_before =
            serde_json::to_value(load_history(&live).expect("load conflict live"))
                .expect("serialize conflict live");
        assert!(commit_prepared_history_restore_with_hook(&mut live, &stale, |_| Ok(())).is_err());
        assert_eq!(
            serde_json::to_value(load_history(&live).expect("reload conflict live"))
                .expect("serialize conflict live"),
            conflict_before
        );

        drop(stale);
        drop(prepared);
        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            source_path,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact restore commit fixture");
            }
        }
        assert_eq!(
            fs::read_dir(&staging_directory)
                .expect("list staging")
                .count(),
            0
        );
        fs::remove_dir(staging_directory).expect("remove empty staging directory");
        fs::remove_dir(directory).expect("remove empty commit directory");
    }

    #[test]
    fn committed_restore_remains_success_when_post_commit_stats_or_detach_fail() {
        let directory = temporary_history_directory("restore-post-commit");
        let staging_directory = directory.join("staging");
        fs::create_dir(&staging_directory).expect("create post-commit staging");
        let live_path = directory.join("live.sqlite3");
        let mut live = Connection::open(&live_path).expect("open post-commit live");
        configure_history_database_connection(&live).expect("configure post-commit live");
        initialize_history_database(&mut live).expect("initialize post-commit live");
        let source_path = directory.join("incoming.sqlite3");
        create_closed_restore_fixture(&source_path, "committed-incoming");
        let prepared =
            prepare_history_restore_at(&source_path, &staging_directory, &live, &"f".repeat(64))
                .expect("prepare post-commit restore");
        let summary = commit_prepared_history_restore_with_operations(
            &mut live,
            &prepared,
            |_| Ok(()),
            |_| Err("injected post-commit stats failure".to_owned()),
            |connection| {
                connection
                    .execute_batch("DETACH DATABASE restore_source")
                    .expect("detach before injecting reported failure");
                Err("injected detach report failure".to_owned())
            },
        )
        .expect("post-commit failures must not report restore failure");
        assert_eq!(summary.imported_count, 1);
        assert_eq!(summary.stats.record_count, 1);
        assert!(summary.needs_connection_reopen);
        assert!(get_clip_payload(&live, "committed-incoming")
            .expect("read committed row")
            .is_some());

        drop(prepared);
        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            source_path,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact post-commit fixture");
            }
        }
        assert_eq!(
            fs::read_dir(&staging_directory)
                .expect("list staging")
                .count(),
            0
        );
        fs::remove_dir(staging_directory).expect("remove empty post-commit staging");
        fs::remove_dir(directory).expect("remove empty post-commit directory");
    }

    #[test]
    fn restore_runtime_tokens_are_one_use_expiring_and_restart_cleans_only_owned_orphans() {
        let directory = temporary_history_directory("restore-runtime");
        let staging_directory = directory.join("staging");
        fs::create_dir(&staging_directory).expect("create runtime staging directory");
        let orphan_token = "e".repeat(64);
        let orphan = staging_directory.join(format!(".quickpaste-restore-{orphan_token}.sqlite3"));
        for path in [
            orphan.clone(),
            path_with_suffix(&orphan, "-wal"),
            path_with_suffix(&orphan, "-shm"),
            path_with_suffix(&orphan, "-journal"),
        ] {
            fs::write(path, b"owned orphan").expect("seed exact owned orphan");
        }
        let unrelated = staging_directory.join("keep-me.sqlite3");
        let invalid_namespace = staging_directory.join(".quickpaste-restore-not-a-token.sqlite3");
        fs::write(&unrelated, b"unrelated").expect("seed unrelated staging sibling");
        fs::write(&invalid_namespace, b"invalid namespace").expect("seed invalid namespace file");

        let mut runtime = HistoryRuntime::new(staging_directory.clone())
            .expect("initialize history runtime and clean exact orphans");
        for path in [
            orphan.clone(),
            path_with_suffix(&orphan, "-wal"),
            path_with_suffix(&orphan, "-shm"),
            path_with_suffix(&orphan, "-journal"),
        ] {
            assert!(
                !path.exists(),
                "recognized owned orphan survived restart cleanup"
            );
        }
        assert_eq!(
            fs::read(&unrelated).expect("read unrelated sibling"),
            b"unrelated"
        );
        assert_eq!(
            fs::read(&invalid_namespace).expect("read invalid namespace sibling"),
            b"invalid namespace"
        );

        let live_path = directory.join("live.sqlite3");
        let mut live = Connection::open(&live_path).expect("open token live database");
        configure_history_database_connection(&live).expect("configure token live database");
        initialize_history_database(&mut live).expect("initialize token live database");
        let source_path = directory.join("source.sqlite3");
        create_closed_restore_fixture(&source_path, "token-incoming");

        let first = runtime
            .prepare_restore_at(&source_path, &live)
            .expect("prepare first one-use token");
        let second = runtime
            .prepare_restore_at(&source_path, &live)
            .expect("prepare second token at same revision");
        let (first_token, second_token) = match (first, second) {
            (
                PreparedRestoreResult::Prepared { token: first, .. },
                PreparedRestoreResult::Prepared { token: second, .. },
            ) => (first, second),
            _ => panic!("native prepare must return prepared tokens"),
        };
        for token in [&first_token, &second_token] {
            assert_eq!(token.len(), 64);
            assert!(token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        }
        assert_ne!(first_token, second_token);
        assert_eq!(runtime.prepared_restores.len(), 1);
        assert!(runtime
            .commit_restore_with_connection(&first_token, &mut live)
            .is_err());
        let restored = runtime
            .commit_restore_with_connection(&second_token, &mut live)
            .expect("new prepare replaces old token and restores");
        assert!(matches!(
            restored,
            RestoreResult::Restored {
                imported_count: 1,
                ..
            }
        ));
        assert!(runtime
            .commit_restore_with_connection(&first_token, &mut live)
            .is_err());
        assert!(runtime
            .commit_restore_with_connection(&second_token, &mut live)
            .is_err());

        let expiring = runtime
            .prepare_restore_at(&source_path, &live)
            .expect("prepare expiring token");
        let expiring_token = match expiring {
            PreparedRestoreResult::Prepared { token, .. } => token,
            _ => panic!("native prepare must return token"),
        };
        assert!(runtime
            .commit_restore_at(
                &expiring_token,
                &mut live,
                std::time::Instant::now() + RESTORE_TOKEN_TTL + Duration::from_secs(1),
            )
            .is_err());
        assert!(runtime
            .commit_restore_with_connection(&expiring_token, &mut live)
            .is_err());

        let discarded = runtime
            .prepare_restore_at(&source_path, &live)
            .expect("prepare discard token");
        let discarded_token = match discarded {
            PreparedRestoreResult::Prepared { token, .. } => token,
            _ => panic!("native prepare must return token"),
        };
        assert!(matches!(
            runtime
                .discard_restore(&discarded_token)
                .expect("discard exact owned staging"),
            DiscardRestoreResult::Discarded {}
        ));
        assert!(runtime
            .commit_restore_with_connection(&discarded_token, &mut live)
            .is_err());

        drop(runtime);
        drop(live);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            source_path,
            unrelated,
            invalid_namespace,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact runtime fixture");
            }
        }
        assert_eq!(
            fs::read_dir(&staging_directory)
                .expect("list staging")
                .count(),
            0
        );
        fs::remove_dir(staging_directory).expect("remove empty runtime staging directory");
        fs::remove_dir(directory).expect("remove empty runtime directory");
    }

    #[test]
    fn failed_prepare_cleanup_denial_stays_runtime_owned_until_maintenance_retry() {
        let directory = temporary_history_directory("prepare-cleanup-retry");
        let staging_directory = directory.join("staging");
        let invalid_source = directory.join("invalid.sqlite3");
        fs::write(&invalid_source, b"not a database").expect("seed invalid prepare source");
        let mut runtime =
            HistoryRuntime::new(staging_directory.clone()).expect("create prepare cleanup runtime");
        let mut live = Connection::open_in_memory().expect("open prepare cleanup live");
        initialize_history_database(&mut live).expect("initialize prepare cleanup live");
        let deny_cleanup = Cell::new(true);
        let mut remove = |path: &Path| {
            if deny_cleanup.get() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected prepare cleanup denial",
                ))
            } else {
                fs::remove_file(path)
            }
        };
        let now = Instant::now();

        assert!(runtime
            .prepare_restore_at_with_cleanup(&invalid_source, &live, now, &mut remove)
            .is_err());
        assert_eq!(runtime.prepared_restores.len(), 0);
        assert_eq!(runtime.pending_cleanup.len(), 1);
        let pending_path = runtime
            .pending_cleanup
            .keys()
            .next()
            .expect("failed prepare remains pending")
            .clone();
        assert!(pending_path.is_file());

        deny_cleanup.set(false);
        runtime
            .purge_expired_at_with_cleanup(now + Duration::from_secs(1), &mut remove)
            .expect("maintenance retries failed prepare cleanup");
        assert!(runtime.pending_cleanup.is_empty());
        assert!(!pending_path.exists());

        drop(runtime);
        fs::remove_file(invalid_source).expect("remove invalid prepare source");
        fs::remove_dir(staging_directory).expect("remove empty prepare cleanup staging");
        fs::remove_dir(directory).expect("remove empty prepare cleanup directory");
    }

    #[test]
    fn replacing_prepared_token_cleanup_denial_stays_owned_until_maintenance_retry() {
        let directory = temporary_history_directory("replace-cleanup-retry");
        let staging_directory = directory.join("staging");
        let source_path = directory.join("source.sqlite3");
        create_closed_restore_fixture(&source_path, "replace-cleanup");
        let mut runtime =
            HistoryRuntime::new(staging_directory.clone()).expect("create replace cleanup runtime");
        let mut live = Connection::open_in_memory().expect("open replace cleanup live");
        initialize_history_database(&mut live).expect("initialize replace cleanup live");
        let now = Instant::now();
        let mut remove_normally = |path: &Path| fs::remove_file(path);
        runtime
            .prepare_restore_at_with_cleanup(&source_path, &live, now, &mut remove_normally)
            .expect("prepare token that will be replaced");
        let previous_path = runtime
            .prepared_restores
            .values()
            .next()
            .expect("prepared token exists")
            .prepared
            .staging
            .path
            .clone();
        let deny_cleanup = Cell::new(true);
        let mut remove = |path: &Path| {
            if deny_cleanup.get() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected replacement cleanup denial",
                ))
            } else {
                fs::remove_file(path)
            }
        };

        assert!(runtime
            .prepare_restore_at_with_cleanup(&source_path, &live, now, &mut remove)
            .is_err());
        assert!(runtime.prepared_restores.is_empty());
        assert!(runtime.pending_cleanup.contains_key(&previous_path));
        assert!(previous_path.is_file());

        deny_cleanup.set(false);
        runtime
            .purge_expired_at_with_cleanup(now + Duration::from_secs(1), &mut remove)
            .expect("maintenance retries replaced-token cleanup");
        assert!(runtime.pending_cleanup.is_empty());
        assert!(!previous_path.exists());

        drop(runtime);
        fs::remove_file(source_path).expect("remove replace cleanup source");
        fs::remove_dir(staging_directory).expect("remove empty replace cleanup staging");
        fs::remove_dir(directory).expect("remove empty replace cleanup directory");
    }

    #[test]
    fn discarded_token_cleanup_denial_stays_owned_until_maintenance_retry() {
        let directory = temporary_history_directory("discard-cleanup-retry");
        let staging_directory = directory.join("staging");
        let source_path = directory.join("source.sqlite3");
        create_closed_restore_fixture(&source_path, "discard-cleanup");
        let mut runtime =
            HistoryRuntime::new(staging_directory.clone()).expect("create discard cleanup runtime");
        let mut live = Connection::open_in_memory().expect("open discard cleanup live");
        initialize_history_database(&mut live).expect("initialize discard cleanup live");
        let now = Instant::now();
        let mut remove_normally = |path: &Path| fs::remove_file(path);
        let prepared = runtime
            .prepare_restore_at_with_cleanup(&source_path, &live, now, &mut remove_normally)
            .expect("prepare token that will be discarded");
        let token = match prepared {
            PreparedRestoreResult::Prepared { token, .. } => token,
            PreparedRestoreResult::Cancelled {} => panic!("path-backed prepare cannot cancel"),
        };
        let staging_path = runtime
            .prepared_restores
            .get(&token)
            .expect("discard token exists")
            .prepared
            .staging
            .path
            .clone();
        let deny_cleanup = Cell::new(true);
        let mut remove = |path: &Path| {
            if deny_cleanup.get() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected discard cleanup denial",
                ))
            } else {
                fs::remove_file(path)
            }
        };

        assert!(runtime
            .discard_restore_at_with_cleanup(&token, now, &mut remove)
            .is_err());
        assert!(!runtime.prepared_restores.contains_key(&token));
        assert!(runtime.pending_cleanup.contains_key(&staging_path));
        assert!(staging_path.is_file());

        deny_cleanup.set(false);
        runtime
            .purge_expired_at_with_cleanup(now + Duration::from_secs(1), &mut remove)
            .expect("maintenance retries discarded-token cleanup");
        assert!(runtime.pending_cleanup.is_empty());
        assert!(!staging_path.exists());

        drop(runtime);
        fs::remove_file(source_path).expect("remove discard cleanup source");
        fs::remove_dir(staging_directory).expect("remove empty discard cleanup staging");
        fs::remove_dir(directory).expect("remove empty discard cleanup directory");
    }

    #[test]
    fn expired_token_cleanup_denial_stays_owned_until_maintenance_retry() {
        let directory = temporary_history_directory("expiry-cleanup-retry");
        let staging_directory = directory.join("staging");
        let source_path = directory.join("source.sqlite3");
        create_closed_restore_fixture(&source_path, "expiry-cleanup");
        let mut runtime =
            HistoryRuntime::new(staging_directory.clone()).expect("create expiry cleanup runtime");
        let mut live = Connection::open_in_memory().expect("open expiry cleanup live");
        initialize_history_database(&mut live).expect("initialize expiry cleanup live");
        let now = Instant::now();
        let mut remove_normally = |path: &Path| fs::remove_file(path);
        let prepared = runtime
            .prepare_restore_at_with_cleanup(&source_path, &live, now, &mut remove_normally)
            .expect("prepare token that will expire");
        let token = match prepared {
            PreparedRestoreResult::Prepared { token, .. } => token,
            PreparedRestoreResult::Cancelled {} => panic!("path-backed prepare cannot cancel"),
        };
        let staging_path = runtime
            .prepared_restores
            .get(&token)
            .expect("expiring token exists")
            .prepared
            .staging
            .path
            .clone();
        let deny_cleanup = Cell::new(true);
        let mut remove = |path: &Path| {
            if deny_cleanup.get() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected expiry cleanup denial",
                ))
            } else {
                fs::remove_file(path)
            }
        };
        let expired_at = now + RESTORE_TOKEN_TTL + Duration::from_secs(1);

        assert!(runtime
            .purge_expired_at_with_cleanup(expired_at, &mut remove)
            .is_err());
        assert!(!runtime.prepared_restores.contains_key(&token));
        assert!(runtime.pending_cleanup.contains_key(&staging_path));
        assert!(staging_path.is_file());

        deny_cleanup.set(false);
        runtime
            .purge_expired_at_with_cleanup(expired_at + Duration::from_secs(1), &mut remove)
            .expect("maintenance retries expired-token cleanup");
        assert!(runtime.pending_cleanup.is_empty());
        assert!(!staging_path.exists());

        drop(runtime);
        fs::remove_file(source_path).expect("remove expiry cleanup source");
        fs::remove_dir(staging_directory).expect("remove empty expiry cleanup staging");
        fs::remove_dir(directory).expect("remove empty expiry cleanup directory");
    }

    #[test]
    fn committed_token_cleanup_denial_stays_owned_until_maintenance_retry() {
        let directory = temporary_history_directory("commit-cleanup-retry");
        let staging_directory = directory.join("staging");
        let source_path = directory.join("source.sqlite3");
        create_closed_restore_fixture(&source_path, "commit-cleanup");
        let mut runtime =
            HistoryRuntime::new(staging_directory.clone()).expect("create commit cleanup runtime");
        let mut live = Connection::open_in_memory().expect("open commit cleanup live");
        initialize_history_database(&mut live).expect("initialize commit cleanup live");
        let now = Instant::now();
        let mut remove_normally = |path: &Path| fs::remove_file(path);
        let prepared = runtime
            .prepare_restore_at_with_cleanup(&source_path, &live, now, &mut remove_normally)
            .expect("prepare token that will be committed");
        let token = match prepared {
            PreparedRestoreResult::Prepared { token, .. } => token,
            PreparedRestoreResult::Cancelled {} => panic!("path-backed prepare cannot cancel"),
        };
        let staging_path = runtime
            .prepared_restores
            .get(&token)
            .expect("commit token exists")
            .prepared
            .staging
            .path
            .clone();
        let deny_cleanup = Cell::new(true);
        let mut remove = |path: &Path| {
            if deny_cleanup.get() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "injected commit cleanup denial",
                ))
            } else {
                fs::remove_file(path)
            }
        };

        assert!(matches!(
            runtime
                .commit_restore_at_with_cleanup(&token, &mut live, now, &mut remove)
                .expect("cleanup denial must not turn a committed import into failure"),
            RestoreResult::Restored {
                imported_count: 1,
                ..
            }
        ));
        assert!(!runtime.prepared_restores.contains_key(&token));
        assert!(runtime.pending_cleanup.contains_key(&staging_path));
        assert!(staging_path.is_file());

        deny_cleanup.set(false);
        runtime
            .purge_expired_at_with_cleanup(now + Duration::from_secs(1), &mut remove)
            .expect("maintenance retries committed-token cleanup");
        assert!(runtime.pending_cleanup.is_empty());
        assert!(!staging_path.exists());

        drop(runtime);
        fs::remove_file(source_path).expect("remove commit cleanup source");
        fs::remove_dir(staging_directory).expect("remove empty commit cleanup staging");
        fs::remove_dir(directory).expect("remove empty commit cleanup directory");
    }

    #[test]
    fn owned_history_runtime_reuses_one_lane_and_keeps_restore_lane_unpolluted_before_cleanup() {
        let directory = temporary_history_directory("owned-runtime-lane");
        let source_path = directory.join("source.sqlite3");
        create_closed_restore_fixture(&source_path, "owned-runtime-incoming");
        let mut runtime = HistoryRuntime::open(directory.clone()).expect("open owned history lane");
        let first_handle = runtime
            .with_connection(|connection| {
                let handle = unsafe { connection.handle() } as usize;
                apply_history_mutation(
                    connection,
                    mutation(
                        vec![text_item("owned-runtime-live", "2026-07-01T00:00:00.000Z")],
                        CapacityPolicy::default(),
                    ),
                )?;
                Ok(handle)
            })
            .expect("mutate through owned lane");
        for _ in 0..3 {
            let handle = runtime
                .with_connection(|connection| {
                    query_history(connection, HistoryQuery::default())?;
                    Ok(unsafe { connection.handle() } as usize)
                })
                .expect("query through persistent owned lane");
            assert_eq!(
                handle, first_handle,
                "ordinary IPC work reopened the live connection"
            );
        }
        let prepared = runtime
            .prepare_restore_source(&source_path)
            .expect("prepare through owned runtime");
        let token = match prepared {
            PreparedRestoreResult::Prepared { token, .. } => token,
            PreparedRestoreResult::Cancelled {} => panic!("path-backed prepare cannot cancel"),
        };
        let result = runtime
            .commit_restore_token(&token)
            .expect("commit through owned runtime");
        assert!(matches!(
            result,
            RestoreResult::Restored {
                imported_count: 1,
                ..
            }
        ));
        runtime
            .with_connection(|connection| {
                assert!(get_clip_payload(connection, "owned-runtime-incoming")?.is_some());
                assert!(get_clip_payload(connection, "owned-runtime-live")?.is_none());
                assert_eq!(
                    connection
                        .query_row(
                            "SELECT COUNT(*) FROM pragma_database_list
                             WHERE name = 'restore_source'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )
                        .map_err(|error| error.to_string())?,
                    0
                );
                Ok(())
            })
            .expect("verify unpolluted owned lane after restore");
        assert_eq!(
            serde_json::to_value(runtime.health()).expect("serialize runtime health")["status"],
            "healthy"
        );
        assert_eq!(
            fs::read_dir(directory.join("history-restore-staging"))
                .expect("list owned runtime staging")
                .count(),
            0
        );

        drop(runtime);
        let live_path = directory.join("history.sqlite3");
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
            source_path,
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact owned runtime fixture");
            }
        }
        fs::remove_dir(directory.join("history-restore-staging"))
            .expect("remove empty owned staging directory");
        fs::remove_dir(directory).expect("remove empty owned runtime directory");
    }

    #[test]
    fn storage_stats_serialize_with_the_exact_sixteen_field_contract() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize stats schema");
        let value =
            serde_json::to_value(get_storage_stats(&database).expect("read empty storage stats"))
                .expect("serialize storage stats");
        let mut keys = value
            .as_object()
            .expect("stats object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            sorted_keys(&[
                "databaseBytes",
                "walBytes",
                "shmBytes",
                "totalPhysicalBytes",
                "recordCount",
                "pinnedCount",
                "permanentCount",
                "imageBytes",
                "richFormatBytes",
                "fileRecordCount",
                "logicalBytes",
                "oldestCopiedAt",
                "newestCopiedAt",
                "maxRecords",
                "maxImageBytes",
                "retentionDays",
            ])
        );
        assert!(value["oldestCopiedAt"].is_null());
        assert!(value["newestCopiedAt"].is_null());
    }

    #[test]
    fn native_backup_and_restore_results_serialize_with_exact_camel_case_shapes() {
        assert_eq!(
            serde_json::to_value(BackupResult::Cancelled {}).expect("serialize backup cancel"),
            serde_json::json!({ "status": "cancelled" })
        );
        assert_eq!(
            serde_json::to_value(BackupResult::Saved {}).expect("serialize backup saved"),
            serde_json::json!({ "status": "saved" })
        );
        assert_eq!(
            serde_json::to_value(PreparedRestoreResult::Prepared {
                token: "a".repeat(64),
                current_count: 2,
                incoming_count: 3,
                schema_version: SCHEMA_VERSION,
            })
            .expect("serialize prepared restore"),
            serde_json::json!({
                "status": "prepared",
                "token": "a".repeat(64),
                "currentCount": 2,
                "incomingCount": 3,
                "schemaVersion": SCHEMA_VERSION,
            })
        );
        let mut database = Connection::open_in_memory().expect("open result stats database");
        initialize_history_database(&mut database).expect("initialize result stats database");
        let stats = get_storage_stats(&database).expect("read result stats");
        let value = serde_json::to_value(RestoreResult::Restored {
            imported_count: 3,
            schema_version: SCHEMA_VERSION,
            policy: CapacityPolicy {
                max_records: 500,
                max_image_bytes: 268_435_456,
                retention_days: Some(30),
            },
            stats,
        })
        .expect("serialize restore result");
        let object = value.as_object().expect("restore result object");
        assert!(object.contains_key("importedCount"));
        assert!(object.contains_key("schemaVersion"));
        assert!(!object.contains_key("imported_count"));
        assert!(!object.contains_key("schema_version"));
        assert_eq!(
            serde_json::to_value(DiscardRestoreResult::Discarded {})
                .expect("serialize discarded restore"),
            serde_json::json!({ "status": "discarded" })
        );
    }

    #[test]
    fn history_health_serializes_only_closed_content_free_shapes() {
        assert_eq!(
            serde_json::to_value(HistoryHealth::healthy()).expect("serialize healthy state"),
            serde_json::json!({ "status": "healthy" })
        );
        assert_eq!(
            serde_json::to_value(HistoryHealth::recovered(
                RecoveryReason::NotADatabase,
                r"C:\QuickPaste\history-recovery-1".to_owned(),
            ))
            .expect("serialize recovered state"),
            serde_json::json!({
                "status": "recovered",
                "reason": "notADatabase",
                "quarantinePath": r"C:\QuickPaste\history-recovery-1",
            })
        );
        assert_eq!(
            serde_json::to_value(HistoryHealth::read_only(
                HistoryReadOnlyReason::PermissionDenied,
            ))
            .expect("serialize read-only state"),
            serde_json::json!({
                "status": "readOnlyError",
                "reason": "permissionDenied",
            })
        );
        assert_eq!(
            serde_json::to_value(HistoryHealth::fresh_database_failed(
                RecoveryReason::Corrupt,
                r"C:\QuickPaste\history-recovery-2".to_owned(),
            ))
            .expect("serialize failed fresh database state"),
            serde_json::json!({
                "status": "readOnlyError",
                "reason": "freshDatabaseFailed",
                "recoveryReason": "corrupt",
                "quarantinePath": r"C:\QuickPaste\history-recovery-2",
            })
        );
    }

    #[test]
    fn confirmed_corrupt_and_notadb_databases_are_exactly_quarantined_with_persistent_notice() {
        for (case, reason) in [
            ("corrupt", RecoveryReason::Corrupt),
            ("notadb", RecoveryReason::NotADatabase),
        ] {
            let directory = temporary_history_directory(&format!("recovery-{case}"));
            let live_path = directory.join("history.sqlite3");
            if reason == RecoveryReason::Corrupt {
                create_closed_restore_fixture(&live_path, "sensitive-corrupt-payload");
                let mut bytes = fs::read(&live_path).expect("read corrupt source fixture");
                bytes[100] = 0xff;
                fs::write(&live_path, bytes).expect("damage sqlite page header");
            } else {
                fs::write(&live_path, b"not a sqlite database").expect("write NOTADB fixture");
            }
            let wal_path = path_with_suffix(&live_path, "-wal");
            let shm_path = path_with_suffix(&live_path, "-shm");
            let unrelated = directory.join("history.sqlite3-wal-unrelated");
            fs::write(&wal_path, b"exact WAL").expect("seed exact WAL sibling");
            fs::write(&shm_path, b"exact SHM").expect("seed exact SHM sibling");
            fs::write(&unrelated, b"unrelated").expect("seed unrelated sibling");

            let (fresh, health) =
                recover_confirmed_history_database_with(&directory, &live_path, reason, || {
                    open_history_database_once(&directory).map_err(|failure| match failure {
                        HistoryOpenFailure::ReadOnly(reason) => reason,
                        HistoryOpenFailure::ConfirmedCorruption(_) => {
                            HistoryReadOnlyReason::Unknown
                        }
                    })
                })
                .expect("confirmed corruption should quarantine then create fresh database");
            assert_eq!(pragma_i64(&fresh, "application_id"), APPLICATION_ID);
            assert_eq!(pragma_i64(&fresh, "user_version"), SCHEMA_VERSION);
            assert_eq!(history_count(&fresh).expect("read fresh count"), 0);
            let health_value = serde_json::to_value(&health).expect("serialize recovery health");
            assert_eq!(health_value["status"], "recovered");
            assert_eq!(
                health_value["reason"],
                serde_json::to_value(reason).expect("serialize recovery reason")
            );
            let quarantine_path = PathBuf::from(
                health_value["quarantinePath"]
                    .as_str()
                    .expect("confirmed quarantine path"),
            );
            assert_eq!(
                fs::read(quarantine_path.join("history.sqlite3-wal"))
                    .expect("read quarantined WAL"),
                b"exact WAL"
            );
            assert_eq!(
                fs::read(quarantine_path.join("history.sqlite3-shm"))
                    .expect("read quarantined SHM"),
                b"exact SHM"
            );
            assert!(quarantine_path.join("history.sqlite3").is_file());
            assert_eq!(
                fs::read(&unrelated).expect("read unrelated sibling"),
                b"unrelated"
            );

            let notice_path = directory.join(HISTORY_RECOVERY_NOTICE_FILE);
            let notice: serde_json::Value = serde_json::from_slice(
                &fs::read(&notice_path).expect("read persistent recovery notice"),
            )
            .expect("parse persistent recovery notice");
            let mut notice_keys = notice
                .as_object()
                .expect("notice object")
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            notice_keys.sort();
            assert_eq!(
                notice_keys,
                sorted_keys(&["formatVersion", "phase", "reason", "quarantinePath"])
            );
            assert_eq!(notice["phase"], "recovered");
            assert!(!notice.to_string().contains("sensitive-corrupt-payload"));

            drop(fresh);
            let (reopened, persisted_health) = open_history_database_with_recovery(&directory)
                .expect("reopen fresh database with persisted recovery notice");
            assert_eq!(
                serde_json::to_value(persisted_health).expect("serialize persisted health"),
                health_value
            );
            drop(reopened);

            for path in [
                live_path.clone(),
                path_with_suffix(&live_path, "-wal"),
                path_with_suffix(&live_path, "-shm"),
                notice_path,
                unrelated,
                quarantine_path.join("history.sqlite3"),
                quarantine_path.join("history.sqlite3-wal"),
                quarantine_path.join("history.sqlite3-shm"),
            ] {
                if path.exists() {
                    fs::remove_file(path).expect("remove exact recovery fixture");
                }
            }
            fs::remove_dir(quarantine_path).expect("remove empty recovery directory");
            fs::remove_dir(directory).expect("remove empty recovery fixture directory");
        }
    }

    #[test]
    fn recovered_notice_with_missing_fresh_database_keeps_original_recovery_context() {
        let directory = temporary_history_directory("recovery-missing-fresh-restart");
        let recovery_directory = directory.join("history-recovery-missing-fresh-restart");
        fs::create_dir(&recovery_directory).expect("create missing-fresh quarantine directory");
        fs::write(
            recovery_directory.join("history.sqlite3"),
            b"original quarantined",
        )
        .expect("seed original quarantined database");
        let notice = RecoveryNotice {
            format_version: HISTORY_RECOVERY_NOTICE_VERSION,
            phase: RecoveryNoticePhase::Recovered,
            reason: RecoveryReason::NotADatabase,
            quarantine_path: fs::canonicalize(&recovery_directory)
                .expect("canonical missing-fresh quarantine directory")
                .to_str()
                .expect("Unicode missing-fresh quarantine path")
                .to_owned(),
        };
        write_recovery_notice(&directory, &notice).expect("write recovered restart notice");

        let health = open_history_database_with_recovery(&directory).expect_err(
            "missing fresh database after recovery must remain a closed recovery state",
        );
        assert_eq!(
            serde_json::to_value(health).expect("serialize missing-fresh health"),
            serde_json::json!({
                "status": "readOnlyError",
                "reason": "freshDatabaseFailed",
                "recoveryReason": "notADatabase",
                "quarantinePath": notice.quarantine_path,
            })
        );
        assert_eq!(
            fs::read(recovery_directory.join("history.sqlite3"))
                .expect("read preserved original quarantine"),
            b"original quarantined"
        );

        fs::remove_file(directory.join(HISTORY_RECOVERY_NOTICE_FILE))
            .expect("remove missing-fresh notice");
        fs::remove_file(recovery_directory.join("history.sqlite3"))
            .expect("remove missing-fresh quarantine database");
        fs::remove_dir(recovery_directory).expect("remove missing-fresh quarantine directory");
        fs::remove_dir(directory).expect("remove missing-fresh data directory");
    }

    #[test]
    fn only_corrupt_and_notadb_codes_are_quarantinable_and_move_failure_rolls_back_exact_files() {
        assert_eq!(
            classify_sqlite_primary_code(rusqlite::ffi::SQLITE_CORRUPT),
            HistoryOpenFailure::ConfirmedCorruption(RecoveryReason::Corrupt)
        );
        assert_eq!(
            classify_sqlite_primary_code(rusqlite::ffi::SQLITE_NOTADB),
            HistoryOpenFailure::ConfirmedCorruption(RecoveryReason::NotADatabase)
        );
        for (code, expected) in [
            (rusqlite::ffi::SQLITE_BUSY, HistoryReadOnlyReason::Busy),
            (
                rusqlite::ffi::SQLITE_READONLY,
                HistoryReadOnlyReason::PermissionDenied,
            ),
            (rusqlite::ffi::SQLITE_IOERR, HistoryReadOnlyReason::Io),
            (rusqlite::ffi::SQLITE_FULL, HistoryReadOnlyReason::DiskFull),
        ] {
            assert_eq!(
                classify_sqlite_primary_code(code),
                HistoryOpenFailure::ReadOnly(expected)
            );
        }

        let directory = temporary_history_directory("quarantine-rollback");
        let live_path = directory.join("history.sqlite3");
        let wal_path = path_with_suffix(&live_path, "-wal");
        let shm_path = path_with_suffix(&live_path, "-shm");
        let unrelated = directory.join("history.sqlite3-other");
        fs::write(&live_path, b"main").expect("seed rollback main");
        fs::write(&wal_path, b"wal").expect("seed rollback WAL");
        fs::write(&shm_path, b"shm").expect("seed rollback SHM");
        fs::write(&unrelated, b"other").expect("seed unrelated rollback sibling");
        let result = quarantine_history_database_with(
            &directory,
            &live_path,
            RecoveryReason::Corrupt,
            |source, destination| {
                if source == shm_path {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected third move failure",
                    ))
                } else {
                    fs::rename(source, destination)
                }
            },
            |_| Ok(()),
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&live_path).expect("rolled-back main"), b"main");
        assert_eq!(fs::read(&wal_path).expect("rolled-back WAL"), b"wal");
        assert_eq!(fs::read(&shm_path).expect("unmoved SHM"), b"shm");
        assert_eq!(fs::read(&unrelated).expect("unrelated remains"), b"other");
        let recovery_directories = fs::read_dir(&directory)
            .expect("list rollback directory")
            .filter_map(|entry| {
                let entry = entry.ok()?;
                entry
                    .file_type()
                    .ok()?
                    .is_dir()
                    .then(|| entry.file_name().to_string_lossy().into_owned())
            })
            .collect::<Vec<_>>();
        assert!(recovery_directories.is_empty());
        for path in [live_path, wal_path, shm_path, unrelated] {
            fs::remove_file(path).expect("remove exact rollback fixture");
        }
        fs::remove_dir(directory).expect("remove empty rollback directory");
    }

    #[test]
    fn real_busy_open_is_typed_read_only_and_never_quarantines() {
        let directory = temporary_history_directory("recovery-real-busy");
        let live_path = directory.join("history.sqlite3");
        create_closed_restore_fixture(&live_path, "busy-live");
        let locker = Connection::open(&live_path).expect("open exclusive-lock fixture");
        locker
            .busy_timeout(Duration::from_millis(10))
            .expect("configure exclusive-lock fixture");
        locker
            .execute_batch("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;")
            .expect("hold real exclusive database lock");

        let health = open_history_database_with_recovery(&directory)
            .expect_err("BUSY database must remain read-only without quarantine");
        assert_eq!(
            serde_json::to_value(health).expect("serialize BUSY health"),
            serde_json::json!({ "status": "readOnlyError", "reason": "busy" })
        );
        assert!(live_path.is_file());
        assert!(!directory.join(HISTORY_RECOVERY_NOTICE_FILE).exists());
        assert_eq!(
            fs::read_dir(&directory)
                .expect("list BUSY data directory")
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    entry.file_type().ok()?.is_dir().then_some(())
                })
                .count(),
            0
        );

        locker
            .execute_batch("ROLLBACK")
            .expect("release exclusive lock");
        drop(locker);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact BUSY fixture");
            }
        }
        fs::remove_dir(directory).expect("remove empty BUSY directory");
    }

    #[test]
    fn unreadable_or_invalid_recovery_notice_fails_closed_for_healthy_and_corrupt_live_data() {
        for live_is_healthy in [true, false] {
            let case = if live_is_healthy {
                "healthy"
            } else {
                "corrupt"
            };
            let directory =
                temporary_history_directory(&format!("recovery-unreadable-notice-{case}"));
            let live_path = directory.join("history.sqlite3");
            if live_is_healthy {
                create_closed_restore_fixture(&live_path, "notice-live");
            } else {
                fs::write(&live_path, b"not a database").expect("seed corrupt notice fixture");
            }

            let health = open_history_database_with_recovery_and_notice_loader(&directory, |_| {
                Err("injected permission denied".to_owned())
            })
            .expect_err("ambiguous unreadable notice must fail closed");
            assert_eq!(
                serde_json::to_value(health).expect("serialize unreadable notice health"),
                serde_json::json!({
                    "status": "readOnlyError",
                    "reason": "quarantineFailed"
                })
            );
            assert!(live_path.is_file());
            assert_eq!(
                fs::read_dir(&directory)
                    .expect("list unreadable notice fixture")
                    .filter_map(|entry| {
                        let entry = entry.ok()?;
                        entry.file_type().ok()?.is_dir().then_some(())
                    })
                    .count(),
                0,
                "unreadable marker must not trigger a second quarantine"
            );

            for path in [
                live_path.clone(),
                path_with_suffix(&live_path, "-wal"),
                path_with_suffix(&live_path, "-shm"),
            ] {
                if path.exists() {
                    fs::remove_file(path).expect("remove unreadable notice fixture");
                }
            }
            fs::remove_dir(directory).expect("remove unreadable notice directory");
        }

        for live_is_healthy in [true, false] {
            let case = if live_is_healthy {
                "healthy"
            } else {
                "corrupt"
            };
            let directory = temporary_history_directory(&format!("recovery-invalid-notice-{case}"));
            let live_path = directory.join("history.sqlite3");
            if live_is_healthy {
                create_closed_restore_fixture(&live_path, "invalid-notice-live");
            } else {
                fs::write(&live_path, b"not a database")
                    .expect("seed corrupt invalid-notice fixture");
            }
            let notice_path = directory.join(HISTORY_RECOVERY_NOTICE_FILE);
            fs::write(&notice_path, b"{ definitely not valid JSON")
                .expect("seed invalid recovery notice");

            let health = open_history_database_with_recovery(&directory)
                .expect_err("invalid notice must fail closed even when live data opens");
            assert_eq!(
                serde_json::to_value(health).expect("serialize invalid notice health"),
                serde_json::json!({
                    "status": "readOnlyError",
                    "reason": "quarantineFailed"
                })
            );
            assert!(notice_path.is_file());
            assert!(live_path.is_file());

            for path in [
                notice_path,
                live_path.clone(),
                path_with_suffix(&live_path, "-wal"),
                path_with_suffix(&live_path, "-shm"),
            ] {
                if path.exists() {
                    fs::remove_file(path).expect("remove invalid notice fixture");
                }
            }
            fs::remove_dir(directory).expect("remove invalid notice directory");
        }
    }

    #[test]
    fn quarantine_rollback_attempts_every_moved_file_after_an_intermediate_rollback_failure() {
        let directory = temporary_history_directory("quarantine-full-rollback");
        let live_path = directory.join("history.sqlite3");
        let wal_path = path_with_suffix(&live_path, "-wal");
        let shm_path = path_with_suffix(&live_path, "-shm");
        fs::write(&live_path, b"main").expect("seed full rollback main");
        fs::write(&wal_path, b"wal").expect("seed full rollback WAL");
        fs::write(&shm_path, b"shm").expect("seed full rollback SHM");
        let attempts = std::cell::RefCell::new(Vec::<String>::new());
        let publish_count = Cell::new(0_u8);
        let result = quarantine_history_database_with_rollback(
            &directory,
            &live_path,
            RecoveryReason::Corrupt,
            |source, destination| fs::rename(source, destination),
            |source, destination| {
                let name = source
                    .file_name()
                    .expect("rollback source name")
                    .to_string_lossy()
                    .into_owned();
                attempts.borrow_mut().push(name.clone());
                if name == "history.sqlite3-wal" {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "injected middle rollback failure",
                    ))
                } else {
                    fs::rename(source, destination)
                }
            },
            |_| {
                let count = publish_count.get();
                publish_count.set(count + 1);
                if count == 0 {
                    Ok(())
                } else {
                    Err("injected completed notice failure".to_owned())
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(
            attempts.into_inner(),
            vec![
                "history.sqlite3-shm".to_owned(),
                "history.sqlite3-wal".to_owned(),
                "history.sqlite3".to_owned(),
            ]
        );
        assert!(live_path.is_file());
        assert!(shm_path.is_file());
        assert!(!wal_path.exists());
        let recovery_directory = fs::read_dir(&directory)
            .expect("list incomplete rollback directory")
            .find_map(|entry| {
                let entry = entry.ok()?;
                entry.file_type().ok()?.is_dir().then(|| entry.path())
            })
            .expect("failed rollback retains exact recovery directory");
        fs::rename(recovery_directory.join("history.sqlite3-wal"), &wal_path)
            .expect("restore injected failed rollback fixture");
        for path in [live_path, wal_path, shm_path] {
            fs::remove_file(path).expect("remove exact full rollback fixture");
        }
        fs::remove_dir(recovery_directory).expect("remove empty full rollback directory");
        fs::remove_dir(directory).expect("remove empty full rollback fixture directory");
    }

    #[test]
    fn fresh_database_failure_preserves_confirmed_quarantine_path_and_notice() {
        let directory = temporary_history_directory("fresh-database-failure");
        let live_path = directory.join("history.sqlite3");
        fs::write(&live_path, b"not a database").expect("seed failed fresh fixture");
        let health = recover_confirmed_history_database_with(
            &directory,
            &live_path,
            RecoveryReason::NotADatabase,
            || Err(HistoryReadOnlyReason::DiskFull),
        )
        .expect_err("injected fresh database creation must remain read-only");
        let value = serde_json::to_value(&health).expect("serialize fresh failure health");
        assert_eq!(value["status"], "readOnlyError");
        assert_eq!(value["reason"], "freshDatabaseFailed");
        assert_eq!(value["recoveryReason"], "notADatabase");
        let quarantine_path = PathBuf::from(
            value["quarantinePath"]
                .as_str()
                .expect("fresh failure must expose confirmed path"),
        );
        assert!(quarantine_path.join("history.sqlite3").is_file());
        assert!(directory.join(HISTORY_RECOVERY_NOTICE_FILE).is_file());
        assert!(!live_path.exists());

        for path in [
            quarantine_path.join("history.sqlite3"),
            directory.join(HISTORY_RECOVERY_NOTICE_FILE),
        ] {
            fs::remove_file(path).expect("remove exact failed-fresh fixture");
        }
        fs::remove_dir(quarantine_path).expect("remove empty failed-fresh recovery directory");
        fs::remove_dir(directory).expect("remove empty failed-fresh directory");
    }

    #[test]
    fn startup_reconciles_pending_quarantine_after_every_crash_window_without_scanning() {
        for (case, moved_count, phase) in [
            ("pending-0", 0_usize, RecoveryNoticePhase::Pending),
            ("pending-1", 1, RecoveryNoticePhase::Pending),
            ("pending-2", 2, RecoveryNoticePhase::Pending),
            ("pending-3", 3, RecoveryNoticePhase::Pending),
            ("quarantined", 3, RecoveryNoticePhase::Quarantined),
        ] {
            let directory = temporary_history_directory(&format!("recovery-crash-{case}"));
            let live_path = directory.join("history.sqlite3");
            let sources = [
                live_path.clone(),
                path_with_suffix(&live_path, "-wal"),
                path_with_suffix(&live_path, "-shm"),
            ];
            for (path, bytes) in sources.iter().zip([b"main".as_slice(), b"wal", b"shm"]) {
                fs::write(path, bytes).expect("seed crash-window source");
            }
            let recovery_directory = directory.join(format!("history-recovery-crash-{case}"));
            fs::create_dir(&recovery_directory).expect("create owned crash recovery directory");
            let quarantine_path = fs::canonicalize(&recovery_directory)
                .expect("canonical crash recovery directory")
                .to_str()
                .expect("Unicode crash recovery path")
                .to_owned();
            let notice = RecoveryNotice {
                format_version: HISTORY_RECOVERY_NOTICE_VERSION,
                phase,
                reason: RecoveryReason::Corrupt,
                quarantine_path,
            };
            write_recovery_notice(&directory, &notice).expect("persist simulated crash notice");
            for source in sources.iter().take(moved_count) {
                fs::rename(
                    source,
                    recovery_directory.join(source.file_name().expect("crash source name")),
                )
                .expect("simulate completed pre-crash move");
            }

            let (fresh, health) = open_history_database_with_recovery(&directory)
                .expect("startup must reconcile exact pending quarantine");
            assert_eq!(
                history_count(&fresh).expect("read reconciled fresh count"),
                0
            );
            assert_eq!(
                serde_json::to_value(health).expect("serialize reconciled health")["status"],
                "recovered"
            );
            for name in [
                "history.sqlite3",
                "history.sqlite3-wal",
                "history.sqlite3-shm",
            ] {
                assert!(recovery_directory.join(name).is_file());
            }
            let completed: RecoveryNotice = serde_json::from_slice(
                &fs::read(directory.join(HISTORY_RECOVERY_NOTICE_FILE))
                    .expect("read reconciled completed notice"),
            )
            .expect("parse reconciled completed notice");
            assert_eq!(completed.phase, RecoveryNoticePhase::Recovered);

            drop(fresh);
            for path in [
                live_path.clone(),
                path_with_suffix(&live_path, "-wal"),
                path_with_suffix(&live_path, "-shm"),
                directory.join(HISTORY_RECOVERY_NOTICE_FILE),
                recovery_directory.join("history.sqlite3"),
                recovery_directory.join("history.sqlite3-wal"),
                recovery_directory.join("history.sqlite3-shm"),
            ] {
                if path.exists() {
                    fs::remove_file(path).expect("remove exact crash recovery fixture");
                }
            }
            fs::remove_dir(recovery_directory).expect("remove empty crash recovery directory");
            fs::remove_dir(directory).expect("remove empty crash fixture directory");
        }

        let fresh_directory = temporary_history_directory("recovery-genuine-first-start");
        let (fresh, health) = open_history_database_with_recovery(&fresh_directory)
            .expect("no marker and no live database is a genuine first start");
        assert_eq!(
            serde_json::to_value(health).expect("serialize genuine fresh health"),
            serde_json::json!({ "status": "healthy" })
        );
        drop(fresh);
        let live_path = fresh_directory.join("history.sqlite3");
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact genuine fresh fixture");
            }
        }
        fs::remove_dir(fresh_directory).expect("remove empty genuine fresh directory");
    }

    #[test]
    fn quarantined_notice_treats_partial_fresh_file_as_fresh_failure_not_new_corruption() {
        let directory = temporary_history_directory("recovery-partial-fresh");
        let live_path = directory.join("history.sqlite3");
        let recovery_directory = directory.join("history-recovery-partial-fresh");
        fs::create_dir(&recovery_directory).expect("create partial-fresh recovery directory");
        fs::write(
            recovery_directory.join("history.sqlite3"),
            b"original quarantined",
        )
        .expect("seed original quarantined database");
        let notice = RecoveryNotice {
            format_version: HISTORY_RECOVERY_NOTICE_VERSION,
            phase: RecoveryNoticePhase::Quarantined,
            reason: RecoveryReason::NotADatabase,
            quarantine_path: fs::canonicalize(&recovery_directory)
                .expect("canonical partial-fresh recovery directory")
                .to_str()
                .expect("Unicode partial-fresh path")
                .to_owned(),
        };
        write_recovery_notice(&directory, &notice).expect("write quarantined partial-fresh notice");
        fs::write(&live_path, b"partial fresh database").expect("seed failed partial fresh file");

        let health = open_history_database_with_recovery(&directory)
            .expect_err("partial fresh failure must remain read-only without second quarantine");
        assert_eq!(
            serde_json::to_value(health).expect("serialize partial-fresh health"),
            serde_json::json!({
                "status": "readOnlyError",
                "reason": "freshDatabaseFailed",
                "recoveryReason": "notADatabase",
                "quarantinePath": notice.quarantine_path,
            })
        );
        assert_eq!(
            fs::read(recovery_directory.join("history.sqlite3"))
                .expect("read untouched original quarantine"),
            b"original quarantined"
        );
        assert_eq!(
            fs::read_dir(&directory)
                .expect("list partial-fresh data directory")
                .filter_map(|entry| {
                    let entry = entry.ok()?;
                    entry.file_type().ok()?.is_dir().then_some(())
                })
                .count(),
            1
        );
        let persisted: RecoveryNotice = serde_json::from_slice(
            &fs::read(directory.join(HISTORY_RECOVERY_NOTICE_FILE))
                .expect("read preserved quarantined notice"),
        )
        .expect("parse preserved quarantined notice");
        assert_eq!(persisted.phase, RecoveryNoticePhase::Quarantined);

        for path in [
            live_path,
            directory.join(HISTORY_RECOVERY_NOTICE_FILE),
            recovery_directory.join("history.sqlite3"),
        ] {
            fs::remove_file(path).expect("remove exact partial-fresh fixture");
        }
        fs::remove_dir(recovery_directory).expect("remove empty partial-fresh recovery directory");
        fs::remove_dir(directory).expect("remove empty partial-fresh directory");
    }

    #[test]
    fn stale_recovered_notice_does_not_block_a_healthy_live_database() {
        let directory = temporary_history_directory("recovery-stale-completed");
        let live_path = directory.join("history.sqlite3");
        create_closed_restore_fixture(&live_path, "healthy-live-after-recovery");
        let recovery_directory = directory.join("history-recovery-user-deleted");
        fs::create_dir(&recovery_directory).expect("create stale recovery directory");
        fs::write(
            recovery_directory.join("history.sqlite3"),
            b"old quarantined",
        )
        .expect("seed stale quarantined file");
        let notice = RecoveryNotice {
            format_version: HISTORY_RECOVERY_NOTICE_VERSION,
            phase: RecoveryNoticePhase::Recovered,
            reason: RecoveryReason::Corrupt,
            quarantine_path: fs::canonicalize(&recovery_directory)
                .expect("canonical stale recovery directory")
                .to_str()
                .expect("Unicode stale recovery path")
                .to_owned(),
        };
        write_recovery_notice(&directory, &notice).expect("write recovered notice");
        fs::remove_file(recovery_directory.join("history.sqlite3"))
            .expect("simulate user deleting quarantined database");
        fs::remove_dir(&recovery_directory)
            .expect("simulate user deleting recovered quarantine directory");

        let (healthy, health) = open_history_database_with_recovery(&directory)
            .expect("stale recovered notice must not block healthy live database");
        assert!(get_clip_payload(&healthy, "healthy-live-after-recovery")
            .expect("read healthy live after stale notice")
            .is_some());
        assert_eq!(
            serde_json::to_value(health).expect("serialize stale-notice health"),
            serde_json::json!({ "status": "healthy" })
        );
        assert!(!directory.join(HISTORY_RECOVERY_NOTICE_FILE).exists());

        drop(healthy);
        for path in [
            live_path.clone(),
            path_with_suffix(&live_path, "-wal"),
            path_with_suffix(&live_path, "-shm"),
        ] {
            if path.exists() {
                fs::remove_file(path).expect("remove exact stale-notice fixture");
            }
        }
        fs::remove_dir(directory).expect("remove empty stale-notice directory");
    }

    #[test]
    fn schema_has_no_unused_content_hash_and_file_sizes_are_nonnegative() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize schema");
        let content_hash_columns: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name = 'content_hash'",
                [],
                |row| row.get(0),
            )
            .expect("inspect clip columns");
        assert_eq!(content_hash_columns, 0);
        assert!(database
            .execute(
                "INSERT INTO clips(id, kind, title, plain_text, source_app, copied_at, updated_at, pinned, permanent, search_terms, logical_bytes)
                 VALUES ('file', 'file', 'file', '', '', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0, '[]', 0)",
                [],
            )
            .is_ok());
        assert!(database
            .execute(
                "INSERT INTO clip_files(clip_id, ordinal, path, name, directory, exists_at_capture, size)
                 VALUES ('file', 0, 'C:\\x', 'x', 0, 1, -1)",
                [],
            )
            .is_err());
        database
            .execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("enable corrupt-row fixture");
        database
            .execute(
                "INSERT INTO clip_files(clip_id, ordinal, path, name, directory, exists_at_capture, size)
                 VALUES ('file', 1, 'C:\\broken', 'broken', 0, 1, -1)",
                [],
            )
            .expect("insert corrupt size fixture");
        assert!(get_clip_payload(&database, "file").is_err());
    }

    #[test]
    fn source_icon_sql_errors_are_not_silently_hidden() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut item = text_item("icon", "2026-07-01T00:00:00.000Z");
        item.source_app = "App".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![item], CapacityPolicy::default()),
        )
        .expect("store icon row");
        database
            .execute_batch("DROP TABLE source_app_icons")
            .expect("remove icon table");
        assert!(get_clip_payload(&database, "icon").is_err());
    }

    #[test]
    fn configuration_does_not_issue_journal_writes_while_another_writer_holds_the_database() {
        let path = temporary_database_path("configure-lock");
        let result = {
            let lock = Connection::open(&path).expect("open lock connection");
            lock.execute_batch("PRAGMA journal_mode = DELETE")
                .expect("use default journal mode fixture");
            lock.execute_batch("BEGIN IMMEDIATE")
                .expect("hold writer lock");
            let reader = Connection::open(&path).expect("open reader connection");
            configure_history_database_connection(&reader)
        };
        let mut verifier = Connection::open(&path).expect("open initializer connection");
        configure_history_database_connection(&verifier).expect("configure initializer connection");
        initialize_history_database(&mut verifier).expect("initialize WAL database");
        let journal_mode: String = verifier
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("read journal mode");
        drop(verifier);
        let wal_path = std::path::PathBuf::from(format!("{}-wal", path.display()));
        let shm_path = std::path::PathBuf::from(format!("{}-shm", path.display()));
        result.expect("configure current-schema reader without writer lock");
        assert_eq!(journal_mode, "wal");
        for cleanup_path in [&path, &wal_path, &shm_path] {
            if cleanup_path.exists() {
                fs::remove_file(cleanup_path).expect("remove temporary database file");
            }
            assert!(!cleanup_path.exists());
        }
    }

    #[test]
    fn source_icons_are_deduplicated_without_storing_data_urls_in_clip_rows() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let newest_icon = rgba_icon_data_url([77, 111, 206, 255]);
        let older_icon = rgba_icon_data_url([31, 51, 76, 255]);
        let mut newest = text_item("chrome-1", "2026-07-02T00:00:00.000Z");
        newest.source_app = "Google Chrome".into();
        newest.source_app_icon = Some(newest_icon.clone());
        let mut older = text_item("chrome-2", "2026-07-01T00:00:00.000Z");
        older.source_app = "Google Chrome".into();
        older.source_app_icon = Some(older_icon);

        apply_history_mutation(
            &mut database,
            mutation(vec![newest, older], CapacityPolicy::default()),
        )
        .expect("store source icon cache");

        let icon_count: i64 = database
            .query_row("SELECT COUNT(*) FROM source_app_icons", [], |row| {
                row.get(0)
            })
            .expect("count deduplicated icons");
        assert_eq!(icon_count, 1);
        let payloads = load_history(&database).expect("load history");
        assert_eq!(
            payloads[0].source_app_icon.as_deref(),
            Some(newest_icon.as_str())
        );
        assert_eq!(
            payloads[1].source_app_icon.as_deref(),
            Some(newest_icon.as_str())
        );
        let summaries = query_history(&database, HistoryQuery::default())
            .expect("query history summaries")
            .items;
        assert_eq!(
            summaries[0].source_app_icon.as_deref(),
            Some(newest_icon.as_str())
        );
        assert_eq!(
            summaries[1].source_app_icon.as_deref(),
            Some(newest_icon.as_str())
        );
        assert!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('clips') WHERE name = 'payload'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("inspect normalized clip columns")
                == 0
        );
    }

    #[test]
    fn image_blobs_round_trip_independently_from_source_icons() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let icon = rgba_icon_data_url([77, 111, 206, 255]);
        let mut image = image_item("image-1", "2026-07-01T00:00:00.000Z", b"Man");
        image.source_app = "Snipping Tool".into();
        image.source_app_icon = Some(icon.clone());

        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("text-1", "2026-07-02T00:00:00.000Z"), image],
                CapacityPolicy::default(),
            ),
        )
        .expect("store history with image");

        let image_bytes: Vec<u8> = database
            .query_row(
                "SELECT data FROM clip_formats WHERE clip_id = 'image-1' AND format = 'image'",
                [],
                |row| row.get(0),
            )
            .expect("read image blob");
        assert_eq!(image_bytes, b"Man");
        let loaded = get_clip_payload(&database, "image-1")
            .expect("load image payload")
            .expect("image row exists");
        assert_eq!(
            loaded.image_url.as_deref(),
            Some("data:image/png;base64,TWFu")
        );
        assert_eq!(loaded.source_app_icon.as_deref(), Some(icon.as_str()));
    }

    #[test]
    fn invalid_image_payload_does_not_reject_history_mutation_or_create_thumbnail() {
        let mut database = Connection::open_in_memory().expect("in-memory database");

        apply_history_mutation(
            &mut database,
            mutation(
                vec![image_item(
                    "invalid-thumbnail-source",
                    "2026-07-01T00:00:00.000Z",
                    b"not a PNG",
                )],
                CapacityPolicy::default(),
            ),
        )
        .expect("store image even when thumbnail generation fails");

        assert!(get_clip_payload(&database, "invalid-thumbnail-source")
            .expect("load invalid image payload")
            .is_some());
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_thumbnails WHERE clip_id = 'invalid-thumbnail-source'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count invalid-source thumbnails"),
            0
        );
    }

    #[test]
    fn thumbnail_insert_failure_does_not_reject_a_new_image_mutation() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize thumbnail schema");
        database
            .execute_batch(
                "CREATE TRIGGER reject_thumbnail_insert BEFORE INSERT ON clip_thumbnails BEGIN
                   SELECT RAISE(ABORT, 'injected thumbnail insert failure');
                 END;",
            )
            .expect("install thumbnail failure trigger");
        let png = rgba_png_bytes([18, 52, 86, 255]);

        let result = apply_history_mutation(
            &mut database,
            mutation(
                vec![image_item(
                    "new-thumbnail-failure",
                    "2026-07-01T00:00:00.000Z",
                    &png,
                )],
                CapacityPolicy::default(),
            ),
        );

        assert!(result.is_ok(), "thumbnail cache must be best-effort");
        assert_eq!(
            database
                .query_row(
                    "SELECT data FROM clip_formats
                     WHERE clip_id = 'new-thumbnail-failure' AND format = 'image'",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .expect("read committed new image"),
            png
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_thumbnails
                     WHERE clip_id = 'new-thumbnail-failure'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count failed new thumbnail cache"),
            0
        );
    }

    #[test]
    fn thumbnail_insert_failure_commits_replacement_and_keeps_old_cache_invalidated() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(
            &mut database,
            "replacement-thumbnail-failure",
            [17, 34, 51, 255],
        );
        database
            .execute_batch(
                "CREATE TRIGGER reject_replacement_thumbnail BEFORE INSERT ON clip_thumbnails BEGIN
                   SELECT RAISE(ABORT, 'injected replacement thumbnail failure');
                 END;",
            )
            .expect("install replacement thumbnail failure trigger");
        let replacement_png = rgba_png_bytes([68, 85, 102, 255]);

        let result = apply_history_mutation(
            &mut database,
            mutation(
                vec![image_item(
                    "replacement-thumbnail-failure",
                    "2026-07-02T00:00:00.000Z",
                    &replacement_png,
                )],
                CapacityPolicy::default(),
            ),
        );

        assert!(result.is_ok(), "replacement payload must commit");
        assert_eq!(
            database
                .query_row(
                    "SELECT data FROM clip_formats
                     WHERE clip_id = 'replacement-thumbnail-failure' AND format = 'image'",
                    [],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .expect("read committed replacement image"),
            replacement_png
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_thumbnails
                     WHERE clip_id = 'replacement-thumbnail-failure'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count invalidated replacement cache"),
            0
        );
    }

    #[test]
    fn image_upsert_pre_generates_a_bounded_png_thumbnail() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "thumbnail-image", [77, 111, 206, 255]);

        let cached: Vec<u8> = database
            .query_row(
                "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = 'thumbnail-image'",
                [],
                |row| row.get(0),
            )
            .expect("read pre-generated thumbnail");
        let thumbnail = format!("data:image/png;base64,{}", STANDARD.encode(&cached));
        assert!(thumbnail.starts_with("data:image/png;base64,"));
        let thumbnail_image = image::load_from_memory_with_format(&cached, ImageFormat::Png)
            .expect("decode thumbnail PNG");
        assert!(thumbnail_image.width() <= HISTORY_THUMBNAIL_MAX_DIMENSION);
        assert!(thumbnail_image.height() <= HISTORY_THUMBNAIL_MAX_DIMENSION);
    }

    #[test]
    fn missing_thumbnail_request_lazily_backfills_the_cache() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "lazy-thumbnail", [77, 111, 206, 255]);
        database
            .execute(
                "DELETE FROM clip_thumbnails WHERE clip_id = 'lazy-thumbnail'",
                [],
            )
            .expect("remove pre-generated thumbnail to simulate v10 row");

        let thumbnail = get_clip_thumbnail(&database, "lazy-thumbnail")
            .expect("generate lazy thumbnail")
            .expect("image has thumbnail");

        let persisted: Vec<u8> = database
            .query_row(
                "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = 'lazy-thumbnail'",
                [],
                |row| row.get(0),
            )
            .expect("read lazily persisted thumbnail");
        assert_eq!(
            thumbnail,
            format!("data:image/png;base64,{}", STANDARD.encode(persisted))
        );
    }

    #[test]
    fn cached_thumbnail_is_returned_when_original_image_becomes_unreadable() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "cached-thumbnail", [31, 51, 76, 255]);
        let expected = get_clip_thumbnail(&database, "cached-thumbnail")
            .expect("read pre-generated thumbnail")
            .expect("cached image has thumbnail");
        database
            .execute(
                "UPDATE clip_formats SET data = ?1
                 WHERE clip_id = 'cached-thumbnail' AND format = 'image'",
                [b"not a readable PNG".as_slice()],
            )
            .expect("corrupt original image fixture");

        assert_eq!(
            get_clip_thumbnail(&database, "cached-thumbnail")
                .expect("read thumbnail without original decode")
                .as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn deleting_an_image_cascades_to_its_thumbnail() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "delete-thumbnail", [77, 111, 206, 255]);

        apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: Vec::new(),
                delete_ids: vec!["delete-thumbnail".into()],
                policy: CapacityPolicy::default(),
            },
        )
        .expect("delete image");

        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_thumbnails WHERE clip_id = 'delete-thumbnail'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count thumbnails after cascade"),
            0
        );
    }

    #[test]
    fn replacing_an_image_with_text_removes_the_stale_thumbnail() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "replace-thumbnail", [77, 111, 206, 255]);

        apply_history_mutation(
            &mut database,
            mutation(
                vec![text_item("replace-thumbnail", "2026-07-02T00:00:00.000Z")],
                CapacityPolicy::default(),
            ),
        )
        .expect("replace image with text");

        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_thumbnails WHERE clip_id = 'replace-thumbnail'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("count stale replacement thumbnails"),
            0
        );
    }

    #[test]
    fn malformed_cached_thumbnail_is_regenerated_from_the_original() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "malformed-thumbnail", [90, 120, 150, 255]);
        database
            .execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("allow malformed cache fixture");
        database
            .execute(
                "UPDATE clip_thumbnails SET thumbnail_png = 'not a PNG'
                 WHERE clip_id = 'malformed-thumbnail'",
                [],
            )
            .expect("inject malformed cached thumbnail");

        let regenerated = get_clip_thumbnail(&database, "malformed-thumbnail")
            .expect("regenerate malformed cache")
            .expect("regenerated thumbnail");

        let cached: Vec<u8> = database
            .query_row(
                "SELECT thumbnail_png FROM clip_thumbnails WHERE clip_id = 'malformed-thumbnail'",
                [],
                |row| row.get(0),
            )
            .expect("read repaired thumbnail cache");
        assert_eq!(
            regenerated,
            format!("data:image/png;base64,{}", STANDARD.encode(cached))
        );
    }

    #[test]
    fn oversized_cached_thumbnail_is_regenerated_within_the_storage_bound() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        store_png_image(&mut database, "oversized-thumbnail", [21, 42, 84, 255]);
        database
            .execute_batch("PRAGMA ignore_check_constraints = ON")
            .expect("allow oversized cache fixture");
        database
            .execute(
                "UPDATE clip_thumbnails SET thumbnail_png = ?1
                 WHERE clip_id = 'oversized-thumbnail'",
                [vec![0_u8; 2 * 1024 * 1024]],
            )
            .expect("inject oversized cached thumbnail");

        get_clip_thumbnail(&database, "oversized-thumbnail")
            .expect("regenerate oversized cache")
            .expect("regenerated thumbnail");

        let cached_length: i64 = database
            .query_row(
                "SELECT length(thumbnail_png) FROM clip_thumbnails
                 WHERE clip_id = 'oversized-thumbnail'",
                [],
                |row| row.get(0),
            )
            .expect("read repaired thumbnail length");
        assert!((1..=64 * 1024).contains(&cached_length));
    }

    #[test]
    fn thumbnail_request_for_missing_clip_returns_none() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize database");

        assert_eq!(
            get_clip_thumbnail(&database, "missing").expect("missing row"),
            None
        );
    }

    #[test]
    fn invalid_source_icons_never_overwrite_a_valid_cached_icon() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let valid_icon = rgba_icon_data_url([77, 111, 206, 255]);
        let mut first = text_item("cached", "2026-07-01T00:00:00.000Z");
        first.source_app = "Cached App".into();
        first.source_app_icon = Some(valid_icon.clone());
        apply_history_mutation(
            &mut database,
            mutation(vec![first], CapacityPolicy::default()),
        )
        .expect("prime valid cache");

        let mut invalid = text_item("cached", "2026-07-02T00:00:00.000Z");
        invalid.source_app = "Cached App".into();
        invalid.source_app_icon = Some("data:image/png;base64,not-valid-base64".into());
        apply_history_mutation(
            &mut database,
            mutation(vec![invalid], CapacityPolicy::default()),
        )
        .expect("upsert invalid icon without replacing cache");

        let loaded = get_clip_payload(&database, "cached")
            .expect("load cached row")
            .expect("cached row exists");
        assert_eq!(loaded.source_app_icon.as_deref(), Some(valid_icon.as_str()));
    }

    #[test]
    fn load_skips_corrupt_and_oversized_cached_source_icons() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let valid_icon = rgba_icon_data_url([77, 111, 206, 255]);
        let mut valid = text_item("valid", "2026-07-03T00:00:00.000Z");
        valid.source_app = "Valid".into();
        valid.source_app_icon = Some(valid_icon.clone());
        let mut corrupt = text_item("corrupt", "2026-07-02T00:00:00.000Z");
        corrupt.source_app = "Corrupt".into();
        let mut oversized = text_item("oversized", "2026-07-01T00:00:00.000Z");
        oversized.source_app = "Oversized".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![valid, corrupt, oversized], CapacityPolicy::default()),
        )
        .expect("store history rows");
        database
            .execute_batch(
                "DROP TABLE source_app_icons;
                 CREATE TABLE source_app_icons (
                   source_app TEXT PRIMARY KEY NOT NULL,
                   icon_png BLOB NOT NULL
                 );",
            )
            .expect("replace icon table with a corrupt fixture");
        let valid_icon_bytes = STANDARD
            .decode(
                valid_icon
                    .strip_prefix("data:image/png;base64,")
                    .expect("data URL"),
            )
            .expect("decode valid icon");
        database
            .execute(
                "INSERT INTO source_app_icons(source_app, icon_png) VALUES ('Valid', ?1)",
                params![valid_icon_bytes],
            )
            .expect("insert valid icon");
        database
            .execute(
                "INSERT INTO source_app_icons(source_app, icon_png) VALUES ('Corrupt', ?1)",
                params![b"not a PNG".as_slice()],
            )
            .expect("insert corrupt icon");
        database
            .execute(
                "INSERT INTO source_app_icons(source_app, icon_png) VALUES ('Oversized', ?1)",
                params![vec![0_u8; 32 * 1024 + 1]],
            )
            .expect("insert oversized icon");

        let loaded = load_history(&database).expect("load history safely");
        assert_eq!(loaded.len(), 3);
        let icon_for = |id: &str| {
            loaded
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.source_app_icon.as_deref())
        };
        assert_eq!(icon_for("valid"), Some(valid_icon.as_str()));
        assert_eq!(icon_for("corrupt"), None);
        assert_eq!(icon_for("oversized"), None);
    }

    #[test]
    fn history_connections_keep_the_existing_two_second_busy_timeout() {
        let database = Connection::open_in_memory().expect("in-memory database");

        configure_history_database_connection(&database).expect("configure connection");

        assert_eq!(pragma_i64(&database, "busy_timeout"), 2_000);
    }

    #[test]
    fn fresh_current_schema_proves_bundled_trigram_fts5_support() {
        let mut database = Connection::open_in_memory().expect("in-memory database");

        initialize_history_database(&mut database).expect("initialize current schema");

        assert_eq!(pragma_i64(&database, "user_version"), SCHEMA_VERSION);
        assert!(table_exists(&database, "clip_search"));
        assert!(table_exists(&database, "clip_search_fts"));
        let fts_sql: String = database
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name = 'clip_search_fts'",
                [],
                |row| row.get(0),
            )
            .expect("read FTS definition");
        assert!(fts_sql.contains("fts5"));
        assert!(fts_sql.contains("trigram"));
        database
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, logical_bytes, omitted_formats
                 ) VALUES (
                   'probe', 'text', 'Probe', 'probe', 'Test',
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0,
                   '[]', 5, '[]'
                 )",
                [],
            )
            .expect("insert trigram parent row");
        database
            .execute(
                "INSERT INTO clip_search(clip_id, normalized_text) VALUES ('probe', 'quickpaste trigram probe')",
                [],
            )
            .expect("index trigram probe");
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_search_fts WHERE clip_search_fts MATCH ?1",
                    ["\"trigram\""],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query bundled trigram tokenizer"),
            1
        );
    }

    #[test]
    fn v5_search_migration_backfills_rows_and_rolls_back_an_injected_failure() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        create_v5_schema(&mut database);
        database
            .execute(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, ocr_text, logical_bytes, omitted_formats
                 ) VALUES (
                   'v5-row', 'file', '全角 ＡＢＣ', '火箭计划', 'Explorer',
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0,
                   '[\"huojian\",\"hj\"]', '扫描文字', 12, '[]'
                 )",
                [],
            )
            .expect("insert v5 clip");
        database
            .execute(
                "INSERT INTO clip_files(
                   clip_id, ordinal, path, name, directory, exists_at_capture
                 ) VALUES ('v5-row', 0, 'C:\\资料\\季度报表.xlsx', '季度报表.xlsx', 0, 1)",
                [],
            )
            .expect("insert v5 file");

        initialize_history_database(&mut database).expect("migrate and backfill search");
        let projection: String = database
            .query_row(
                "SELECT normalized_text FROM clip_search WHERE clip_id = 'v5-row'",
                [],
                |row| row.get(0),
            )
            .expect("read backfilled projection");
        for expected in ["全角 abc", "火箭计划", "huojian", "hj", "季度报表.xlsx"] {
            assert!(
                projection.contains(expected),
                "missing {expected}: {projection}"
            );
        }
        assert!(!projection.contains("扫描文字"));
        assert_eq!(
            database
                .query_row(
                    "SELECT ocr_text IS NULL AND ocr_status IS NULL FROM clips WHERE id = 'v5-row'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("legacy OCR is normalized during v9 migration"),
            1
        );

        let mut failing = Connection::open_in_memory().expect("in-memory failure database");
        create_v5_schema(&mut failing);
        failing
            .execute_batch(
                "INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, logical_bytes, omitted_formats
                 ) VALUES (
                   'a-preserved', 'text', 'Preserved', 'first body', 'Test',
                   '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0, 0,
                   '[]', 10, '[]'
                 );
                 INSERT INTO clips(
                   id, kind, title, plain_text, source_app, copied_at, updated_at, pinned,
                   permanent, search_terms, logical_bytes, omitted_formats
                 ) VALUES (
                   'z-malformed', 'text', 'Malformed', 'second body', 'Test',
                   '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z', 0, 0,
                   '{not-json', 11, '[]'
                 );",
            )
            .expect("insert v5 rows with a later malformed search projection");

        assert!(initialize_history_database(&mut failing).is_err());
        assert_eq!(pragma_i64(&failing, "user_version"), 5);
        for object in [
            "clip_search",
            "clip_search_fts",
            "clip_search_after_insert",
            "clip_search_after_delete",
            "clip_search_after_update",
            "clips_kind_source_age",
            "clips_source_age",
            "clips_pinned_age",
            "clips_collection_pinned_age",
        ] {
            assert_eq!(
                failing
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                        [object],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("inspect rolled-back v6 object"),
                0,
                "v6 object survived rollback: {object}"
            );
        }
        assert_eq!(
            failing
                .query_row(
                    "SELECT COUNT(*) FROM clips
                     WHERE (id = 'a-preserved' AND plain_text = 'first body')
                        OR (id = 'z-malformed' AND plain_text = 'second body')",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("preserved both prior-version rows"),
            2
        );
    }

    #[test]
    fn rust_query_normalization_mirrors_the_typescript_contract() {
        let canonical_cursor = STANDARD.encode("1\nclip-id");
        let normalized = normalize_history_query(HistoryQuery {
            text: "  全角 ＡＢＣ  ".into(),
            kinds: vec!["link".into(), "text".into(), "link".into()],
            source_apps: vec![
                " Word ".into(),
                "Edge".into(),
                "\u{feff}Word\u{0085}".into(),
                "\u{feff}\u{0085}".into(),
            ],
            collection: CollectionScope::Collection {
                id: "\u{feff}collection-1\u{0085}".into(),
            },
            pinned: Some(false),
            permanent: Some(true),
            limit: 50,
            cursor: Some(canonical_cursor.clone()),
        })
        .expect("normalize query");

        assert_eq!(normalized.text, "全角 abc");
        assert_eq!(normalized.kinds, vec!["text", "link"]);
        assert_eq!(normalized.source_apps, vec!["Edge", "Word"]);
        assert_eq!(
            normalized.cursor.as_deref(),
            Some(canonical_cursor.as_str())
        );
        assert_eq!(
            normalized.collection,
            CollectionScope::Collection {
                id: "collection-1".into()
            }
        );
        for invalid in [
            CollectionScope::Collection { id: " ".into() },
            CollectionScope::Collection {
                id: "contains spaces".into(),
            },
            CollectionScope::Collection {
                id: "x".repeat(129),
            },
        ] {
            assert!(normalize_history_query(HistoryQuery {
                collection: invalid,
                ..HistoryQuery::default()
            })
            .is_err());
        }
        for limit in [0, 201] {
            assert!(normalize_history_query(HistoryQuery {
                limit,
                ..HistoryQuery::default()
            })
            .is_err());
        }
        for invalid_cursor in [
            "not-base64".to_owned(),
            format!("{canonical_cursor}="),
            STANDARD.encode("1-no-newline"),
            STANDARD.encode("1\nid\nextra"),
            STANDARD.encode("1\nid\u{0007}"),
            STANDARD.encode("1\n padded"),
            STANDARD.encode("1\npadded "),
            STANDARD.encode("1\n\u{feff}padded"),
            STANDARD.encode("1\npadded\u{0085}"),
            STANDARD.encode("1\n"),
            STANDARD.encode("01\nid"),
            STANDARD.encode("not-millis\nid"),
            STANDARD.encode(format!("{}\nid", i64::MAX)),
            STANDARD.encode(format!("1\n{}", "x".repeat(600))),
        ] {
            assert!(normalize_history_query(HistoryQuery {
                cursor: Some(invalid_cursor),
                ..HistoryQuery::default()
            })
            .is_err());
        }
        assert_eq!(
            normalize_history_query(HistoryQuery {
                text: "  ΟΣ\u{00a0}ος  ".into(),
                ..HistoryQuery::default()
            })
            .expect("normalize final sigma")
            .text,
            "οσ οσ"
        );
        let unicode_edges = normalize_history_query(HistoryQuery {
            text: "\u{feff}ＡＢＣ\u{0085}Delta\u{feff}".into(),
            source_apps: vec!["\u{e000}".into(), "😀".into()],
            ..HistoryQuery::default()
        })
        .expect("normalize Unicode whitespace and UTF-16 ordering");
        assert_eq!(unicode_edges.text, "abc delta");
        assert_eq!(unicode_edges.source_apps, vec!["😀", "\u{e000}"]);
        assert_eq!(normalize_query_text("a\u{0085}b"), "a b");
    }

    #[test]
    fn fts_search_covers_nfkc_case_pinyin_ocr_files_and_multi_term_and() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize schema");
        for (id, name) in [("work", "工作"), ("personal", "个人")] {
            database
                .execute(
                    "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                     VALUES (?1, ?2, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 0)",
                    params![id, name],
                )
                .expect("insert collection");
        }

        let mut rich = text_item("rich", "2026-07-04T00:00:00.000Z");
        rich.title = "全角 ＡＢＣ 发布".into();
        rich.content = "火箭发射计划包含 alpha 与 BETA".into();
        rich.source_app = "Microsoft Word".into();
        rich.search_terms = vec!["huojian".into(), "hj".into()];
        rich.collection_id = Some("work".into());
        rich.pinned = true;
        rich.permanent = true;

        let mut file = text_item("file", "2026-07-03T00:00:00.000Z");
        file.kind = "file".into();
        file.title = "季度文件".into();
        file.content = "文件剪贴板".into();
        file.source_app = "Explorer".into();
        file.formats = vec!["files".into()];
        file.search_terms.clear();
        file.files = vec![ClipboardFile {
            path: r"C:\资料\季度报表.xlsx".into(),
            name: "季度报表.xlsx".into(),
            extension: Some("xlsx".into()),
            size: Some(42),
            modified_at: None,
            directory: false,
            exists: true,
        }];

        let mut image = image_item("ocr", "2026-07-02T00:00:00.000Z", b"PNG");
        image.title = "票据图片".into();
        image.source_app = "Snipping Tool".into();
        image.search_terms = vec!["tupian".into()];
        image.ocr_text = Some("发票号码 12345".into());
        image.ocr_status = Some("completed".into());
        image.image_hash = Some("d".repeat(64));
        image.collection_id = Some("personal".into());

        let mut code = text_item("code", "2026-07-01T00:00:00.000Z");
        code.kind = "code".into();
        code.title = "alpha helper".into();
        code.content = "unrelated source".into();
        code.source_app = "Visual Studio Code".into();
        code.collection_id = Some("work".into());

        apply_history_mutation(
            &mut database,
            mutation(vec![rich, file, image, code], CapacityPolicy::default()),
        )
        .expect("seed searchable rows");

        for term in ["abc", "BETA", "火箭", "huojian", "hj"] {
            assert_eq!(
                query_ids(&database, history_query(term)),
                vec!["rich"],
                "{term}"
            );
        }
        assert_eq!(
            query_ids(&database, history_query("火箭 beta")),
            vec!["rich"],
            "separate normalized terms must use AND semantics"
        );
        assert_eq!(
            query_ids(&database, history_query("季度报表")),
            vec!["file"]
        );
        let ocr_match = query_history(&database, history_query("发票号码"))
            .expect("query OCR source")
            .items
            .pop()
            .expect("OCR match");
        assert_eq!(ocr_match.id, "ocr");
        assert_eq!(ocr_match.match_source, Some(HistoryMatchSource::Ocr));
        assert!(ocr_match.ocr_text.is_none());
        assert_eq!(
            query_history(&database, history_query("tupian"))
                .expect("query pinyin source")
                .items[0]
                .match_source,
            Some(HistoryMatchSource::Index)
        );
        assert_eq!(
            query_history(&database, history_query("票据"))
                .expect("query visible source")
                .items[0]
                .match_source,
            Some(HistoryMatchSource::Direct)
        );
        assert_eq!(
            query_history(&database, history_query(""))
                .expect("query without text")
                .items[0]
                .match_source,
            Some(HistoryMatchSource::None)
        );

        assert_eq!(
            query_ids(&database, history_query("")),
            vec!["rich", "file", "ocr", "code"]
        );
        assert_eq!(
            query_ids(
                &database,
                HistoryQuery {
                    collection: CollectionScope::Unfiled {},
                    ..history_query("")
                }
            ),
            vec!["file"]
        );
        assert_eq!(
            query_ids(
                &database,
                HistoryQuery {
                    collection: CollectionScope::Collection { id: "work".into() },
                    ..history_query("")
                }
            ),
            vec!["rich", "code"]
        );
        assert_eq!(
            query_ids(
                &database,
                HistoryQuery {
                    kinds: vec!["text".into()],
                    source_apps: vec!["Microsoft Word".into()],
                    collection: CollectionScope::Collection { id: "work".into() },
                    pinned: Some(true),
                    ..history_query("alpha")
                }
            ),
            vec!["rich"]
        );
        assert_eq!(
            query_ids(
                &database,
                HistoryQuery {
                    permanent: Some(true),
                    ..history_query("")
                }
            ),
            vec!["rich"]
        );
    }

    #[test]
    fn match_and_like_metacharacters_are_literal_and_injection_safe() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut literal = text_item("literal", "2026-07-02T00:00:00.000Z");
        literal.title = "alpha and quoted \"value\"".into();
        literal.content = "beta includes 100% and under_score plus back\\slash C++".into();
        literal.search_terms = vec!["OR".into()];
        let mut ordinary = text_item("ordinary", "2026-07-01T00:00:00.000Z");
        ordinary.title = "plain row".into();
        ordinary.content = "nothing special".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![literal, ordinary], CapacityPolicy::default()),
        )
        .expect("seed literal rows");

        for term in ["100%", "_", "%", "\\", "C++", "\"value\""] {
            assert_eq!(
                query_ids(&database, history_query(term)),
                vec!["literal"],
                "{term:?}"
            );
        }
        assert_eq!(
            query_ids(&database, history_query("alpha OR beta")),
            vec!["literal"]
        );
        for hostile in ["x' OR 1=1 --", "\" OR *", "NEAR(alpha beta)"] {
            assert!(query_ids(&database, history_query(hostile)).is_empty());
        }
    }

    #[test]
    fn full_summary_and_delete_mutations_keep_search_atomic_without_touching_payload() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut item = text_item("mutable", "2026-07-01T00:00:00.000Z");
        item.content = "oldterm original payload".into();
        item.search_terms = vec!["preserved-pinyin".into()];
        apply_history_mutation(
            &mut database,
            mutation(vec![item], CapacityPolicy::default()),
        )
        .expect("insert indexed row");
        assert_eq!(
            query_ids(&database, history_query("oldterm")),
            vec!["mutable"]
        );
        assert_eq!(
            database
                .query_row(
                    "SELECT COUNT(*) FROM clip_search WHERE clip_id = 'mutable'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .expect("projection row"),
            1
        );

        let mut full = get_clip_payload(&database, "mutable")
            .expect("load payload")
            .expect("payload exists");
        full.content = "newterm original payload".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![full], CapacityPolicy::default()),
        )
        .expect("update full payload index");
        assert!(query_ids(&database, history_query("oldterm")).is_empty());
        assert_eq!(
            query_ids(&database, history_query("newterm")),
            vec!["mutable"]
        );

        let mut summary = query_history(&database, history_query("newterm"))
            .expect("query summary")
            .items
            .pop()
            .expect("summary exists");
        assert!(summary.search_terms.is_empty());
        assert!(summary.ocr_text.is_none());
        summary.title = "summaryterm".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![summary], CapacityPolicy::default()),
        )
        .expect("update summary index");
        for term in ["summaryterm", "newterm", "preserved-pinyin"] {
            assert_eq!(
                query_ids(&database, history_query(term)),
                vec!["mutable"],
                "{term}"
            );
        }
        let reloaded = get_clip_payload(&database, "mutable")
            .expect("reload payload")
            .expect("payload exists");
        assert_eq!(reloaded.content, "newterm original payload");
        assert_eq!(reloaded.search_terms, vec!["preserved-pinyin"]);
        assert!(reloaded.ocr_text.is_none());

        apply_history_mutation(
            &mut database,
            HistoryMutation {
                upserts: Vec::new(),
                delete_ids: vec!["mutable".into()],
                policy: CapacityPolicy::default(),
            },
        )
        .expect("delete indexed row");
        assert!(query_ids(&database, history_query("summaryterm")).is_empty());
        assert_eq!(
            database
                .query_row("SELECT COUNT(*) FROM clip_search", [], |row| row
                    .get::<_, i64>(0))
                .expect("empty projection"),
            0
        );
        database
            .execute(
                "INSERT INTO clip_search_fts(clip_search_fts) VALUES ('integrity-check')",
                [],
            )
            .expect("FTS integrity check");
    }

    #[test]
    fn projection_failure_rolls_back_the_full_payload_and_search_update() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut original = text_item("atomic", "2026-07-01T00:00:00.000Z");
        original.content = "before atomic payload".into();
        apply_history_mutation(
            &mut database,
            mutation(vec![original], CapacityPolicy::default()),
        )
        .expect("seed atomic row");
        database
            .execute_batch(
                "CREATE TRIGGER fail_atomic_projection
                 BEFORE UPDATE OF normalized_text ON clip_search
                 WHEN new.clip_id = 'atomic'
                 BEGIN
                   SELECT RAISE(ABORT, 'injected projection failure');
                 END;",
            )
            .expect("inject projection failure");

        let mut update = get_clip_payload(&database, "atomic")
            .expect("load original")
            .expect("original exists");
        update.content = "after atomic payload".into();
        assert!(apply_history_mutation(
            &mut database,
            mutation(vec![update], CapacityPolicy::default()),
        )
        .is_err());

        let preserved = get_clip_payload(&database, "atomic")
            .expect("reload preserved")
            .expect("preserved exists");
        assert_eq!(preserved.content, "before atomic payload");
        assert_eq!(
            query_ids(&database, history_query("before")),
            vec!["atomic"]
        );
        assert!(query_ids(&database, history_query("after")).is_empty());
    }

    #[test]
    fn summary_mutations_reject_every_forbidden_payload_field_atomically() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut original = text_item("strict-summary", "2026-07-01T00:00:00.000Z");
        original.source_app = "Strict Summary App".into();
        original.source_app_icon = Some(rgba_icon_data_url([23, 45, 67, 255]));
        original.search_terms = vec!["preserved-search".into()];
        original.formats = vec!["text".into(), "html".into(), "rtf".into()];
        original.html = Some("<b>preserved HTML</b>".into());
        original.rtf_base64 = Some(STANDARD.encode(b"{\\rtf1 preserved}"));
        apply_history_mutation(
            &mut database,
            mutation(vec![original], CapacityPolicy::default()),
        )
        .expect("store strict summary fixture");
        let summary = query_history(&database, HistoryQuery::default())
            .expect("query strict summary")
            .items
            .pop()
            .expect("summary exists");
        let full_before = serde_json::to_value(
            get_clip_payload(&database, "strict-summary")
                .expect("load original")
                .expect("original exists"),
        )
        .expect("serialize original");
        let projection_before: String = database
            .query_row(
                "SELECT normalized_text FROM clip_search WHERE clip_id = 'strict-summary'",
                [],
                |row| row.get(0),
            )
            .expect("load original projection");

        for forbidden in [
            "sourceAppIcon",
            "html",
            "rtfBase64",
            "imageUrl",
            "ocrText",
            "searchTerms",
        ] {
            let mut update = summary.clone();
            update.title = format!("must rollback {forbidden}");
            match forbidden {
                "sourceAppIcon" => {
                    update.source_app_icon = Some(rgba_icon_data_url([89, 12, 34, 255]));
                }
                "html" => update.html = Some("<i>forbidden</i>".into()),
                "rtfBase64" => update.rtf_base64 = Some(STANDARD.encode(b"forbidden RTF")),
                "imageUrl" => update.image_url = Some("data:image/png;base64,UE5H".into()),
                "ocrText" => update.ocr_text = Some("forbidden OCR".into()),
                "searchTerms" => update.search_terms = vec!["forbidden-search".into()],
                _ => unreachable!(),
            }
            assert!(
                apply_history_mutation(
                    &mut database,
                    mutation(vec![update], CapacityPolicy::default()),
                )
                .is_err(),
                "summary unexpectedly accepted {forbidden}"
            );
            assert_eq!(
                serde_json::to_value(
                    get_clip_payload(&database, "strict-summary")
                        .expect("reload original")
                        .expect("original remains"),
                )
                .expect("serialize preserved payload"),
                full_before,
                "payload changed after rejecting {forbidden}"
            );
            assert_eq!(
                database
                    .query_row(
                        "SELECT normalized_text FROM clip_search WHERE clip_id = 'strict-summary'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .expect("reload projection"),
                projection_before,
                "projection changed after rejecting {forbidden}"
            );
        }
    }

    #[test]
    fn summary_and_full_payloads_serialize_with_exact_shape_allowlists() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize schema");
        database
            .execute(
                "INSERT INTO collections(id, name, created_at, updated_at, sort_order)
                 VALUES ('rich', 'Rich', '2026-07-01T00:00:00.000Z',
                         '2026-07-01T00:00:00.000Z', 0)",
                [],
            )
            .expect("insert collection");

        let mut minimal = text_item("minimal-shape", "2026-07-01T00:00:00.000Z");
        minimal.source_app = "Minimal App".into();
        let mut rich = text_item("rich-shape", "2026-07-02T00:00:00.000Z");
        rich.source_app = "Rich App".into();
        rich.source_app_icon = Some(rgba_icon_data_url([12, 34, 56, 255]));
        rich.collection_id = Some("rich".into());
        rich.color = Some("#123456".into());
        rich.dimensions = Some("40x20".into());
        rich.formats = vec!["text".into(), "html".into(), "rtf".into()];
        rich.omitted_formats = vec![ClipboardFormat::Image];
        rich.html = Some("<b>rich HTML</b>".into());
        rich.rtf_base64 = Some(STANDARD.encode(b"{\\rtf1 rich}"));

        let mut image = image_item("image-shape", "2026-07-03T00:00:00.000Z", b"IMAGE");
        image.source_app = "Image App".into();
        image.source_app_icon = Some(rgba_icon_data_url([67, 89, 123, 255]));
        image.collection_id = Some("rich".into());
        image.ocr_text = Some("image OCR".into());
        image.ocr_status = Some("completed".into());
        image.image_hash = Some("e".repeat(64));
        image.color = Some("#abcdef".into());
        image.dimensions = Some("1x1".into());
        image.omitted_formats = vec![
            ClipboardFormat::Text,
            ClipboardFormat::Html,
            ClipboardFormat::Rtf,
        ];
        apply_history_mutation(
            &mut database,
            mutation(vec![minimal, rich, image], CapacityPolicy::default()),
        )
        .expect("store exact-shape fixtures");

        let summaries = query_history(&database, HistoryQuery::default())
            .expect("query summaries")
            .items
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            serialized_object_keys(&summaries["minimal-shape"]),
            expected_item_keys(&["matchSource"])
        );
        let rich_summary_optional = [
            "collectionId",
            "color",
            "dimensions",
            "omittedFormats",
            "matchSource",
            "sourceAppIcon",
        ];
        assert_eq!(
            serialized_object_keys(&summaries["rich-shape"]),
            expected_item_keys(&rich_summary_optional)
        );
        assert_eq!(
            serialized_object_keys(&summaries["image-shape"]),
            expected_item_keys(&[
                "collectionId",
                "ocrStatus",
                "imageHash",
                "matchSource",
                "color",
                "dimensions",
                "omittedFormats",
                "sourceAppIcon",
            ])
        );
        assert!(summaries["minimal-shape"].source_app_icon.is_none());
        assert!(summaries["rich-shape"].source_app_icon.is_some());
        assert!(summaries["image-shape"].source_app_icon.is_some());

        let minimal_full = get_clip_payload(&database, "minimal-shape")
            .expect("minimal payload")
            .expect("minimal exists");
        assert_eq!(
            serialized_object_keys(&minimal_full),
            expected_item_keys(&[])
        );
        let rich_full = get_clip_payload(&database, "rich-shape")
            .expect("rich payload")
            .expect("rich exists");
        assert_eq!(
            serialized_object_keys(&rich_full),
            expected_item_keys(&[
                "collectionId",
                "color",
                "dimensions",
                "omittedFormats",
                "sourceAppIcon",
                "html",
                "rtfBase64",
            ])
        );
        let image_full = get_clip_payload(&database, "image-shape")
            .expect("image payload")
            .expect("image exists");
        assert_eq!(
            serialized_object_keys(&image_full),
            expected_item_keys(&[
                "collectionId",
                "ocrStatus",
                "imageHash",
                "color",
                "dimensions",
                "omittedFormats",
                "sourceAppIcon",
                "ocrText",
                "imageUrl",
            ])
        );
    }

    #[test]
    fn inbound_history_contracts_reject_unknown_fields() {
        let mut item =
            serde_json::to_value(text_item("unknown-item-field", "2026-07-01T00:00:00.000Z"))
                .expect("serialize item");
        item.as_object_mut()
            .expect("item object")
            .insert("unexpected".into(), serde_json::json!(true));
        assert!(serde_json::from_value::<HistoryItem>(item).is_err());

        let file = serde_json::json!({
            "path": "C:\\safe.txt",
            "name": "safe.txt",
            "directory": false,
            "exists": true,
            "unexpected": true
        });
        assert!(serde_json::from_value::<ClipboardFile>(file).is_err());

        let mutation = serde_json::json!({
            "upserts": [],
            "deleteIds": [],
            "policy": {},
            "unexpected": true
        });
        assert!(serde_json::from_value::<HistoryMutation>(mutation).is_err());
        let nested_policy = serde_json::json!({
            "upserts": [],
            "deleteIds": [],
            "policy": { "unexpected": true }
        });
        assert!(serde_json::from_value::<HistoryMutation>(nested_policy).is_err());
        for missing in [
            serde_json::json!({ "deleteIds": [], "policy": {
                "maxRecords": 500, "maxImageBytes": 268435456, "retentionDays": 30
            }}),
            serde_json::json!({ "upserts": [], "policy": {
                "maxRecords": 500, "maxImageBytes": 268435456, "retentionDays": 30
            }}),
            serde_json::json!({ "upserts": [], "deleteIds": [] }),
            serde_json::json!({ "upserts": [], "deleteIds": [], "policy": {
                "maxImageBytes": 268435456, "retentionDays": 30
            }}),
            serde_json::json!({ "upserts": [], "deleteIds": [], "policy": {
                "maxRecords": 500, "retentionDays": 30
            }}),
            serde_json::json!({ "upserts": [], "deleteIds": [], "policy": {
                "maxRecords": 500, "maxImageBytes": 268435456
            }}),
        ] {
            assert!(serde_json::from_value::<HistoryMutation>(missing).is_err());
        }

        let query = serde_json::json!({
            "text": "",
            "kinds": [],
            "sourceApps": [],
            "collection": { "mode": "any" },
            "limit": 100,
            "unexpected": true
        });
        assert!(serde_json::from_value::<HistoryQuery>(query).is_err());
        let nested_query = serde_json::json!({
            "text": "",
            "kinds": [],
            "sourceApps": [],
            "collection": { "mode": "any", "id": "must-not-be-ignored" },
            "limit": 100
        });
        assert!(serde_json::from_value::<HistoryQuery>(nested_query).is_err());
    }

    #[test]
    fn summary_rows_are_bounded_payload_free_and_batch_metadata_in_four_selects() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let mut rich = text_item("rich-summary", "2026-07-02T00:00:00.000Z");
        rich.content = format!("{}TAIL_SECRET", "界".repeat(600));
        rich.formats = vec!["text".into(), "html".into(), "rtf".into()];
        rich.html = Some("<b>large HTML payload</b>".into());
        rich.rtf_base64 = Some(STANDARD.encode(b"{\\rtf1 large RTF payload}"));
        rich.search_terms = vec!["sensitive-search-projection".into()];
        let mut rows = vec![rich];
        rows.extend((0..120).map(|index| {
            text_item(
                &format!("row-{index:03}"),
                &format!("2026-07-01T00:{:02}:00.000Z", index % 60),
            )
        }));
        apply_history_mutation(&mut database, mutation(rows, CapacityPolicy::default()))
            .expect("seed summary rows");

        let summary = query_history(&database, history_query("TAIL_SECRET"))
            .expect("query bounded summary")
            .items
            .pop()
            .expect("summary exists");
        assert!(!summary.payload_loaded);
        assert_eq!(summary.content.chars().count(), 512);
        assert!(!summary.content.contains("TAIL_SECRET"));
        assert!(summary.search_terms.is_empty());
        assert!(summary.ocr_text.is_none());
        assert!(summary.html.is_none());
        assert!(summary.rtf_base64.is_none());
        assert!(summary.image_url.is_none());
        let serialized = serde_json::to_value(&summary).expect("serialize summary");
        for absent in ["ocrText", "html", "rtfBase64", "imageUrl"] {
            assert!(serialized.get(absent).is_none(), "unexpected {absent}");
        }
        assert_eq!(serialized["payloadLoaded"], false);
        assert_eq!(serialized["matchSource"], "index");
        assert_eq!(serialized["searchTerms"], serde_json::json!([]));
        assert!(HISTORY_SUMMARY_COLUMNS.contains("substr(clips.plain_text, 1, 512)"));
        for forbidden in ["clip_formats.data", "image_url", "rtf_base64", "html"] {
            assert!(
                !HISTORY_SUMMARY_COLUMNS.contains(forbidden),
                "summary projection contains {forbidden}"
            );
        }

        let full = get_clip_payload(&database, "rich-summary")
            .expect("hydrate full payload")
            .expect("full payload exists");
        assert!(full.payload_loaded);
        assert!(full.content.contains("TAIL_SECRET"));
        assert_eq!(full.search_terms, vec!["sensitive-search-projection"]);
        assert!(full.ocr_text.is_none());
        assert!(full.html.is_some());
        assert!(full.rtf_base64.is_some());

        assert_eq!(traced_history_query_select_count(&mut database, 1), 4);
        assert_eq!(traced_history_query_select_count(&mut database, 100), 4);
    }

    #[test]
    fn history_query_uses_one_wal_snapshot_across_count_list_and_metadata() {
        let path = temporary_database_path("query-snapshot");
        let result = (|| -> Result<(), String> {
            let mut writer = Connection::open(&path).map_err(|error| error.to_string())?;
            configure_history_database_connection(&writer)?;
            initialize_history_database(&mut writer)?;
            apply_history_mutation(
                &mut writer,
                mutation(
                    vec![
                        text_item("before-a", "2026-07-02T00:00:00.000Z"),
                        text_item("before-b", "2026-07-01T00:00:00.000Z"),
                    ],
                    CapacityPolicy::default(),
                ),
            )?;

            let reader = Connection::open(&path).map_err(|error| error.to_string())?;
            configure_history_database_connection(&reader)?;
            let page =
                query_history_with_after_count_hook(&reader, HistoryQuery::default(), || {
                    apply_history_mutation(
                        &mut writer,
                        mutation(
                            vec![text_item("after-count", "2026-07-03T00:00:00.000Z")],
                            CapacityPolicy::default(),
                        ),
                    )
                    .expect("commit concurrent row after count");
                })?;

            assert_eq!(page.total_count, 2);
            assert_eq!(
                page.items
                    .iter()
                    .map(|item| item.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["before-a", "before-b"]
            );
            assert_eq!(
                query_history(&reader, HistoryQuery::default())?.total_count,
                3
            );
            Ok(())
        })();

        for cleanup_path in [
            path.clone(),
            std::path::PathBuf::from(format!("{}-wal", path.display())),
            std::path::PathBuf::from(format!("{}-shm", path.display())),
        ] {
            if cleanup_path.exists() {
                fs::remove_file(&cleanup_path).expect("remove snapshot database file");
            }
        }
        result.expect("query one consistent WAL snapshot");
    }

    #[test]
    fn composite_query_indexes_are_selected_by_sqlite_query_plans() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        initialize_history_database(&mut database).expect("initialize schema");

        let plans = [
            (
                "EXPLAIN QUERY PLAN SELECT id FROM clips
                 WHERE kind = 'text' AND source_app = 'Word'
                 ORDER BY copied_at DESC, id DESC",
                "clips_kind_source_age",
            ),
            (
                "EXPLAIN QUERY PLAN SELECT id FROM clips
                 WHERE source_app = 'Word' ORDER BY copied_at DESC, id DESC",
                "clips_source_age",
            ),
            (
                "EXPLAIN QUERY PLAN SELECT id FROM clips
                 WHERE pinned = 1 ORDER BY copied_at DESC, id DESC",
                "clips_pinned_age",
            ),
            (
                "EXPLAIN QUERY PLAN SELECT id FROM clips
                 WHERE collection_id = 'work' AND pinned = 1
                 ORDER BY copied_at DESC, id DESC",
                "clips_collection_pinned_age",
            ),
        ];
        for (sql, expected_index) in plans {
            let mut statement = database.prepare(sql).expect("prepare query plan");
            let detail = statement
                .query_map([], |row| row.get::<_, String>(3))
                .expect("query plan")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect query plan")
                .join("\n");
            assert!(
                detail.contains(expected_index),
                "expected {expected_index} in {detail}"
            );
        }
    }

    #[test]
    fn keyset_cursor_uses_utc_millis_and_keeps_total_count_stable() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        let timestamp = "2026-07-01T00:00:00.123Z";
        apply_history_mutation(
            &mut database,
            mutation(
                ["a", "b", "c", "d", "e"]
                    .into_iter()
                    .map(|id| text_item(id, timestamp))
                    .collect(),
                CapacityPolicy::default(),
            ),
        )
        .expect("seed equal timestamps");

        let first = query_history(
            &database,
            HistoryQuery {
                limit: 2,
                ..history_query("")
            },
        )
        .expect("first page");
        let second = query_history(
            &database,
            HistoryQuery {
                limit: 2,
                cursor: first.next_cursor.clone(),
                ..history_query("")
            },
        )
        .expect("second page");
        let third = query_history(
            &database,
            HistoryQuery {
                limit: 2,
                cursor: second.next_cursor.clone(),
                ..history_query("")
            },
        )
        .expect("third page");
        assert_eq!(first.total_count, 5);
        assert_eq!(second.total_count, 5);
        assert_eq!(third.total_count, 5);
        assert_eq!(
            [first.items, second.items, third.items]
                .into_iter()
                .flatten()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec!["e", "d", "c", "b", "a"]
        );

        for cursor in [
            "not-base64".to_owned(),
            STANDARD.encode("not-millis\nid"),
            STANDARD.encode("1\nid\nextra"),
            STANDARD.encode("1\n"),
        ] {
            assert!(query_history(
                &database,
                HistoryQuery {
                    cursor: Some(cursor),
                    ..history_query("")
                }
            )
            .is_err());
        }
    }

    #[test]
    fn cursor_and_storage_timestamps_use_four_digit_utc_year_bounds() {
        let minimum = chrono::DateTime::parse_from_rfc3339("0000-01-01T00:00:00.000Z")
            .expect("parse minimum four-digit year")
            .timestamp_millis();
        let maximum = chrono::DateTime::parse_from_rfc3339("9999-12-31T23:59:59.999Z")
            .expect("parse maximum four-digit year")
            .timestamp_millis();
        assert_eq!(minimum, -62_167_219_200_000);
        assert_eq!(maximum, 253_402_300_799_999);
        for millis in [minimum, maximum] {
            assert!(decode_cursor(&STANDARD.encode(format!("{millis}\nid"))).is_ok());
        }
        for millis in [minimum - 1, maximum + 1] {
            assert!(decode_cursor(&STANDARD.encode(format!("{millis}\nid"))).is_err());
            let expanded = chrono::DateTime::<Utc>::from_timestamp_millis(millis)
                .expect("expanded timestamp exists")
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            assert!(normalize_timestamp(&expanded).is_err());
        }
    }

    #[test]
    fn history_ids_reject_edge_whitespace_controls_and_oversized_cursors() {
        let mut database = Connection::open_in_memory().expect("in-memory database");
        for invalid_id in [
            "control\nid".to_owned(),
            " padded".to_owned(),
            "padded ".to_owned(),
            "\u{feff}padded".to_owned(),
            "padded\u{0085}".to_owned(),
            "x".repeat(600),
        ] {
            let mut item = text_item(&invalid_id, "2026-07-01T00:00:00.000Z");
            item.id = invalid_id;
            assert!(validate_history_item(&item).is_err());
            assert!(encode_cursor(&item).is_err());
            assert!(apply_history_mutation(
                &mut database,
                mutation(vec![item], CapacityPolicy::default())
            )
            .is_err());
        }
        assert!(load_history(&database)
            .expect("load after rejected IDs")
            .is_empty());
    }
}
