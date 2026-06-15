use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

/// A single `.md` file in the vault, with its vault-relative path.
#[derive(Serialize)]
struct NoteEntry {
    /// Vault-relative path with forward slashes, e.g. `"folder/My Note.md"`.
    path: String,
    /// Basename without the `.md` extension, e.g. `"My Note"`.
    name: String,
}

/// Open a native folder picker and return the chosen vault path.
/// Returns `None` if the user cancels. Declared `async` so Tauri runs it off
/// the main thread — `blocking_pick_folder` would otherwise risk a deadlock.
#[tauri::command]
async fn pick_vault(app: tauri::AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Compute the vault-relative path of `full` (forward slashes).
fn rel_path(root: &Path, full: &Path) -> Option<String> {
    full.strip_prefix(root)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

/// Recursively collect `.md` files under `dir`, skipping hidden entries.
fn collect(dir: &Path, root: &Path, out: &mut Vec<NoteEntry>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue; // skip dotfiles / .git / .obsidian etc.
        }
        let path = entry.path();
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect(&path, root, out)?;
        } else if ft.is_file()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            if let Some(rel) = rel_path(root, &path) {
                let base = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default();
                out.push(NoteEntry { path: rel, name: base });
            }
        }
    }
    Ok(())
}

/// List every `.md` note in the vault, sorted case-insensitively by path.
#[tauri::command]
fn list_notes(vault: String) -> Result<Vec<NoteEntry>, String> {
    let root = PathBuf::from(&vault);
    let mut out = Vec::new();
    collect(&root, &root, &mut out).map_err(|e| e.to_string())?;
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

/// A note's path, content and last-modified time (epoch ms). `modified` feeds
/// last-write-wins during sync; the content feeds the link / search index.
#[derive(Serialize)]
struct NoteContent {
    path: String,
    content: String,
    modified: u64,
}

/// Last-modified time of a file in epoch milliseconds (0 if unavailable).
fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read every `.md` note's content in one call, so the frontend can build the
/// link graph / search index (and the sync engine) without a round-trip per file.
#[tauri::command]
fn read_all_notes(vault: String) -> Result<Vec<NoteContent>, String> {
    let root = PathBuf::from(&vault);
    let mut entries = Vec::new();
    collect(&root, &root, &mut entries).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let full = root.join(&entry.path);
        let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;
        let modified = modified_ms(&full);
        out.push(NoteContent { path: entry.path, content, modified });
    }
    Ok(out)
}

/// Resolve a vault-relative path to an absolute one, rejecting absolute paths
/// and `..` traversal so a note can never be written outside the vault.
fn resolve_in_vault(vault: &str, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("path must be relative to the vault".into());
    }
    for comp in rel_path.components() {
        match comp {
            Component::ParentDir => return Err("path traversal (`..`) is not allowed".into()),
            Component::Prefix(_) | Component::RootDir => return Err("invalid path".into()),
            _ => {}
        }
    }
    Ok(PathBuf::from(vault).join(rel_path))
}

/// Read a note's UTF-8 content.
#[tauri::command]
fn read_note(vault: String, path: String) -> Result<String, String> {
    let full = resolve_in_vault(&vault, &path)?;
    fs::read_to_string(&full).map_err(|e| e.to_string())
}

/// Write (creating or overwriting) a note, making parent folders as needed.
#[tauri::command]
fn write_note(vault: String, path: String, content: String) -> Result<(), String> {
    let full = resolve_in_vault(&vault, &path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full, content).map_err(|e| e.to_string())
}

/// Create a new empty note, failing if one already exists at `path`.
#[tauri::command]
fn create_note(vault: String, path: String) -> Result<(), String> {
    let full = resolve_in_vault(&vault, &path)?;
    if full.exists() {
        return Err("a note already exists at that path".into());
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full, "").map_err(|e| e.to_string())
}

/// Delete a note.
#[tauri::command]
fn delete_note(vault: String, path: String) -> Result<(), String> {
    let full = resolve_in_vault(&vault, &path)?;
    fs::remove_file(&full).map_err(|e| e.to_string())
}

/// Rename / move a note, failing if the target already exists.
#[tauri::command]
fn rename_note(vault: String, from: String, to: String) -> Result<(), String> {
    let from_full = resolve_in_vault(&vault, &from)?;
    let to_full = resolve_in_vault(&vault, &to)?;
    if to_full.exists() {
        return Err("a note already exists at the target path".into());
    }
    if let Some(parent) = to_full.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(&from_full, &to_full).map_err(|e| e.to_string())
}

/// In-memory FTS5 index over the current vault's notes. Rebuilt on load and
/// kept separate from the frontend's in-memory index (which feeds the link
/// graph); this one powers ranked full-text search with snippets.
struct SearchIndex(Mutex<rusqlite::Connection>);

impl SearchIndex {
    fn new() -> Self {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE notes USING fts5(\
                 path UNINDEXED, name, body, tokenize='unicode61');",
        )
        .expect("create fts5 table");
        SearchIndex(Mutex::new(conn))
    }
}

/// A search result: the note's path and a snippet of the matching body text,
/// with matches wrapped in U+0002 / U+0003 control chars (the frontend turns
/// these into `<mark>` after HTML-escaping, so note text can't inject markup).
#[derive(Serialize)]
struct SearchHit {
    path: String,
    snippet: String,
}

/// Turn a user query into a safe FTS5 MATCH expression: each whitespace-split
/// word is reduced to its alphanumerics and turned into a prefix term, AND-ed
/// together (e.g. `"foo ba!r"` -> `foo* bar*`). Empty if nothing usable.
fn to_match_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
        .filter(|w| !w.is_empty())
        .map(|w| format!("{w}*"))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Rebuild the FTS index from the vault on disk. Cheap for typical vaults
/// (in-memory SQLite, a few hundred small docs), so we just wipe and refill.
#[tauri::command]
fn index_vault(state: tauri::State<'_, SearchIndex>, vault: String) -> Result<(), String> {
    let root = PathBuf::from(&vault);
    let mut entries = Vec::new();
    collect(&root, &root, &mut entries).map_err(|e| e.to_string())?;
    let mut conn = state.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM notes", []).map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT INTO notes(path, name, body) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for entry in &entries {
            let content = fs::read_to_string(root.join(&entry.path)).unwrap_or_default();
            stmt.execute(rusqlite::params![entry.path, entry.name, content])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Ranked full-text search over note names and bodies. Returns up to 50 hits
/// ordered by bm25 relevance, each with a highlighted body snippet.
#[tauri::command]
fn search_notes(
    state: tauri::State<'_, SearchIndex>,
    query: String,
) -> Result<Vec<SearchHit>, String> {
    let match_q = to_match_query(&query);
    if match_q.is_empty() {
        return Ok(Vec::new());
    }
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT path, snippet(notes, 2, char(2), char(3), '…', 12) \
             FROM notes WHERE notes MATCH ?1 ORDER BY bm25(notes) LIMIT 50",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![match_q], |row| {
            Ok(SearchHit { path: row.get(0)?, snippet: row.get(1)? })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// Holds the live vault watcher. Dropping it stops watching, so switching
/// vaults simply replaces the value here.
#[derive(Default)]
struct WatchState(Mutex<Option<RecommendedWatcher>>);

/// True if a filesystem event touches a `.md` note we care about: a real
/// content change (not a bare read) to a non-hidden file. Mirrors `collect`'s
/// dotfile skip, so writes to `.notes-sync.json` / `.git` don't trigger reloads.
fn is_relevant(event: &notify::Event) -> bool {
    if matches!(event.kind, notify::EventKind::Access(_)) {
        return false; // reads (including our own index scans) never mutate
    }
    event.paths.iter().any(|p| {
        let hidden = p
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
        !hidden
            && p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
    })
}

/// Start watching `vault` recursively, emitting a debounce-able `vault-changed`
/// event to the frontend on every relevant change. Replaces any prior watcher.
#[tauri::command]
fn watch_vault(
    app: tauri::AppHandle,
    state: tauri::State<'_, WatchState>,
    vault: String,
) -> Result<(), String> {
    let root = PathBuf::from(&vault);
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if is_relevant(&event) {
                let _ = app.emit("vault-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // Storing the new watcher drops the previous one, which stops its thread.
    *state.0.lock().map_err(|e| e.to_string())? = Some(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default())
        .manage(SearchIndex::new())
        .invoke_handler(tauri::generate_handler![
            pick_vault,
            list_notes,
            read_all_notes,
            read_note,
            write_note,
            create_note,
            delete_note,
            rename_note,
            watch_vault,
            index_vault,
            search_notes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
