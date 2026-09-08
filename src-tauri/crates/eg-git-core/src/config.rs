//! Git config form backend (m1-plan R-09): identity, line endings, proxy.

use eg_types::{ConfigScope, EgError};
use git2::Repository;

pub fn config_get(
    repo: Option<&Repository>,
    scope: ConfigScope,
    key: &str,
) -> Result<Option<String>, EgError> {
    match scope {
        ConfigScope::Repo => {
            let Some(repo) = repo else {
                return Err(missing_repo());
            };
            let config = repo.config().map_err(cfg_err("open"))?;
            Ok(config.get_string(key).ok())
        }
        ConfigScope::Global => {
            let config = git2::Config::open_default().map_err(cfg_err("open global"))?;
            Ok(config.get_string(key).ok())
        }
    }
}

pub fn config_set(
    repo: Option<&Repository>,
    scope: ConfigScope,
    key: &str,
    value: &str,
) -> Result<(), EgError> {
    match scope {
        ConfigScope::Repo => {
            let Some(repo) = repo else {
                return Err(missing_repo());
            };
            let mut config = repo.config().map_err(cfg_err("open"))?;
            config.set_str(key, value).map_err(cfg_err("set"))
        }
        ConfigScope::Global => {
            let mut config = git2::Config::open_default().map_err(cfg_err("open global"))?;
            config.set_str(key, value).map_err(cfg_err("set"))
        }
    }
}

fn missing_repo() -> EgError {
    EgError::RepoNotFound {
        path: "<no open repository>".into(),
    }
}

fn cfg_err(stage: &'static str) -> impl Fn(git2::Error) -> EgError {
    move |e| EgError::Internal {
        context: format!("config {stage} failed: {e}"),
    }
}
