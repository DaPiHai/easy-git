//! Per-repository worker threads (TDD §4.1, m1-plan R-01) with fs-watch and
//! a 300ms debounce feeding the `repo://changed` event (R-03).
//!
//! `git2::Repository` is neither `Sync` nor shareable across threads, so each
//! open repository owns one thread that holds it for its whole lifetime.
//! Commands travel through an mpsc queue and execute strictly in order, which
//! removes lock contention by construction. The notify watcher lives on the
//! worker too; filesystem events coalesce here so the frontend receives at
//! most one `repo://changed` per quiet period.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use eg_types::{EgError, IgnoreMode, RepoId, RepoSummary, StageMode, StatusReport};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use uuid::Uuid;

use super::{ops, repo, status};

/// Quiet period before a burst of filesystem events triggers one change event.
pub const FS_DEBOUNCE: Duration = Duration::from_millis(300);

/// Upper bound for a blocking command round-trip; the UI stays responsive
/// because commands run on the worker, never on the IPC caller.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

enum RepoCommand {
    Status(Sender<Result<StatusReport, EgError>>),
    Summary(Sender<Result<RepoSummary, EgError>>),
    Stage {
        paths: Vec<String>,
        mode: StageMode,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    Discard {
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<DiscardOutcome, EgError>>,
    },
    CleanPreview {
        reply: Sender<Result<Vec<String>, EgError>>,
    },
    CleanExecute {
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<DiscardOutcome, EgError>>,
    },
    Ignore {
        paths: Vec<String>,
        mode: IgnoreMode,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    Undo {
        op_id: String,
        safety: Arc<eg_safety::Safety>,
        reply: Sender<Result<StatusReport, EgError>>,
    },
    Close(Sender<()>),
}

/// Discard result: the fresh status plus the op id for the 撤销 toast.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscardOutcome {
    pub op_id: String,
    pub status: StatusReport,
}

/// Cloneable handle to a live worker thread.
#[derive(Clone)]
pub struct WorkerHandle {
    pub repo_id: RepoId,
    pub canonical_path: PathBuf,
    tx: Sender<RepoCommand>,
}

fn worker_gone() -> EgError {
    EgError::Internal {
        context: "repo worker stopped".into(),
    }
}

impl WorkerHandle {
    pub fn request_status(&self) -> Result<StatusReport, EgError> {
        self.request(RepoCommand::Status)
    }

    pub fn request_summary(&self) -> Result<RepoSummary, EgError> {
        self.request(RepoCommand::Summary)
    }

    pub fn stage(&self, paths: Vec<String>, mode: StageMode) -> Result<StatusReport, EgError> {
        self.request(|reply| RepoCommand::Stage { paths, mode, reply })
    }

    pub fn discard(
        &self,
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<DiscardOutcome, EgError> {
        self.request(|reply| RepoCommand::Discard {
            paths,
            safety,
            reply,
        })
    }

    pub fn clean_preview(&self) -> Result<Vec<String>, EgError> {
        self.request(|reply| RepoCommand::CleanPreview { reply })
    }

    pub fn clean_execute(
        &self,
        paths: Vec<String>,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<DiscardOutcome, EgError> {
        self.request(|reply| RepoCommand::CleanExecute {
            paths,
            safety,
            reply,
        })
    }

    pub fn ignore(&self, paths: Vec<String>, mode: IgnoreMode) -> Result<StatusReport, EgError> {
        self.request(|reply| RepoCommand::Ignore { paths, mode, reply })
    }

    pub fn undo(
        &self,
        op_id: String,
        safety: Arc<eg_safety::Safety>,
    ) -> Result<StatusReport, EgError> {
        self.request(|reply| RepoCommand::Undo {
            op_id,
            safety,
            reply,
        })
    }

    fn request<T>(
        &self,
        make: impl FnOnce(Sender<Result<T, EgError>>) -> RepoCommand,
    ) -> Result<T, EgError> {
        let (tx, rx) = channel();
        self.tx.send(make(tx)).map_err(|_| worker_gone())?;
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(_) => Err(EgError::Internal {
                context: "repo worker request timed out".into(),
            }),
        }
    }

    /// Drains the queue and stops the thread (TDD §4.1: close = drain + drop).
    pub fn close(&self) {
        let (tx, rx) = channel();
        if self.tx.send(RepoCommand::Close(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

/// Closure invoked (at most once per debounce window) with the repo id.
pub type ChangeSink = Arc<dyn Fn(&str) + Send + Sync + 'static>;

/// Spawns the worker thread that owns `repo` for the rest of its life.
pub fn spawn(
    repo: git2::Repository,
    repo_id: RepoId,
    canonical_path: PathBuf,
    on_change: ChangeSink,
) -> Result<WorkerHandle, EgError> {
    let (tx, rx) = channel::<RepoCommand>();

    let (fs_tx, fs_rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher: RecommendedWatcher =
        notify::recommended_watcher(fs_tx).map_err(|e| EgError::Internal {
            context: format!("fs-watch init failed: {e}"),
        })?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| EgError::NotSupported {
            feature: "bare repository watching".into(),
        })?
        .to_path_buf();
    watcher
        .watch(&workdir, RecursiveMode::Recursive)
        .map_err(|e| EgError::Internal {
            context: format!("fs-watch setup failed: {e}"),
        })?;

    let handle = WorkerHandle {
        repo_id: repo_id.clone(),
        canonical_path: canonical_path.clone(),
        tx,
    };

    let thread_repo_id = repo_id.clone();
    std::thread::Builder::new()
        .name(format!("eg-repo-{}", &repo_id[..8.min(repo_id.len())]))
        .spawn(move || {
            // Held for the thread lifetime; dropping it unregisters the watch.
            let _watcher = watcher;
            run_loop(
                repo,
                rx,
                fs_rx,
                workdir,
                thread_repo_id,
                canonical_path,
                on_change,
            );
        })
        .map_err(|e| EgError::Internal {
            context: format!("worker spawn failed: {e}"),
        })?;

    Ok(handle)
}

fn run_loop(
    repo: git2::Repository,
    rx: std::sync::mpsc::Receiver<RepoCommand>,
    fs_rx: std::sync::mpsc::Receiver<notify::Result<notify::Event>>,
    workdir: PathBuf,
    repo_id: RepoId,
    canonical_path: PathBuf,
    on_change: ChangeSink,
) {
    let mut dirty: Option<Instant> = None;
    loop {
        // 1. Coalesce filesystem bursts into a single pending change flag.
        while let Ok(event) = fs_rx.try_recv() {
            if let Ok(event) = event {
                let relevant = event.paths.iter().any(|p| !is_git_internal(&workdir, p));
                if relevant && dirty.is_none() {
                    dirty = Some(Instant::now());
                }
            }
        }

        // 2. Emit once the quiet period has elapsed.
        if let Some(seen) = dirty {
            if seen.elapsed() >= FS_DEBOUNCE {
                on_change(&repo_id);
                dirty = None;
            }
        }

        // 3. Wait for commands; wake in time for the pending debounce.
        let wait = dirty
            .map(|seen| FS_DEBOUNCE.saturating_sub(seen.elapsed()))
            .unwrap_or(FS_DEBOUNCE)
            .max(Duration::from_millis(10));
        match rx.recv_timeout(wait) {
            Ok(RepoCommand::Status(tx)) => {
                let _ = tx.send(status::status(&repo_id, &repo));
            }
            Ok(RepoCommand::Summary(tx)) => {
                let _ = tx.send(repo::summarize(&repo_id, &repo, &canonical_path));
            }
            Ok(RepoCommand::Stage { paths, mode, reply }) => {
                let _ = reply.send(
                    ops::stage(&repo, &paths, mode).and_then(|()| status::status(&repo_id, &repo)),
                );
            }
            Ok(RepoCommand::Discard {
                paths,
                safety,
                reply,
            }) => {
                let _ = reply.send(ops::discard(&repo, &repo_id, &safety, &paths).and_then(
                    |op_id| {
                        status::status(&repo_id, &repo)
                            .map(|status| DiscardOutcome { op_id, status })
                    },
                ));
            }
            Ok(RepoCommand::CleanPreview { reply }) => {
                let _ = reply.send(status::status(&repo_id, &repo).map(|report| {
                    report
                        .unstaged
                        .into_iter()
                        .filter(|e| e.kind == eg_types::ChangeKind::Untracked)
                        .map(|e| e.path)
                        .collect()
                }));
            }
            Ok(RepoCommand::CleanExecute {
                paths,
                safety,
                reply,
            }) => {
                let _ = reply.send(ops::clean(&repo, &repo_id, &safety, &paths).and_then(
                    |op_id| {
                        status::status(&repo_id, &repo)
                            .map(|status| DiscardOutcome { op_id, status })
                    },
                ));
            }
            Ok(RepoCommand::Ignore { paths, mode, reply }) => {
                let _ = reply.send(
                    ops::ignore(&repo, &paths, mode)
                        .and_then(|_added| status::status(&repo_id, &repo)),
                );
            }
            Ok(RepoCommand::Undo {
                op_id,
                safety,
                reply,
            }) => {
                let _ = reply.send(
                    ops::undo_operation(&repo, &repo_id, &safety, &op_id)
                        .and_then(|()| status::status(&repo_id, &repo)),
                );
            }
            Ok(RepoCommand::Close(tx)) => {
                let _ = tx.send(());
                break;
            }
            Err(RecvTimeoutError::Timeout) => continue,
            // All handles dropped: shut down.
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Ignores churn inside `.git` (index refresh, gc, our own safety writes).
fn is_git_internal(workdir: &Path, path: &Path) -> bool {
    path.strip_prefix(workdir)
        .map(|rel| rel.iter().next() == Some(std::ffi::OsStr::new(".git")))
        .unwrap_or(true)
}

/// Registry of open repositories, one worker thread each (TDD §4.1).
/// Lives in Tauri managed state; all methods are panic-free.
#[derive(Default)]
pub struct RepoManager {
    workers: Mutex<HashMap<RepoId, WorkerHandle>>,
}

impl RepoManager {
    /// Opens the repository at `path` (searching upwards like git), or returns
    /// the summary of the already-open worker for the same canonical path.
    pub fn open(&self, path: &Path, on_change: ChangeSink) -> Result<RepoSummary, EgError> {
        let canonical = path.canonicalize().map_err(|_| EgError::RepoNotFound {
            path: path.display().to_string(),
        })?;

        if let Some(existing) = self.find_by_path(&canonical) {
            return existing.request_summary();
        }

        let repo = repo::open(&canonical)?;
        let repo_id = Uuid::new_v4().to_string();
        let sink: ChangeSink = Arc::new(move |id| on_change(id));
        let handle = spawn(repo, repo_id, canonical, sink)?;
        let summary = handle.request_summary();
        match summary {
            Ok(s) => {
                self.workers
                    .lock()
                    .expect("repo manager mutex")
                    .insert(handle.repo_id.clone(), handle);
                Ok(s)
            }
            Err(err) => {
                handle.close();
                Err(err)
            }
        }
    }

    fn find_by_path(&self, canonical: &Path) -> Option<WorkerHandle> {
        let workers = self.workers.lock().expect("repo manager mutex");
        workers
            .values()
            .find(|w| w.canonical_path == canonical)
            .cloned()
    }

    pub fn get(&self, repo_id: &str) -> Result<WorkerHandle, EgError> {
        self.workers
            .lock()
            .expect("repo manager mutex")
            .get(repo_id)
            .cloned()
            .ok_or_else(|| EgError::RepoNotFound {
                path: repo_id.to_string(),
            })
    }

    /// Closes the repository (drain + stop thread). Unknown ids are a no-op
    /// so the frontend can close stale tabs idempotently.
    pub fn close(&self, repo_id: &str) {
        if let Some(handle) = self
            .workers
            .lock()
            .expect("repo manager mutex")
            .remove(repo_id)
        {
            handle.close();
        }
    }

    /// Shuts every worker down (app exit).
    pub fn close_all(&self) {
        let handles: Vec<WorkerHandle> = self
            .workers
            .lock()
            .expect("repo manager mutex")
            .drain()
            .map(|(_, h)| h)
            .collect();
        for handle in handles {
            handle.close();
        }
    }
}
