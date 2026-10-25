// =============================================================================
// Agent-Nexus Desktop - Panel State (面板切换决策)
//
// 把「什么时候该翻离线页 / 什么时候该切回面板」从 Electron 主进程里拆出来，
// 以便单测。这里只做决策，不碰窗口。
//
// 闪屏的根因：主进程每 3 秒轮询探针，只要有一次探活失败就 loadFile 离线页，
// 下一次成功又 loadURL 面板；页面反复从头加载，看起来就是"连上又断开"。
// 现在的规则：
//   - 连续失败达阈值才翻离线页（单次抖动不打断正在看的页面）；
//   - 失败后按指数退避重试，而不是每 3 秒重来一次；
//   - 切回面板前先看当前 URL，已经在面板上就不重复 loadURL。
// =============================================================================

const OFFLINE_AFTER_FAILURES = 3;
const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60000;

class PanelState {
  constructor(options = {}) {
    this.offlineAfterFailures = options.offlineAfterFailures ?? OFFLINE_AFTER_FAILURES;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.consecutiveFailures = 0;
    this.retryDelay = this.retryBaseMs;
    this.showingOffline = false;
  }

  // 一次探活的结果：返回 'offline'（该翻离线页）、'panel'（该切回面板）或 null（保持现状）。
  onHealthResult(alive, { isShowingPanel }) {
    if (!alive) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures < this.offlineAfterFailures) return null;
      // 已达阈值：只有当前还在面板上才需要翻页，已经在离线页就保持不动。
      if (!isShowingPanel) return null;
      this.showingOffline = true;
      return 'offline';
    }

    this.consecutiveFailures = 0;
    if (!isShowingPanel) {
      this.showingOffline = false;
      return 'panel';
    }
    return null;
  }

  // 面板加载失败：翻离线页并给出下次重试的延迟。
  onPanelLoadFailed() {
    this.showingOffline = true;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.retryMaxMs);
    return { showOffline: true, retryInMs: delay };
  }

  // 面板真正加载成功：退避与失败计数归零。
  onPanelLoadSucceeded() {
    this.showingOffline = false;
    this.consecutiveFailures = 0;
    this.retryDelay = this.retryBaseMs;
  }

  // 重试定时器到期时是否还该尝试切回面板。
  shouldRetryPanel(isShowingPanel) {
    return !isShowingPanel;
  }
}

// did-fail-load 里哪些失败不该把整页踢下线：
//   - 子框架/子资源失败（isMainFrame === false）
//   - ERR_ABORTED(-3)：导航被新导航取代，属正常现象
//   - 离线页自身（file://）加载失败
function isPanelKillingFailure({ errorCode, validatedURL, isMainFrame }) {
  if (isMainFrame === false) return false;
  if (errorCode === -3) return false;
  if (validatedURL && validatedURL.startsWith('file://')) return false;
  return true;
}

module.exports = { PanelState, isPanelKillingFailure, OFFLINE_AFTER_FAILURES, RETRY_BASE_MS, RETRY_MAX_MS };
