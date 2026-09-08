//! eg-providers: platform integration trait surface, pinned in M1 so M2
//! implementations (github | gitlab | gitee) slot in without touching core
//! crates (TDD §4.4). OAuth device flow callbacks arrive over the
//! `easygit://oauth` deep link.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub platform: Platform,
    pub login: String,
    pub name: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    GitHub,
    GitLab,
    Gitee,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoSlug {
    pub owner: String,
    pub name: String,
}

pub type PrId = u64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pr {
    pub id: PrId,
    pub title: String,
    pub state: PrState,
    pub author: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Merged,
    Closed,
    Draft,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePrReq {
    pub repo: RepoSlug,
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrDetail {
    pub pr: Pr,
    pub comments: Vec<PrComment>,
    pub ci_status: Option<CiStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrComment {
    pub author: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiStatus {
    Pending,
    Success,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMode {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: u64,
    pub title: String,
    pub url: String,
}

/// Platform differences collapse behind this trait; core crates never branch
/// on the platform directly.
///
/// `async fn` in trait is kept per TDD §4.4; the trait is consumed only
/// inside this workspace, so unspecified auto-trait bounds are acceptable
/// (M2 may desugar to `impl Future + Send` if a spawn site needs it).
#[allow(async_fn_in_trait)]
pub trait Provider {
    async fn account(&self) -> Account;
    async fn list_prs(&self, repo: &RepoSlug) -> Vec<Pr>;
    async fn create_pr(&self, req: CreatePrReq) -> Pr;
    async fn pr_detail(&self, id: PrId) -> PrDetail;
    async fn merge_pr(&self, id: PrId, mode: MergeMode) -> Result<(), String>;
    async fn notifications(&self) -> Vec<Notification>;
}
