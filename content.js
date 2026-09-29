(() => {
  'use strict';

  if (window.top !== window) {
    return;
  }

  const STORAGE_KEY = 'xxtAssistantSettings';
  const API_KEY_STORAGE_KEY = 'xxtDeepSeekApiKey';
  const MODEL_STORAGE_KEY = 'xxtDeepSeekModel';
  const CHILD_BRIDGE_SOURCE = 'xxt-assistant-child';
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoNextOnBlank: true,
    autoNextOnVideo: true,
    autoNextOnDocument: true,
    autoNextOnQuiz: true,
    settingsVersion: 2,
    delayMs: 3000,
    videoNextDelayMs: 2000
  });

  const TYPE_META = Object.freeze({
    loading: {
      label: '正在识别',
      evidence: '正在读取章节内容，请稍候。',
      tone: 'info'
    },
    video: {
      label: '视频',
      evidence: '检测到视频附件容器或视频播放器节点。',
      tone: 'info'
    },
    document: {
      label: 'PPT / PDF',
      evidence: '检测到 #panView 文档查看器或文档附件容器。',
      tone: 'info'
    },
    quiz: {
      label: '试题 / 作业',
      evidence: '检测到作业表单、题目列表或题目标题节点。',
      tone: 'success'
    },
    blank: {
      label: '空白页面',
      evidence: '检测到明确的“暂无内容”提示，或页面稳定后没有内容模块。',
      tone: 'warning'
    },
    unknown: {
      label: '暂未识别',
      evidence: '页面结构尚未稳定，助手会继续观察。',
      tone: 'warning'
    },
    paused: {
      label: '助手已暂停',
      evidence: '当前不会执行自动跳转。',
      tone: 'warning'
    }
  });

  const BLANK_TEXT_PATTERN = /暂无内容|暂无数据|暂时没有内容|没有学习内容|无内容/;
  const MAX_FRAME_DEPTH = 4;
  const FALLBACK_BLANK_DELAY_MS = 1500;
  const GRADER_BATCH_SIZE = 5;
  const GRADER_MODELS = ['deepseek-reasoner', 'deepseek-chat'];
  const DEEPSEEK_DEFAULT_SYSTEM_PROMPT = `你是严谨的试题批改助手。请只根据题干和选项判断正确答案，不要参考用户当前选择，也不要猜测不存在的上下文。

必须只返回一个 JSON 对象，不要返回 Markdown，不要添加 JSON 之外的文字。格式必须是：
{"answers":[{"id":"题目ID","answer":["正确选项字母"],"reason":"不超过50个汉字的中文理由"}]}

规则：
1. id 必须与输入题目的 id 完全一致。
2. 单选题和判断题必须且只能返回一个选项字母，禁止返回两个或更多答案。
3. 只有明确标注为多选的题目才允许 answer 包含多个选项。
4. answer 使用选项字母，例如 ["A"] 或 ["A","C"]。
5. reason 使用中文，控制在50个汉字以内。
6. 如果无法确定，仍然给出最可能答案，并在 reason 中说明。`;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    root: null,
    observer: null,
    observedFrames: new WeakSet(),
    detectionTimer: null,
    actionTimer: null,
    countdownTimer: null,
    toastTimer: null,
    currentKey: '',
    keyChangedAt: 0,
    lastDetectedKey: '',
    lastDetectedType: '',
    pendingActionKey: '',
    lastClickedKey: '',
    retryCount: 0,
    navigationFlow: null,
    navigationTimer: null,
    lastPopupNextKey: '',
    guardedDocuments: new WeakSet(),
    guardedWindows: new WeakSet(),
    video: {
      key: '',
      watchdogTimer: null,
      completionTimer: null,
      completedKey: '',
      playInFlight: false,
      autoplayBlocked: false,
      lastStatus: ''
    },
    quiz: {
      key: '',
      timer: null,
      clickedKey: '',
      handledKey: '',
      manualPausedKey: '',
      checks: 0,
      lastStatus: ''
    },
    grader: {
      opened: false,
      running: false,
      apiKey: '',
      model: 'deepseek-reasoner'
    },
    documentReader: {
      key: '',
      watchdogTimer: null,
      scrollTimer: null,
      startedAt: 0,
      lastSignature: '',
      stableSince: 0,
      scrollCount: 0,
      scrollStartedKey: '',
      completedKey: '',
      lastStatus: '',
      remoteFrames: new Map(),
      scrollRequestCounter: 0,
      lastScrollRequestId: '',
      lastRemoteScrollResult: null,
      probeInFlight: false,
      lastProbeAt: 0,
      probeErrorLogged: false,
      foundRemoteLogged: false
    }
  };

  const childBridgeState = {
    isViewer: false,
    handledRequests: new Set(),
    lastSentAt: 0,
    stateTimer: null
  };

  if (window.top !== window) {
    initChildFrameBridge();
    return;
  }

  if (!/^\/mycourse\/studentstudy/.test(window.location.pathname)) {
    return;
  }

  init().catch((error) => {
    console.error('[学习通助手] 初始化失败：', error);
  });

  async function init() {
    injectUI();
    bindUI();

    state.settings = await loadSettings();
    state.grader.apiKey = await loadStoredApiKey();
    state.grader.model = await loadStoredModel();
    applySettingsUI();
    updateGraderKeyHint();
    updateGraderModelSelection();

    window.addEventListener('message', handleDocumentFrameMessage, false);
    installObservers();
    watchPage();
    scheduleDetection('初始化', 500);
  }

  function injectUI() {
    if (document.getElementById('xxt-assistant-root')) {
      state.root = document.getElementById('xxt-assistant-root');
      return;
    }

    const root = document.createElement('div');
    root.id = 'xxt-assistant-root';
    root.dataset.type = 'loading';
    root.innerHTML = `
      <section class="xxt-panel" aria-label="学习通页面识别助手">
        <div class="xxt-panel__header">
          <div class="xxt-panel__brand">
            <span class="xxt-panel__brand-dot" aria-hidden="true"></span>
            <span>学习通助手</span>
          </div>
          <button
            type="button"
            class="xxt-panel__collapse"
            data-xxt-action="toggle-panel"
            aria-label="折叠助手面板"
          >−</button>
        </div>
        <div class="xxt-panel__body">
          <div class="xxt-kicker">当前页面类型</div>
          <div class="xxt-type-row">
            <span class="xxt-type-dot" aria-hidden="true"></span>
            <span class="xxt-type-label" data-xxt-role="type">正在识别</span>
          </div>
          <div class="xxt-evidence" data-xxt-role="evidence">
            正在读取章节内容，请稍候。
          </div>
          <div class="xxt-action" data-xxt-role="action">
            空白页将在识别完成后倒计时 3 秒。
          </div>
          <div class="xxt-video-status" data-xxt-role="video-status" hidden>
            <span class="xxt-video-status__dot" aria-hidden="true"></span>
            <span data-xxt-role="video-text">准备自动播放视频</span>
          </div>
          <div class="xxt-video-status" data-xxt-role="document-status" hidden>
            <span class="xxt-video-status__dot" aria-hidden="true"></span>
            <span data-xxt-role="document-text">准备检查 PPT/PDF 加载状态</span>
          </div>
          <div class="xxt-countdown" data-xxt-role="countdown" hidden>
            <span class="xxt-countdown__number" data-xxt-role="countdown-number">3</span>
            <span>秒后自动点击“下一节”</span>
          </div>
          <div class="xxt-actions">
            <button type="button" class="xxt-button" data-xxt-action="toggle-auto">
              暂停自动跳转
            </button>
            <button type="button" class="xxt-button" data-xxt-action="play-video" hidden>
              立即播放
            </button>
            <button type="button" class="xxt-button xxt-button--primary" data-xxt-action="recheck">
              重新识别
            </button>
          </div>
          <button
            type="button"
            class="xxt-button xxt-button--wide xxt-grader-entry"
            data-xxt-action="toggle-grader"
            hidden
          >作业批改</button>
          <section class="xxt-grader" data-xxt-role="grader" hidden>
            <div class="xxt-grader__title">DeepSeek 作业批改</div>
            <label class="xxt-field">
              <span class="xxt-field__label">API 密钥</span>
              <input
                type="password"
                class="xxt-input"
                data-xxt-role="api-key"
                placeholder="sk-..."
                autocomplete="new-password"
              />
            </label>
            <label class="xxt-field">
              <span class="xxt-field__label">模型</span>
              <select class="xxt-select" data-xxt-role="model">
                <option value="deepseek-reasoner" selected>DeepSeek Pro / Reasoner（默认，更准确）</option>
                <option value="deepseek-chat">DeepSeek Flash / Chat（快速）</option>
              </select>
            </label>
            <label class="xxt-field">
              <span class="xxt-field__label">系统提示词</span>
              <textarea class="xxt-textarea" data-xxt-role="system-prompt" rows="7"></textarea>
            </label>
            <div class="xxt-grader__security">密钥保存在扩展本地存储中，不回显到页面。</div>
            <button
              type="button"
              class="xxt-text-button"
              data-xxt-action="clear-api-key"
            >清除已保存密钥</button>
            <button
              type="button"
              class="xxt-button xxt-button--primary xxt-button--wide"
              data-xxt-action="run-grader"
            >开始批改</button>
            <div class="xxt-grader-status" data-xxt-role="grader-status">
              请填写 DeepSeek API 密钥后开始。
            </div>
          </section>
        </div>
      </section>
      <div class="xxt-toast" data-xxt-role="toast" data-tone="info" role="status" aria-live="polite">
        <span class="xxt-toast__text" data-xxt-role="toast-text"></span>
        <button
          type="button"
          class="xxt-toast__cancel"
          data-xxt-action="cancel"
          hidden
        >取消跳转</button>
      </div>
    `;

    document.documentElement.appendChild(root);
    state.root = root;

    const systemPrompt = root.querySelector('[data-xxt-role="system-prompt"]');
    if (systemPrompt && !systemPrompt.value) {
      systemPrompt.value = DEEPSEEK_DEFAULT_SYSTEM_PROMPT;
    }
  }

  function bindUI() {
    if (!state.root) {
      return;
    }

    state.root.addEventListener('click', (event) => {
      const target = event.composedPath().find((node) => {
        return node instanceof HTMLElement && node.dataset && node.dataset.xxtAction;
      });

      if (!target) {
        event.stopPropagation();
        return;
      }

      const action = target.dataset.xxtAction;
      event.preventDefault();
      event.stopPropagation();

      if (action === 'toggle-panel') {
        const collapsed = state.root.classList.toggle('xxt-collapsed');
        target.textContent = collapsed ? '+' : '−';
        target.setAttribute('aria-label', collapsed ? '展开助手面板' : '折叠助手面板');
        return;
      }

      if (action === 'toggle-auto') {
        const enableAutoNext = !(state.settings.autoNextOnBlank && state.settings.autoNextOnVideo && state.settings.autoNextOnDocument && state.settings.autoNextOnQuiz);
        state.settings.autoNextOnBlank = enableAutoNext;
        state.settings.autoNextOnVideo = enableAutoNext;
        state.settings.autoNextOnDocument = enableAutoNext;
        state.settings.autoNextOnQuiz = enableAutoNext;
        saveSettings();
        applySettingsUI();

        if (!enableAutoNext) {
          window.clearTimeout(state.video.completionTimer);
          window.clearTimeout(state.documentReader.scrollTimer);
          state.video.completionTimer = null;
          state.documentReader.scrollTimer = null;
          stopQuizController('已暂停自动跳转。', { silent: true });
          finishNavigationFlow('已暂停自动跳转。', { silent: true });
          cancelPendingAction('已暂停自动跳转');
          setActionStatus('自动跳转已暂停；页面类型识别和视频播放控制仍会继续。');
          showToast('已暂停自动跳转。', 'warning');
        } else {
          setActionStatus('已恢复自动跳转，将继续识别当前页面。');
          showToast('已恢复空白页自动跳转。', 'success');
          scheduleDetection('恢复自动跳转', 0);
        }
        return;
      }

      if (action === 'toggle-grader') {
        toggleGraderPanel();
        return;
      }

      if (action === 'run-grader') {
        startGrading();
        return;
      }

      if (action === 'clear-api-key') {
        clearStoredApiKey();
        setGraderStatus('已清除保存的 DeepSeek API 密钥。', '');
        return;
      }

      if (action === 'play-video') {
        state.video.autoplayBlocked = false;
        ensureVideoPlaying('手动播放').then((played) => {
          if (!played) {
            setVideoUI('浏览器阻止播放，请点击视频区域后重试。', 'blocked');
          }
        });
        return;
      }

      if (action === 'recheck') {
        cancelPendingAction('正在重新识别', { silent: true });
        state.quiz.handledKey = '';
        state.quiz.manualPausedKey = '';
        state.lastDetectedKey = '';
        state.lastDetectedType = '';
        state.retryCount = 0;
        scheduleDetection('手动重新识别', 0);
        return;
      }

      if (action === 'cancel') {
        cancelPendingAction('已取消本次自动跳转');
        showToast('已取消本次自动跳转。', 'warning');
      }
    });

    for (const eventName of ['keydown', 'keyup', 'input', 'change']) {
      state.root.addEventListener(eventName, (event) => {
        event.stopPropagation();
      }, false);
    }

    const apiKeyInput = state.root.querySelector('[data-xxt-role="api-key"]');
    if (apiKeyInput) {
      apiKeyInput.addEventListener('change', handleApiKeyInputChange);
      apiKeyInput.addEventListener('blur', handleApiKeyInputChange);
    }

    const modelSelect = state.root.querySelector('[data-xxt-role="model"]');
    if (modelSelect) {
      modelSelect.addEventListener('change', handleGraderModelChange);
    }
  }

  function handleApiKeyInputChange() {
    if (!state.root) {
      return;
    }

    const apiKeyInput = state.root.querySelector('[data-xxt-role="api-key"]');
    const apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
    if (!apiKey) {
      return;
    }

    state.grader.apiKey = apiKey;
    saveStoredApiKey(apiKey);
    updateGraderKeyHint();
    setGraderStatus('DeepSeek API 密钥已持久化保存。', 'success');
  }

  function loadSettings() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }

      chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_SETTINGS }, (result) => {
        const saved = result && result[STORAGE_KEY] ? result[STORAGE_KEY] : {};
        resolve({
          ...DEFAULT_SETTINGS,
          ...saved,
          autoNextOnQuiz: Number(saved.settingsVersion || 0) < 2 ? true : Boolean(saved.autoNextOnQuiz),
          settingsVersion: 2,
          delayMs: normalizeDelay(saved.delayMs)
        });
      });
    });
  }

  function saveSettings() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return;
    }

    chrome.storage.local.set({
      [STORAGE_KEY]: {
        ...state.settings,
        autoNextOnQuiz: Boolean(state.settings.autoNextOnQuiz),
        settingsVersion: 2,
        delayMs: normalizeDelay(state.settings.delayMs)
      }
    });
  }

  function normalizeDelay(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_SETTINGS.delayMs;
    }
    return Math.min(15000, Math.max(1000, Math.round(parsed)));
  }

  function applySettingsUI() {
    if (!state.root) {
      return;
    }

    const toggleButton = state.root.querySelector('[data-xxt-action="toggle-auto"]');
    if (toggleButton) {
      toggleButton.textContent = (state.settings.autoNextOnBlank || state.settings.autoNextOnVideo || state.settings.autoNextOnDocument || state.settings.autoNextOnQuiz)
        ? '暂停自动跳转'
        : '恢复自动跳转';
    }

    if (!state.settings.enabled) {
      setTypeUI('paused');
      setActionStatus('助手已暂停。');
    }
  }

  function installObservers() {
    state.observer = new MutationObserver((mutations) => {
      const hasRelevantChange = mutations.some((mutation) => {
        if (isAssistantMutation(mutation)) {
          return false;
        }

        if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
          return true;
        }

        return mutation.addedNodes && mutation.addedNodes.length > 0;
      });

      if (hasRelevantChange) {
        scheduleDetection('DOM 变化', 450);
      }
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });

    window.addEventListener('load', () => scheduleDetection('页面加载完成', 300));
    window.addEventListener('popstate', () => scheduleDetection('历史记录变化', 250));
    window.addEventListener('hashchange', () => scheduleDetection('地址变化', 250));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        scheduleDetection('页面恢复可见', 300);
      }
    });

    document.addEventListener('click', handlePageClick, true);

    installVideoGuards();
    window.setInterval(watchPage, 1000);
  }

  function handlePageClick(event) {
    if (!state.root) {
      return;
    }

    if (event.target instanceof Node && state.root.contains(event.target)) {
      return;
    }

    const clickedElement = event.target instanceof Element ? event.target : null;

    if (state.navigationFlow) {
      if (state.navigationFlow.autoClick) {
        return;
      }

      const manualVideoControl = clickedElement
        ? clickedElement.closest('#prevNextFocusNext, .maskDiv.jobFinishTip a, .maskDiv.jobFinishTip button, #popHeadFocusImg, #popCloseFocus')
        : null;

      if (manualVideoControl) {
        finishNavigationFlow('检测到手动操作，已暂停自动跳转。');
        showToast('检测到手动操作，已暂停本次自动跳转。', 'warning');
      }
      return;
    }

    if (!state.pendingActionKey) {
      return;
    }

    const nextButton = clickedElement
      ? clickedElement.closest('#prevNextFocusNext')
      : null;

    if (nextButton) {
      cancelPendingAction('检测到手动点击“下一节”，已取消自动点击。', { silent: true });
      showToast('检测到手动点击，已取消本次自动点击。', 'warning');
    }
  }

  function isAssistantMutation(mutation) {
    if (!state.root) {
      return false;
    }

    if (mutation.target instanceof Node && state.root.contains(mutation.target)) {
      return true;
    }

    return Array.from(mutation.addedNodes || []).some((node) => {
      return node === state.root || (node instanceof Node && state.root.contains(node));
    });
  }

  function watchPage() {
    if (!state.root) {
      return;
    }

    const frame = document.querySelector('#iframe');
    if (frame && !state.observedFrames.has(frame)) {
      state.observedFrames.add(frame);
      frame.addEventListener('load', () => scheduleDetection('内容 iframe 加载完成', 500));
    }

    const key = getContentKey();
    if (key === state.currentKey) {
      return;
    }

    const isFirstKey = !state.currentKey;
    state.currentKey = key;
    state.keyChangedAt = Date.now();
    state.lastDetectedKey = '';
    state.lastDetectedType = '';
    state.retryCount = 0;

    if (!isFirstKey) {
      state.lastClickedKey = '';
      state.lastPopupNextKey = '';
      state.quiz.handledKey = '';
      state.quiz.manualPausedKey = '';
      state.grader.opened = false;
      if (state.root) {
        const graderPanel = state.root.querySelector('[data-xxt-role="grader"]');
        const graderEntry = state.root.querySelector('[data-xxt-action="toggle-grader"]');
        if (graderPanel) {
          graderPanel.hidden = true;
        }
        if (graderEntry) {
          graderEntry.textContent = '作业批改';
        }
      }
      stopVideoController('页面切换');
      stopDocumentController('页面切换');
      stopQuizController('页面切换');
      finishNavigationFlow('页面已切换', { silent: true });
      cancelPendingAction('页面已切换', { silent: true });
    }

    scheduleDetection('章节变化', 450);
  }

  function scheduleDetection(reason, delay = 350) {
    window.clearTimeout(state.detectionTimer);
    state.detectionTimer = window.setTimeout(() => {
      runDetection(reason);
    }, delay);
  }

  function runDetection(reason) {
    if (!state.root || !state.settings) {
      return;
    }

    if (!state.settings.enabled) {
      setTypeUI('paused');
      setActionStatus('助手已暂停。');
      return;
    }

    const key = getContentKey();
    if (key !== state.currentKey) {
      state.currentKey = key;
      state.keyChangedAt = Date.now();
      state.lastDetectedKey = '';
      state.lastDetectedType = '';
      state.retryCount = 0;
      cancelPendingAction('页面已切换', { silent: true });
    }

    const result = detectCurrentPage();
    const sameStableResult = key === state.lastDetectedKey
      && result.type === state.lastDetectedType;

    setTypeUI(result.type, result.evidence, {
      notify: !sameStableResult
    });

    if (result.type === 'video') {
      startVideoController(key);
      if (!isDocumentFlowActive(key)) {
        stopDocumentController('当前页面不是 PPT/PDF 页面');
      }
      if (!isQuizFlowActive(key)) {
        stopQuizController('当前页面不是试题/作业页面');
      }
    } else if (result.type === 'document') {
      startDocumentController(key);
      if (!isVideoFlowActive(key)) {
        stopVideoController('当前页面不是视频页');
      }
      if (!isQuizFlowActive(key)) {
        stopQuizController('当前页面不是试题/作业页面');
      }
    } else if (result.type === 'quiz') {
      startQuizController(key);
      if (!isVideoFlowActive(key)) {
        stopVideoController('当前页面不是视频页');
      }
      if (!isDocumentFlowActive(key)) {
        stopDocumentController('当前页面不是 PPT/PDF 页面');
      }
    } else if (result.type === 'blank') {
      if (!isVideoFlowActive(key)) {
        stopVideoController('当前页面不是视频页');
      }

      if (!isDocumentFlowActive(key)) {
        stopDocumentController('当前页面不是 PPT/PDF 页面');
      }

      if (!isQuizFlowActive(key)) {
        stopQuizController('当前页面不是试题/作业页面');
      }
    }

    if (result.type === 'blank') {
      scheduleBlankAction(key);
    } else if (state.pendingActionKey) {
      cancelPendingAction('当前页面已不是空白页', {
        silent: result.type === 'loading' || result.type === 'unknown'
      });
    }

    if (result.type === 'loading' || result.type === 'unknown') {
      if (state.retryCount < 8) {
        state.retryCount += 1;
        scheduleDetection('等待页面稳定', 650);
      } else {
        setActionStatus('未识别到稳定内容，已停止自动点击。');
      }
    } else {
      state.retryCount = 0;
    }

    state.lastDetectedKey = key;
    state.lastDetectedType = result.type;

    if (reason === '手动重新识别') {
      const meta = TYPE_META[result.type] || TYPE_META.unknown;
      showToast(`重新识别结果：${meta.label}`, meta.tone);
    }
  }

  function detectCurrentPage() {
    const frame = document.querySelector('#iframe');
    if (!frame) {
      return {
        type: 'loading',
        evidence: '工作页已打开，正在等待内容 iframe 创建。'
      };
    }

    const frameDocument = getFrameDocument(frame);
    if (!frameDocument || !frameDocument.documentElement) {
      return {
        type: 'loading',
        evidence: '内容 iframe 已创建，正在等待页面加载。'
      };
    }

    const documents = collectDocuments(frameDocument);
    const detected = inspectDocuments(documents);
    if (detected) {
      return detected;
    }

    const frameText = normalizeText(
      frameDocument.body
        ? (frameDocument.body.innerText || frameDocument.body.textContent || '')
        : ''
    );

    if (BLANK_TEXT_PATTERN.test(frameText)) {
      return {
        type: 'blank',
        evidence: '检测到“暂无内容”提示。'
      };
    }

    const ready = frameDocument.readyState === 'complete'
      || frameDocument.readyState === 'interactive';
    const stableFor = Date.now() - state.keyChangedAt;

    if (ready && stableFor >= FALLBACK_BLANK_DELAY_MS && frameText.replace(/\s+/g, '').length <= 24) {
      return {
        type: 'blank',
        evidence: '内容 iframe 已加载并稳定，但没有视频、文档或题目模块。'
      };
    }

    if (!ready) {
      return {
        type: 'loading',
        evidence: '内容 iframe 尚未加载完成。'
      };
    }

    return {
      type: 'unknown',
      evidence: '页面已加载，但暂时没有匹配到已知内容标志。'
    };
  }

  function inspectDocuments(documents) {
    for (const doc of documents) {
      if (queryAny(doc, [
        'form#form1',
        '.singleQuesId',
        '.TiMu.newTiMu',
        '.Zy_TItle'
      ])) {
        return {
          type: 'quiz',
          evidence: '检测到作业表单、题目列表或题目标题节点。'
        };
      }
    }

    for (const doc of documents) {
      if (queryAny(doc, [
        'iframe.ans-insertvideo-online',
        '#video_html5_api',
        'video.vjs-tech',
        'video'
      ])) {
        return {
          type: 'video',
          evidence: '检测到视频附件 iframe 或视频播放器节点。'
        };
      }
    }

    for (const doc of documents) {
      if (queryAny(doc, [
        'iframe#panView',
        'iframe.ans-zt-attach-online',
        '#docContainer',
        '#downloadContent'
      ])) {
        return {
          type: 'document',
          evidence: '检测到 #panView 文档查看器或文档附件容器。'
        };
      }
    }

    return null;
  }

  function queryAny(doc, selectors) {
    for (const selector of selectors) {
      try {
        if (doc.querySelector(selector)) {
          return true;
        }
      } catch (error) {
        console.debug('[学习通助手] 选择器检查失败：', selector, error);
      }
    }

    return false;
  }

  function collectDocuments(rootDocument, documents = [], depth = 0) {
    if (!rootDocument || depth > MAX_FRAME_DEPTH || documents.includes(rootDocument)) {
      return documents;
    }

    documents.push(rootDocument);

    for (const frame of rootDocument.querySelectorAll('iframe')) {
      const childDocument = getFrameDocument(frame);
      if (childDocument) {
        collectDocuments(childDocument, documents, depth + 1);
      }
    }

    return documents;
  }

  function getFrameDocument(frame) {
    try {
      return frame && frame.contentDocument ? frame.contentDocument : null;
    } catch (error) {
      return null;
    }
  }

  function isVideoFlowActive(key) {
    return state.video.key === key
      && (state.video.completedKey === key
        || (state.navigationFlow && state.navigationFlow.key === key));
  }

  function isDocumentFlowActive(key) {
    return state.documentReader.key === key
      && (state.documentReader.scrollStartedKey === key
        || state.documentReader.completedKey === key
        || (state.navigationFlow && state.navigationFlow.key === key));
  }

  function isQuizFlowActive(key) {
    return state.quiz.key === key || state.lastPopupNextKey === key;
  }

  function startQuizController(key) {
    const isNewQuiz = state.quiz.key !== key;
    if (isNewQuiz) {
      stopQuizController('切换试题/作业页面', { silent: true });
      state.quiz.key = key;
      state.quiz.clickedKey = '';
      state.quiz.checks = 0;
    }

    if (state.quiz.handledKey === key
      || state.quiz.clickedKey === key
      || state.quiz.manualPausedKey === key
      || state.grader.opened
      || state.grader.running
      || state.quiz.timer) {
      return;
    }

    if (!state.settings.autoNextOnQuiz) {
      setActionStatus('试题/作业页面自动跳转已关闭。');
      return;
    }

    setActionStatus('识别为试题/作业页面，3 秒后点击页面中的“下一节”。');
    showToast('识别为试题/作业页面，3 秒后点击“下一节”。', 'info', true);

    state.quiz.timer = window.setTimeout(() => {
      state.quiz.timer = null;
      performQuizNext(key);
    }, 3000);
  }

  function stopQuizController(reason, options = {}) {
    window.clearTimeout(state.quiz.timer);
    state.quiz.timer = null;
    state.quiz.key = '';
    state.quiz.clickedKey = '';
    state.quiz.checks = 0;

    if (reason && !options.silent && state.lastDetectedType === 'quiz') {
      setActionStatus(reason);
    }
  }

  function performQuizNext(key) {
    if (getContentKey() !== key || state.lastDetectedType !== 'quiz') {
      stopQuizController('页面已切换，取消试题跳转。', { silent: true });
      return;
    }

    if (!state.settings.autoNextOnQuiz) {
      setActionStatus('试题自动跳转已暂停，本次点击已取消。');
      return;
    }

    const pageNextButton = getPageNextButton();
    if (!pageNextButton || !isElementVisible(pageNextButton)) {
      stopQuizController('没有找到可点击的页面“下一节”按钮。', { silent: true });
      showToast('没有找到可点击的页面“下一节”按钮。', 'danger');
      return;
    }

    state.quiz.clickedKey = key;
    state.quiz.handledKey = key;
    state.quiz.checks = 0;
    setActionStatus('已点击页面中的“下一节”，等待未完成任务提示。');
    showToast('已点击页面中的“下一节”，等待提示框。', 'info');
    pageNextButton.click();

    state.quiz.timer = window.setTimeout(() => {
      state.quiz.timer = null;
      checkQuizPopup(key);
    }, 900);
  }

  function checkQuizPopup(key) {
    if (getContentKey() !== key) {
      stopQuizController('页面已切换。', { silent: true });
      return;
    }

    const popup = getUnfinishedPopup();
    if (popup) {
      const popupNextButton = getPopupNextButton(popup);
      if (!popupNextButton || !isElementVisible(popupNextButton)) {
        stopQuizController('未找到弹窗中的“下一节”按钮。', { silent: true });
        showToast('未找到弹窗中的“下一节”按钮。', 'danger');
        return;
      }

      state.lastPopupNextKey = key;
      setActionStatus('检测到未完成任务提示，点击弹窗中的“下一节”。');
      showToast('检测到未完成任务提示，点击弹窗中的“下一节”。', 'warning', true);
      popupNextButton.click();

      state.quiz.timer = window.setTimeout(() => {
        state.quiz.timer = null;
        stopQuizController('已点击弹窗中的“下一节”。', { silent: true });
      }, 1800);
      return;
    }

    state.quiz.checks += 1;
    if (state.quiz.checks < 5) {
      state.quiz.timer = window.setTimeout(() => {
        state.quiz.timer = null;
        checkQuizPopup(key);
      }, 900);
      return;
    }

    stopQuizController('未检测到未完成任务提示，本次流程结束。', { silent: true });
  }

  function startDocumentController(key) {
    const isNewDocument = state.documentReader.key !== key;
    if (isNewDocument) {
      stopDocumentController('页面切换');
      state.documentReader.key = key;
      state.documentReader.startedAt = Date.now();
      state.documentReader.lastSignature = '';
      state.documentReader.stableSince = 0;
      state.documentReader.scrollCount = 0;
      state.documentReader.scrollStartedKey = '';
      state.documentReader.completedKey = '';
      setDocumentUI('正在等待 PPT/PDF 内容加载', 'waiting');
    }

    if (state.documentReader.completedKey === key) {
      return;
    }

    if (!state.documentReader.watchdogTimer) {
      state.documentReader.watchdogTimer = window.setInterval(() => {
        documentWatchdogTick(key);
      }, 700);
    }

    window.setTimeout(() => documentWatchdogTick(key), 0);
  }

  function stopDocumentController(reason) {
    window.clearInterval(state.documentReader.watchdogTimer);
    window.clearTimeout(state.documentReader.scrollTimer);

    state.documentReader.watchdogTimer = null;
    state.documentReader.scrollTimer = null;
    state.documentReader.key = '';
    state.documentReader.startedAt = 0;
    state.documentReader.lastSignature = '';
    state.documentReader.stableSince = 0;
    state.documentReader.scrollCount = 0;
    state.documentReader.scrollStartedKey = '';
    state.documentReader.completedKey = '';
    state.documentReader.lastStatus = '';
    state.documentReader.remoteFrames.clear();
    state.documentReader.lastScrollRequestId = '';
    state.documentReader.lastRemoteScrollResult = null;
    state.documentReader.probeInFlight = false;
    state.documentReader.lastProbeAt = 0;
    state.documentReader.probeErrorLogged = false;
    state.documentReader.foundRemoteLogged = false;
    setDocumentUI('', 'hidden');

    if (reason && state.lastDetectedType === 'document') {
      setActionStatus(reason);
    }
  }

  function documentWatchdogTick(key) {
    if (!state.settings || !state.settings.enabled) {
      setDocumentUI('助手已暂停，不会拉动滚动条或自动跳转。', 'paused');
      return;
    }

    if (getContentKey() !== key) {
      stopDocumentController('页面已切换。');
      return;
    }

    if (state.navigationFlow && state.navigationFlow.key === key) {
      return;
    }

    requestDocumentFrameProbe();

    const readiness = getDocumentReadiness();
    if (!readiness.ready) {
      setDocumentUI(readiness.message, 'waiting');
      return;
    }

    if (state.documentReader.scrollStartedKey !== key) {
      state.documentReader.scrollStartedKey = key;
      state.documentReader.scrollCount = 0;
      setDocumentUI('PPT/PDF 内容已稳定，开始拉动滚动条', 'ready');
      performDocumentScroll(key);
    }
  }

  function getFreshRemoteDocumentFrames() {
    const now = Date.now();
    const freshFrames = [];

    for (const [key, frame] of state.documentReader.remoteFrames.entries()) {
      if (now - frame.updatedAt > 5000) {
        state.documentReader.remoteFrames.delete(key);
        continue;
      }
      freshFrames.push(frame);
    }

    return freshFrames.sort((left, right) => Number(right.ready) - Number(left.ready));
  }

  function handleDocumentFrameMessage(event) {
    if (event.source === window || !state.root) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== CHILD_BRIDGE_SOURCE || data.type !== 'xxt-document-frame-state') {
      return;
    }

    if (!isAllowedDocumentFrameOrigin(event.origin)) {
      return;
    }

    storeRemoteDocumentFrameMetrics(data.metrics, data.requestId);

    if (state.documentReader.key) {
      window.setTimeout(() => {
        documentWatchdogTick(state.documentReader.key);
      }, 0);
    }
  }

  function storeRemoteDocumentFrameMetrics(metrics, requestId = '', expectedKey = '') {
    if (!state.root || !metrics || metrics.isViewer === false) {
      return;
    }

    if (expectedKey && expectedKey !== state.documentReader.key) {
      return;
    }

    const scrollHeight = Number(metrics.scrollHeight);
    const clientHeight = Number(metrics.clientHeight);
    if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) {
      return;
    }

    const normalizedFrame = {
      href: String(metrics.href || ''),
      ready: Boolean(metrics.ready),
      scrollHeight,
      clientHeight,
      scrollTop: Number(metrics.scrollTop) || 0,
      maxScrollTop: Number(metrics.maxScrollTop) || Math.max(0, scrollHeight - clientHeight),
      atBottom: Boolean(metrics.atBottom),
      pageCount: Number(metrics.pageCount) || 0,
      imageCount: Number(metrics.imageCount) || 0,
      updatedAt: Date.now()
    };

    const frameKey = `${normalizedFrame.href || 'viewer'}|${normalizedFrame.scrollHeight}|${normalizedFrame.clientHeight}`;
    state.documentReader.remoteFrames.set(frameKey, normalizedFrame);

    if (!state.documentReader.foundRemoteLogged) {
      state.documentReader.foundRemoteLogged = true;
      console.info('[学习通助手] 已收到真实 PPT/PDF 文档帧状态：', normalizedFrame);
    }

    if (requestId && requestId === state.documentReader.lastScrollRequestId) {
      state.documentReader.lastRemoteScrollResult = normalizedFrame;

      const positionText = normalizedFrame.atBottom
        ? `真实文档已到底部：${normalizedFrame.scrollTop}/${normalizedFrame.maxScrollTop}`
        : `真实文档滚动位置：${normalizedFrame.scrollTop}/${normalizedFrame.maxScrollTop}`;

      setDocumentUI(positionText, normalizedFrame.atBottom ? 'completed' : 'scrolling');
      console.info('[学习通助手] PPT/PDF 滚动位置：', {
        scrollTop: normalizedFrame.scrollTop,
        maxScrollTop: normalizedFrame.maxScrollTop,
        atBottom: normalizedFrame.atBottom,
        requestId
      });
    }
  }

  function requestDocumentFrameProbe() {
    if (!isExtensionRuntimeAvailable() || state.documentReader.probeInFlight) {
      return;
    }

    const probeKey = state.documentReader.key || '';

    const now = Date.now();
    if (now - state.documentReader.lastProbeAt < 1000) {
      return;
    }

    state.documentReader.probeInFlight = true;
    state.documentReader.lastProbeAt = now;

    try {
      chrome.runtime.sendMessage({ type: 'xxt-probe-document-frames', chapterKey: probeKey }, (response) => {
        state.documentReader.probeInFlight = false;

        if (probeKey && probeKey !== state.documentReader.key) {
          return;
        }

        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          logProbeError(runtimeError.message || String(runtimeError));
          return;
        }

        if (!response || !response.ok) {
          logProbeError(response && response.error ? response.error : 'Probe failed');
          return;
        }

        state.documentReader.probeErrorLogged = false;
        storeScriptingFrameResults(response.results, '', probeKey);
        if (state.documentReader.key) {
          window.setTimeout(() => documentWatchdogTick(state.documentReader.key), 0);
        }
      });
    } catch (error) {
      state.documentReader.probeInFlight = false;
      logProbeError(String(error && error.message ? error.message : error));
    }
  }

  function requestDocumentFrameScroll(requestId) {
    if (!isExtensionRuntimeAvailable()) {
      return;
    }

    try {
      const scrollKey = state.documentReader.key || '';
      chrome.runtime.sendMessage({
        type: 'xxt-scroll-document-frames',
        requestId,
        chapterKey: scrollKey
      }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          logProbeError(runtimeError.message || String(runtimeError));
          return;
        }

        if (!response || !response.ok) {
          logProbeError(response && response.error ? response.error : 'Scroll request failed');
          return;
        }

        if (scrollKey && scrollKey !== state.documentReader.key) {
          return;
        }

        storeScriptingFrameResults(response.results, requestId, scrollKey);
      });
    } catch (error) {
      logProbeError(String(error && error.message ? error.message : error));
    }
  }

  function storeScriptingFrameResults(results, requestId, expectedKey = '') {
    for (const item of results || []) {
      const metrics = item && item.result;
      if (!metrics || !metrics.isViewer) {
        continue;
      }

      storeRemoteDocumentFrameMetrics(metrics, requestId, expectedKey);
    }
  }

  function isExtensionRuntimeAvailable() {
    return typeof chrome !== 'undefined'
      && chrome.runtime
      && typeof chrome.runtime.sendMessage === 'function';
  }

  function logProbeError(message) {
    if (state.documentReader.probeErrorLogged) {
      return;
    }

    state.documentReader.probeErrorLogged = true;
    console.warn('[学习通助手] 跨域文档帧探测失败：', message);
  }

  function getDocumentReadiness() {
    const docs = getVideoDocuments();
    const remoteFrames = getFreshRemoteDocumentFrames();
    const readyRemoteFrames = remoteFrames.filter((frame) => {
      return frame.ready && frame.scrollHeight > frame.clientHeight + 50;
    });
    const hasRemoteViewer = docs.some((doc) => {
      return Array.from(doc.querySelectorAll('iframe')).some((frame) => {
        const source = frame.getAttribute('src') || frame.src || '';
        return /pan-yz\.chaoxing\.com|\/mooc-ans\/screen\/file|\/screen\/v2\//i.test(source);
      });
    });
    const moduleDocument = docs.find((doc) => doc.querySelector('#img, #panView, .imglook'));

    if (remoteFrames.length || hasRemoteViewer) {
      const signature = readyRemoteFrames.length
        ? readyRemoteFrames.map((frame) => [
            frame.href,
            frame.scrollHeight,
            frame.clientHeight,
            frame.pageCount,
            frame.imageCount,
            frame.scrollTop
          ].join(':')).join('|')
        : `waiting|${remoteFrames.map((frame) => `${frame.href}:${frame.scrollHeight}`).join('|')}`;

      if (signature !== state.documentReader.lastSignature) {
        state.documentReader.lastSignature = signature;
        state.documentReader.stableSince = Date.now();
      }

      const elapsed = Date.now() - state.documentReader.startedAt;
      const stableFor = Date.now() - state.documentReader.stableSince;

      if (readyRemoteFrames.length && stableFor >= 1200) {
        return {
          ready: true,
          message: 'PPT/PDF 真实文档已加载，开始拉动滚动条'
        };
      }

      if (elapsed >= 15000) {
        return {
          ready: true,
          message: 'PPT/PDF 内容等待超时，使用延迟兜底滚动'
        };
      }

      return {
        ready: false,
        message: '正在等待 PPT/PDF 真实文档加载'
      };
    }

    if (!moduleDocument) {
      const elapsed = Date.now() - state.documentReader.startedAt;
      const hasDocumentContainer = docs.some((doc) => {
        return Boolean(doc.querySelector('#docContainer, #downloadContent, iframe#panView, iframe.ans-zt-attach-online'));
      });

      return {
        ready: (hasDocumentContainer && elapsed >= 8000) || elapsed >= 12000,
        message: '正在等待 PPT/PDF 内容加载'
      };
    }

    const metrics = getDocumentMetrics(docs);
    const signature = [
      docs.length,
      metrics.imageCount,
      metrics.completedImages,
      metrics.canvasCount,
      metrics.maxScrollHeight,
      metrics.textLength
    ].join('|');

    if (signature !== state.documentReader.lastSignature) {
      state.documentReader.lastSignature = signature;
      state.documentReader.stableSince = Date.now();
    }

    const elapsed = Date.now() - state.documentReader.startedAt;
    const stableFor = Date.now() - state.documentReader.stableSince;
    const hasCompletedVisual = metrics.completedImages > 0 || metrics.canvasCount > 0;
    const hasContent = metrics.imageCount > 0
      ? hasCompletedVisual
      : (metrics.maxScrollHeight > 500 || metrics.textLength > 200 || metrics.canvasCount > 0);
    const ready = (hasContent && stableFor >= 1200) || elapsed >= 12000;

    return {
      ready,
      message: ready ? 'PPT/PDF 内容已稳定，开始拉动滚动条' : 'PPT/PDF 内容尚未加载完成'
    };
  }

  function getDocumentMetrics(docs) {
    let imageCount = 0;
    let completedImages = 0;
    let canvasCount = 0;
    let maxScrollHeight = 0;
    let textLength = 0;

    for (const doc of docs) {
      const visualNodes = doc.querySelectorAll('#img img, .imglook img, .documentImg, #panView img, #panView canvas, .imglook canvas');

      for (const node of visualNodes) {
        if (node.tagName === 'IMG') {
          imageCount += 1;
          if (node.complete && node.naturalWidth > 0) {
            completedImages += 1;
          }
        } else if (node.tagName === 'CANVAS') {
          canvasCount += 1;
        } else if (node.classList && node.classList.contains('documentImg')) {
          imageCount += 1;
          let hasBackgroundImage = false;
          try {
            const nodeWindow = node.ownerDocument ? node.ownerDocument.defaultView : null;
            const nodeStyle = nodeWindow ? nodeWindow.getComputedStyle(node) : null;
            hasBackgroundImage = Boolean(nodeStyle && nodeStyle.backgroundImage && nodeStyle.backgroundImage !== 'none');
          } catch (error) {
            hasBackgroundImage = false;
          }

          if (hasBackgroundImage || node.childElementCount > 0 || node.scrollHeight > 0) {
            completedImages += 1;
          }
        }
      }

      const heightCandidates = [
        doc.scrollingElement,
        doc.documentElement,
        doc.body,
        doc.querySelector('#img'),
        doc.querySelector('.imglook'),
        doc.querySelector('#docContainer')
      ];

      for (const element of heightCandidates) {
        if (!element) {
          continue;
        }
        maxScrollHeight = Math.max(maxScrollHeight, Number(element.scrollHeight) || 0);
      }

      const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || '') : '';
      textLength += normalizeText(bodyText).length;
    }

    return {
      imageCount,
      completedImages,
      canvasCount,
      maxScrollHeight,
      textLength
    };
  }

  function performDocumentScroll(key) {
    const reader = state.documentReader;
    if (!reader || reader.key !== key || reader.completedKey === key) {
      return;
    }

    if (getContentKey() !== key) {
      stopDocumentController('页面已切换。');
      return;
    }

    if (state.navigationFlow && state.navigationFlow.key === key) {
      return;
    }

    reader.scrollCount += 1;
    const count = reader.scrollCount;
    const requestId = broadcastDocumentScrollRequest(key, count);
    scrollDocumentToBottom();
    requestDocumentFrameScroll(requestId);

    setDocumentUI(`正在拉动 PPT/PDF 滚动条到底部（${count}/3次）`, 'scrolling');
    setActionStatus(`正在拉动 PPT/PDF 滚动条到底部（${count}/3次）。`);
    showToast(`正在拉动 PPT/PDF 滚动条到底部（${count}/3次）。`, 'info');

    window.setTimeout(() => {
      if (state.documentReader.key !== key || state.documentReader.lastScrollRequestId !== requestId) {
        return;
      }

      const remoteResult = state.documentReader.lastRemoteScrollResult;
      if (remoteResult) {
        const positionText = remoteResult.atBottom
          ? `真实文档滚动条已到底部：${remoteResult.scrollTop}/${remoteResult.maxScrollTop}（${count}/3次）`
          : `真实文档滚动位置：${remoteResult.scrollTop}/${remoteResult.maxScrollTop}（${count}/3次）`;
        setDocumentUI(positionText, remoteResult.atBottom ? 'completed' : 'scrolling');
      }
    }, 700);

    window.setTimeout(() => {
      if (state.documentReader.key !== key || state.documentReader.lastScrollRequestId !== requestId) {
        return;
      }

      if (!state.documentReader.lastRemoteScrollResult) {
        setDocumentUI('未收到跨域文档帧回报；请重载 v1.10.0 扩展并刷新页面。', 'blocked');
        console.warn('[学习通助手] 未收到 PPT/PDF 跨域文档帧的滚动回报。请重载 v1.10.0 扩展并刷新页面。');
      }
    }, 1600);

    if (count < 3) {
      reader.scrollTimer = window.setTimeout(() => {
        performDocumentScroll(key);
      }, 2000);
      return;
    }

    reader.completedKey = key;
    setDocumentUI('PPT/PDF 已完成 3 次滚动，准备进入下一节。', 'completed');

    if (!state.settings.autoNextOnDocument) {
      setActionStatus('PPT/PDF 已滚动到底部，但自动跳转当前不可用。');
      showToast('PPT/PDF 已滚动到底部，但自动跳转当前不可用。', 'warning');
      return;
    }

    setActionStatus('PPT/PDF 已完成 3 次滚动，准备进入下一节，1 秒后点击页面中的“下一节”。');
    reader.scrollTimer = window.setTimeout(() => {
      beginNextNavigation(key, 'PPT/PDF');
    }, 1200);
  }

  function broadcastDocumentScrollRequest(key, count) {
    const requestId = `${key}::${count}::${Date.now()}::${++state.documentReader.scrollRequestCounter}`;
    state.documentReader.lastScrollRequestId = requestId;
    state.documentReader.lastRemoteScrollResult = null;

    const message = {
      source: CHILD_BRIDGE_SOURCE,
      type: 'xxt-document-scroll-request',
      requestId,
      chapterKey: key,
      attempt: count,
      relayDepth: 0
    };

    sendDocumentMessageToFrameTree(document, message, 0);
    return requestId;
  }

  function sendDocumentMessageToFrameTree(doc, message, depth) {
    if (!doc || depth > 6) {
      return;
    }

    for (const frame of doc.querySelectorAll('iframe')) {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage(message, '*');
        }
      } catch (error) {
        // Ignore inaccessible child frames.
      }

      try {
        if (frame.contentDocument) {
          sendDocumentMessageToFrameTree(frame.contentDocument, message, depth + 1);
        }
      } catch (error) {
        // Ignore cross-origin child frames.
      }
    }
  }

  function scrollDocumentToBottom() {
    const docs = getVideoDocuments();
    let scrolledTargets = 0;

    for (const doc of docs) {
      const candidates = new Set([
        doc.scrollingElement,
        doc.documentElement,
        doc.body
      ]);

      const selectors = [
        '#img',
        '.imglook',
        '#docContainer',
        '.documentImg',
        '[style*="overflow-y"]',
        '[style*="overflow-Y"]'
      ];

      for (const selector of selectors) {
        for (const element of doc.querySelectorAll(selector)) {
          candidates.add(element);
        }
      }

      for (const element of candidates) {
        if (!element) {
          continue;
        }

        const maxScrollTop = Math.max(
          Number(element.scrollHeight) || 0,
          Number(element.clientHeight) || 0
        );

        try {
          element.scrollTop = maxScrollTop;
          if (typeof element.scrollTo === 'function') {
            element.scrollTo(0, maxScrollTop);
          }
        } catch (error) {
          continue;
        }

        if (maxScrollTop > (Number(element.clientHeight) || 0) + 2 || element.scrollTop > 0) {
          scrolledTargets += 1;
        }

        try {
          const EventConstructor = doc.defaultView ? doc.defaultView.Event : Event;
          element.dispatchEvent(new EventConstructor('scroll', { bubbles: true }));
        } catch (error) {
          // Ignore event dispatch failures from unusual page frames.
        }
      }

      const wheelTarget = doc.querySelector('#img, .imglook') || doc.scrollingElement;
      const frameView = doc.defaultView;
      if (wheelTarget && frameView && typeof frameView.WheelEvent === 'function') {
        try {
          wheelTarget.dispatchEvent(new frameView.WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: 100000
          }));
        } catch (error) {
          // Ignore wheel event failures from unusual page frames.
        }
      }

      const lastPageNode = doc.querySelector(
        '#img .documentImg:last-child, .imglook .documentImg:last-child, #panView img:last-of-type'
      );

      if (lastPageNode && typeof lastPageNode.scrollIntoView === 'function') {
        try {
          lastPageNode.scrollIntoView({ block: 'end' });
        } catch (error) {
          // Ignore lazy-loading scroll failures.
        }
      }

      const frameWindow = doc.defaultView;
      if (frameWindow) {
        try {
          const maxWindowScroll = Math.max(
            Number(doc.documentElement.scrollHeight) || 0,
            Number(doc.body ? doc.body.scrollHeight : 0) || 0
          );
          frameWindow.scrollTo(0, maxWindowScroll);
        } catch (error) {
          // Ignore frame scroll failures.
        }
      }
    }

    return scrolledTargets;
  }

  function setDocumentUI(text, status) {
    if (!state.root) {
      return;
    }

    const statusElement = state.root.querySelector('[data-xxt-role="document-status"]');
    const textElement = state.root.querySelector('[data-xxt-role="document-text"]');

    if (!statusElement || !textElement) {
      return;
    }

    if (!text || status === 'hidden') {
      statusElement.hidden = true;
      state.documentReader.lastStatus = '';
      return;
    }

    statusElement.hidden = false;
    statusElement.dataset.status = status || '';

    if (textElement.textContent !== text || state.documentReader.lastStatus !== status) {
      textElement.textContent = text;
      state.documentReader.lastStatus = status;
    }
  }

  function startVideoController(key) {
    installVideoGuards();

    const isNewVideo = state.video.key !== key;
    if (isNewVideo) {
      stopVideoController('切换视频页面');
      state.video.key = key;
      state.video.completedKey = '';
      state.video.autoplayBlocked = false;
      updatePlayButtonVisibility(false);
      setVideoUI('准备自动播放视频，正在检查播放状态。', 'waiting');
    }

    if (state.video.completedKey === key) {
      return;
    }

    if (!state.video.watchdogTimer) {
      state.video.watchdogTimer = window.setInterval(() => {
        videoWatchdogTick(key);
      }, 800);
    }

    window.setTimeout(() => videoWatchdogTick(key), 0);
  }

  function stopVideoController(reason) {
    window.clearInterval(state.video.watchdogTimer);
    window.clearTimeout(state.video.completionTimer);

    state.video.watchdogTimer = null;
    state.video.completionTimer = null;
    state.video.key = '';
    state.video.completedKey = '';
    state.video.playInFlight = false;
    state.video.autoplayBlocked = false;
    state.video.lastStatus = '';
    updatePlayButtonVisibility(false);
    setVideoUI('', 'hidden');

    if (reason && state.lastDetectedType === 'video') {
      setActionStatus(reason);
    }
  }

  function videoWatchdogTick(key) {
    if (!state.settings || !state.settings.enabled) {
      setVideoUI('助手已暂停，不会自动播放或跳转。', 'paused');
      return;
    }

    if (getContentKey() !== key) {
      stopVideoController('页面已切换。');
      return;
    }

    if (state.navigationFlow && state.navigationFlow.key === key) {
      return;
    }

    const documents = getVideoDocuments();
    installVideoGuardsOnDocuments(documents);

    const video = findVideoElement(documents);
    if (!video) {
      setVideoUI('正在等待视频播放器加载。', 'waiting');
      return;
    }

    forceVideoMuted(video);

    if (isVideoFinished(video)) {
      handleVideoFinished(key);
      return;
    }

    if (video.paused) {
      ensureVideoPlaying('定时检查到暂停');
      return;
    }

    state.video.autoplayBlocked = false;
    updatePlayButtonVisibility(false);
    setVideoUI(formatVideoPlayingText(video), 'playing');
  }

  async function ensureVideoPlaying(reason) {
    const video = findVideoElement();
    if (!video || isVideoFinished(video)) {
      return false;
    }

    forceVideoMuted(video);

    if (!video.paused) {
      state.video.autoplayBlocked = false;
      updatePlayButtonVisibility(false);
      setVideoUI(formatVideoPlayingText(video), 'playing');
      return true;
    }

    if (state.video.playInFlight) {
      return false;
    }

    state.video.playInFlight = true;

    try {
      setVideoUI('检测到视频暂停，正在自动恢复播放。', 'playing');
      await video.play();
      state.video.autoplayBlocked = false;
      updatePlayButtonVisibility(false);
      setVideoUI(formatVideoPlayingText(video), 'playing');
      return true;
    } catch (error) {
      const wasBlockedBefore = state.video.autoplayBlocked;

      try {
        forceVideoMuted(video);
        await video.play();

        state.video.autoplayBlocked = false;
        updatePlayButtonVisibility(false);
        setVideoUI(formatVideoPlayingText(video), 'playing');

        if (!wasBlockedBefore) {
          showToast('浏览器限制了自动播放，已先静音播放。', 'warning');
        }

        return true;
      } catch (mutedError) {
        state.video.autoplayBlocked = true;
        updatePlayButtonVisibility(true);
        setVideoUI('浏览器阻止了自动播放，请点击“立即播放”或视频区域。', 'blocked');

        if (!wasBlockedBefore) {
          showToast('浏览器阻止了自动播放，请点击“立即播放”。', 'warning', true);
        }

        console.debug('[学习通助手] 视频播放失败：', reason, error, mutedError);
        return false;
      }
    } finally {
      state.video.playInFlight = false;
    }
  }

  function forceVideoMuted(video) {
    if (!video || video.tagName !== 'VIDEO') {
      return;
    }

    try {
      video.muted = true;
      video.defaultMuted = true;
    } catch (error) {
      // Ignore players that prevent direct media property updates.
    }
  }

  function findVideoElement(documents) {
    const docs = documents || getVideoDocuments();
    let fallbackVideo = null;

    for (const doc of docs) {
      const selectors = [
        'video#video_html5_api',
        'video.vjs-tech',
        'video'
      ];

      for (const selector of selectors) {
        const video = doc.querySelector(selector);
        if (!video) {
          continue;
        }

        if (!fallbackVideo) {
          fallbackVideo = video;
        }

        if (video.readyState > 0 || Number.isFinite(Number(video.duration))) {
          return video;
        }
      }
    }

    return fallbackVideo;
  }

  function getVideoDocuments() {
    const frame = document.querySelector('#iframe');
    const rootDocument = frame ? getFrameDocument(frame) : document;
    return rootDocument ? collectDocuments(rootDocument) : [document];
  }

  function isVideoFinished(video) {
    if (!video || video.tagName !== 'VIDEO' || !video.isConnected) {
      return false;
    }

    if (video.ended) {
      return true;
    }

    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);

    return Number.isFinite(duration)
      && duration > 0
      && currentTime > 0.5
      && currentTime >= duration - 0.35;
  }

  function handleVideoFinished(key) {
    if (!key || key !== state.video.key || getContentKey() !== key) {
      return;
    }

    if (state.video.completedKey === key) {
      return;
    }

    state.video.completedKey = key;
    state.video.autoplayBlocked = false;
    updatePlayButtonVisibility(false);

    const delay = Math.min(10000, Math.max(1000, Math.round(Number(state.settings.videoNextDelayMs) || 2000)));
    const delaySeconds = delay / 1000;
    const delayText = Number.isInteger(delaySeconds) ? String(delaySeconds) : delaySeconds.toFixed(1);
    setVideoUI(`视频已播放完毕，${delayText} 秒后点击页面中的“下一节”。`, 'completed');

    if (!state.settings.autoNextOnVideo) {
      setActionStatus('视频已播放完毕；自动跳转当前已暂停。');
      showToast('视频已播放完毕，自动跳转已暂停。', 'warning');
      return;
    }

    setActionStatus(`视频已播放完毕，${delayText} 秒后点击页面中的“下一节”。`);
    showToast(`视频已播放完毕，${delayText} 秒后自动进入下一节。`, 'success', true);

    state.video.completionTimer = window.setTimeout(() => {
      beginNextNavigation(key, '视频');
    }, delay);
  }

  function formatVideoPlayingText(video) {
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);

    if (!Number.isFinite(duration) || duration <= 0) {
      return '视频正在播放，持续检查暂停和播放结束状态。';
    }

    const percent = Math.min(100, Math.max(0, Math.round((currentTime / duration) * 100)));
    return `视频正在播放，当前进度 ${percent}%。`;
  }

  function setVideoUI(text, status) {
    if (!state.root) {
      return;
    }

    const statusElement = state.root.querySelector('[data-xxt-role="video-status"]');
    const textElement = state.root.querySelector('[data-xxt-role="video-text"]');

    if (!statusElement || !textElement) {
      return;
    }

    if (!text || status === 'hidden') {
      statusElement.hidden = true;
      state.video.lastStatus = '';
      return;
    }

    statusElement.hidden = false;
    statusElement.dataset.status = status || '';

    if (textElement.textContent !== text || state.video.lastStatus !== status) {
      textElement.textContent = text;
      state.video.lastStatus = status;
    }
  }

  function updatePlayButtonVisibility(visible) {
    if (!state.root) {
      return;
    }

    const playButton = state.root.querySelector('[data-xxt-action="play-video"]');
    if (playButton) {
      playButton.hidden = !visible;
    }
  }

  function installVideoGuards() {
    installVideoGuardsOnDocuments([document]);
  }

  function installVideoGuardsOnDocuments(documents) {
    for (const doc of documents) {
      if (!doc || state.guardedDocuments.has(doc)) {
        continue;
      }

      state.guardedDocuments.add(doc);
      doc.addEventListener('visibilitychange', blockPauseEvent, true);
      doc.addEventListener('mouseleave', blockPauseEvent, true);
      doc.addEventListener('pointerleave', blockPauseEvent, true);
      doc.addEventListener('mouseout', blockPauseEventWhenLeaving, true);
      doc.addEventListener('pause', handleVideoPauseEvent, true);
      doc.addEventListener('ended', handleVideoEndedEvent, true);
      doc.addEventListener('volumechange', handleVideoVolumeChange, true);
      doc.addEventListener('play', handleVideoPlayEvent, true);

      const frameWindow = doc.defaultView;
      if (frameWindow && !state.guardedWindows.has(frameWindow)) {
        state.guardedWindows.add(frameWindow);
        frameWindow.addEventListener('blur', blockPauseEvent, true);
        frameWindow.addEventListener('pointerleave', blockPauseEvent, true);
        frameWindow.addEventListener('pagehide', () => stopVideoController('页面隐藏。'), true);
      }
    }
  }

  function blockPauseEvent(event) {
    if (state.lastDetectedType !== 'video' || state.navigationFlow) {
      return;
    }

    if (state.root && isNodeInside(event.target, state.root)) {
      return;
    }

    event.stopImmediatePropagation();
  }

  function blockPauseEventWhenLeaving(event) {
    if (!event.relatedTarget) {
      blockPauseEvent(event);
    }
  }

  function handleVideoPauseEvent(event) {
    const video = event.target;
    if (state.lastDetectedType !== 'video' || state.navigationFlow) {
      return;
    }

    if (!video || video.tagName !== 'VIDEO' || isVideoFinished(video)) {
      return;
    }

    window.setTimeout(() => {
      ensureVideoPlaying('捕获到视频 pause 事件');
    }, 120);
  }

  function handleVideoVolumeChange(event) {
    const video = event.target;
    if (state.lastDetectedType === 'video' && video && video.tagName === 'VIDEO') {
      forceVideoMuted(video);
    }
  }

  function handleVideoPlayEvent(event) {
    const video = event.target;
    if (state.lastDetectedType === 'video' && video && video.tagName === 'VIDEO') {
      forceVideoMuted(video);
    }
  }

  function handleVideoEndedEvent(event) {
    const video = event.target;
    if (state.lastDetectedType !== 'video' || state.navigationFlow) {
      return;
    }

    if (!video || video.tagName !== 'VIDEO') {
      return;
    }

    const key = state.video.key;
    if (!key || getContentKey() !== key) {
      return;
    }

    handleVideoFinished(key);
  }

  function isNodeInside(node, parent) {
    if (!node || !parent) {
      return false;
    }

    try {
      return parent.contains(node);
    } catch (error) {
      return false;
    }
  }

  function beginNextNavigation(key, sourceLabel = '内容') {
    if (state.lastPopupNextKey === key) {
      return;
    }

    if (state.navigationFlow) {
      return;
    }

    const completionText = sourceLabel === '视频'
      ? '视频已播放完毕'
      : 'PPT/PDF 已滚动到底部';

    if (!state.settings || !state.settings.enabled) {
      setActionStatus(`${completionText}，但自动跳转当前不可用。`);
      return;
    }

    const autoNextEnabled = sourceLabel === '视频'
      ? state.settings.autoNextOnVideo
      : state.settings.autoNextOnDocument;

    if (!autoNextEnabled) {
      setActionStatus(`${completionText}，但自动跳转当前不可用。`);
      return;
    }

    if (getContentKey() !== key) {
      setActionStatus('页面已切换，取消自动跳转。');
      return;
    }

    if (sourceLabel === '视频' && state.video.completedKey !== key) {
      return;
    }

    if (sourceLabel === 'PPT/PDF' && state.documentReader.completedKey !== key) {
      return;
    }

    state.navigationFlow = {
      key,
      attempt: 0,
      closeAttempts: 0,
      emptyChecks: 0,
      popupNextUsed: false,
      autoClick: false,
      phase: 'preparing'
    };

    setActionStatus(`${completionText}，正在点击页面中的“下一节”。`);
    attemptPageNext(key);
  }

  function attemptPageNext(key) {
    const flow = state.navigationFlow;
    if (!flow || flow.key !== key) {
      return;
    }

    if (getContentKey() !== key) {
      finishNavigationFlow('页面已切换。', { silent: true });
      return;
    }

    const popup = getUnfinishedPopup();
    if (popup) {
      if (flow.closeAttempts >= 2) {
        usePopupNextForFlow(flow, popup);
        return;
      }

      flow.closeAttempts += 1;
      flow.phase = 'closing-popup';
      clickPopupClose(popup);
      setActionStatus('检测到未完成任务提示，先关闭弹窗。');

      state.navigationTimer = window.setTimeout(() => {
        attemptPageNext(key);
      }, 450);
      return;
    }

    const pageNextButton = getPageNextButton();
    if (!pageNextButton || !isElementVisible(pageNextButton)) {
      finishNavigationFlow('没有找到可点击的页面“下一节”按钮。');
      showToast('没有找到可点击的页面“下一节”按钮。', 'danger');
      return;
    }

    flow.attempt += 1;
    flow.phase = 'clicked-page-next';
    flow.emptyChecks = 0;
    setActionStatus(`正在点击页面中的“下一节”（第 ${flow.attempt} 次）。`);
    showToast(`已点击页面中的“下一节”（第 ${flow.attempt} 次）。`, 'info');
    flow.autoClick = true;
    pageNextButton.click();
    window.setTimeout(() => {
      if (state.navigationFlow === flow) {
        flow.autoClick = false;
      }
    }, 0);

    state.navigationTimer = window.setTimeout(() => {
      checkNavigationFlow(key);
    }, 1200);
  }

  function checkNavigationFlow(key) {
    const flow = state.navigationFlow;
    if (!flow || flow.key !== key) {
      return;
    }

    if (getContentKey() !== key) {
      finishNavigationFlow('已进入下一节。', { silent: true });
      return;
    }

    const popup = getUnfinishedPopup();
    if (popup) {
      if (flow.attempt < 2) {
        flow.closeAttempts = 0;
        flow.phase = 'retry-after-popup';
        clickPopupClose(popup);
        setActionStatus('仍提示任务点未完成，已关闭弹窗，准备再次点击页面“下一节”。');

        state.navigationTimer = window.setTimeout(() => {
          attemptPageNext(key);
        }, 500);
        return;
      }

      usePopupNextForFlow(flow, popup);
      return;
    }

    flow.emptyChecks += 1;
    if (flow.emptyChecks < 3) {
      state.navigationTimer = window.setTimeout(() => {
        checkNavigationFlow(key);
      }, 900);
      return;
    }

    finishNavigationFlow('未检测到弹窗，页面可能正在切换。');
  }

  function usePopupNextForFlow(flow, popup) {
    if (!flow || flow.popupNextUsed) {
      finishNavigationFlow('已处理未完成任务提示。', { silent: true });
      return;
    }

    const popupNextButton = getPopupNextButton(popup);
    if (!popupNextButton || !isElementVisible(popupNextButton)) {
      finishNavigationFlow('未找到弹窗中的“下一节”按钮。');
      showToast('未找到弹窗中的“下一节”按钮。', 'danger');
      return;
    }

    flow.popupNextUsed = true;
    flow.phase = 'clicked-popup-next';
    state.lastPopupNextKey = flow.key;
    setActionStatus('任务点仍未完成，点击弹窗中的“下一节”。');
    showToast('任务点仍未完成，改点弹窗中的“下一节”。', 'warning', true);
    flow.autoClick = true;
    popupNextButton.click();
    window.setTimeout(() => {
      if (state.navigationFlow === flow) {
        flow.autoClick = false;
      }
    }, 0);

    state.navigationTimer = window.setTimeout(() => {
      finishNavigationFlow('已点击弹窗中的“下一节”。', { silent: true });
    }, 1800);
  }

  function getPageNextButton() {
    return document.querySelector('#prevNextFocusNext');
  }

  function getUnfinishedPopup() {
    const popups = document.querySelectorAll('#mainid div.maskDiv.jobFinishTip, div.maskDiv.jobFinishTip');
    return Array.from(popups).find(isElementVisible) || null;
  }

  function getPopupNextButton(popup) {
    const candidates = Array.from(popup.querySelectorAll('a, button, [role="button"]'));
    return candidates.find((element) => {
      return isElementVisible(element) && normalizeText(element.textContent).includes('下一节');
    }) || null;
  }

  function clickPopupClose(popup) {
    const closeImage = popup.querySelector('#popHeadFocusImg');
    if (closeImage && isElementVisible(closeImage)) {
      closeImage.click();
      return true;
    }

    const closeButton = popup.querySelector('#popCloseFocus, #popHeadFocus');
    if (closeButton && isElementVisible(closeButton)) {
      closeButton.click();
      return true;
    }

    return false;
  }

  function isElementVisible(element) {
    if (!element || !element.isConnected || element.hidden) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function finishNavigationFlow(reason, options = {}) {
    window.clearTimeout(state.navigationTimer);
    state.navigationTimer = null;
    state.navigationFlow = null;

    if (!options.silent && reason) {
      setActionStatus(reason);
    }
  }
  function initChildFrameBridge() {
    childBridgeState.isViewer = isDocumentViewerFrame();

    window.addEventListener('message', handleChildBridgeMessage, false);

    if (!childBridgeState.isViewer) {
      return;
    }

    console.info('[学习通助手] PPT/PDF pan-yz 子帧已启动：', window.location.href);

    const sendState = () => sendViewerFrameState();
    sendState();

    window.addEventListener('load', sendState);
    window.addEventListener('scroll', () => {
      if (Date.now() - childBridgeState.lastSentAt >= 250) {
        sendState();
      }
    }, { passive: true });

    childBridgeState.stateTimer = window.setInterval(sendState, 1000);
  }

  function isDocumentViewerFrame() {
    const host = String(window.location.hostname || '').toLowerCase();
    const path = String(window.location.pathname || '');
    const isPanViewer = host === 'pan-yz.chaoxing.com' && /\/screen\//i.test(path);
    const isSameOriginScreen = host === 'mooc1.jjxy.zufe.edu.cn'
      && /\/mooc-ans\/screen\/file/i.test(path)
      && document.querySelectorAll('.pageNum, .anchor').length > 0;
    return isPanViewer || isSameOriginScreen;
  }

  function getViewerFrameMetrics() {
    const html = document.documentElement;
    const body = document.body;
    const scrollHeight = Math.max(
      Number(html ? html.scrollHeight : 0) || 0,
      Number(body ? body.scrollHeight : 0) || 0
    );
    const clientHeight = Number(html && html.clientHeight)
      || Number(window.innerHeight)
      || 0;
    const scrollTop = Math.max(
      Number(window.scrollY) || 0,
      Number(html ? html.scrollTop : 0) || 0,
      Number(body ? body.scrollTop : 0) || 0
    );
    const pageCount = document.querySelectorAll('.pageNum, .anchor, [id^="anchor"]').length;
    const imageCount = document.images.length;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const ready = document.readyState === 'complete'
      && (pageCount > 0 || imageCount > 0)
      && scrollHeight > clientHeight + 50;

    return {
      href: window.location.href,
      ready,
      scrollHeight,
      clientHeight,
      scrollTop,
      maxScrollTop,
      atBottom: maxScrollTop > 0 && scrollTop >= maxScrollTop - 4,
      pageCount,
      imageCount
    };
  }

  function sendViewerFrameState(requestId = '', metricsOverride = null) {
    if (!childBridgeState.isViewer) {
      return;
    }

    const metrics = metricsOverride || getViewerFrameMetrics();
    childBridgeState.lastSentAt = Date.now();

    window.top.postMessage({
      source: CHILD_BRIDGE_SOURCE,
      type: 'xxt-document-frame-state',
      requestId,
      href: window.location.href,
      metrics,
      timestamp: Date.now()
    }, '*');
  }

  function handleChildBridgeMessage(event) {
    const data = event.data;
    if (!data || data.source !== CHILD_BRIDGE_SOURCE || data.type !== 'xxt-document-scroll-request') {
      return;
    }

    const requestId = String(data.requestId || '');
    if (requestId && childBridgeState.handledRequests.has(requestId)) {
      return;
    }

    if (requestId) {
      childBridgeState.handledRequests.add(requestId);
      if (childBridgeState.handledRequests.size > 80) {
        childBridgeState.handledRequests.clear();
      }
    }

    if (childBridgeState.isViewer) {
      const metrics = scrollViewerFrameToBottom();
      console.info('[学习通助手] pan-yz 子帧已执行滚动：', {
        requestId,
        scrollTop: metrics.scrollTop,
        maxScrollTop: metrics.maxScrollTop,
        atBottom: metrics.atBottom
      });
      sendViewerFrameState(requestId, metrics);
      return;
    }

    const relayDepth = Number(data.relayDepth) || 0;
    if (relayDepth < 6) {
      relayDocumentMessageToChildFrames({
        ...data,
        relayDepth: relayDepth + 1
      });
    }
  }

  function relayDocumentMessageToChildFrames(message) {
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentWindow) {
          frame.contentWindow.postMessage(message, '*');
        }
      } catch (error) {
        // Ignore inaccessible child frames.
      }
    }
  }

  function scrollViewerFrameToBottom() {
    const html = document.documentElement;
    const body = document.body;
    const maxScrollTop = Math.max(
      Number(html ? html.scrollHeight : 0) || 0,
      Number(body ? body.scrollHeight : 0) || 0
    );

    try {
      window.scrollTo(0, maxScrollTop);
    } catch (error) {
      // Continue with direct element scrolling.
    }

    try {
      if (html) {
        html.scrollTop = maxScrollTop;
      }
      if (body) {
        body.scrollTop = maxScrollTop;
      }
    } catch (error) {
      // Ignore direct scroll failures.
    }

    try {
      window.dispatchEvent(new Event('scroll'));
      if (html) {
        html.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    } catch (error) {
      // Ignore event dispatch failures.
    }

    return getViewerFrameMetrics();
  }

  function getContentKey() {
    const frame = document.querySelector('#iframe');
    const frameSource = frame ? (frame.getAttribute('src') || frame.src || '') : '';
    const chapterId = new URL(window.location.href).searchParams.get('chapterId') || '';
    return `${chapterId}::${frameSource}`;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function setTypeUI(type, evidence, options = {}) {
    if (!state.root) {
      return;
    }

    const meta = TYPE_META[type] || TYPE_META.unknown;
    const typeElement = state.root.querySelector('[data-xxt-role="type"]');
    const evidenceElement = state.root.querySelector('[data-xxt-role="evidence"]');

    state.root.dataset.type = type;

    const graderEntry = state.root.querySelector('[data-xxt-action="toggle-grader"]');
    const graderPanel = state.root.querySelector('[data-xxt-role="grader"]');
    if (graderEntry) {
      graderEntry.hidden = type !== 'quiz';
    }

    if (type !== 'quiz') {
      state.grader.opened = false;
      if (graderPanel) {
        graderPanel.hidden = true;
      }
      if (graderEntry) {
        graderEntry.textContent = '作业批改';
      }
    }

    if (typeElement && typeElement.textContent !== meta.label) {
      typeElement.textContent = meta.label;
    }

    const evidenceText = evidence || meta.evidence;
    if (evidenceElement && evidenceElement.textContent !== evidenceText) {
      evidenceElement.textContent = evidenceText;
    }

    if (type !== 'blank') {
      hideCountdown();
    }

    if (options.notify && type !== 'loading' && type !== 'unknown' && type !== 'blank') {
      showToast(`当前页面识别为：${meta.label}`, meta.tone);
    }
  }

  function setActionStatus(message) {
    if (!state.root) {
      return;
    }

    const actionElement = state.root.querySelector('[data-xxt-role="action"]');
    if (actionElement && actionElement.textContent !== message) {
      actionElement.textContent = message;
    }
  }

  function loadStoredModel() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve('deepseek-reasoner');
        return;
      }

      chrome.storage.local.get({ [MODEL_STORAGE_KEY]: 'deepseek-reasoner' }, (result) => {
        const savedModel = String(result && result[MODEL_STORAGE_KEY] ? result[MODEL_STORAGE_KEY] : '');
        resolve(GRADER_MODELS.includes(savedModel) ? savedModel : 'deepseek-reasoner');
      });
    });
  }

  function saveStoredModel(model) {
    const normalizedModel = GRADER_MODELS.includes(model) ? model : 'deepseek-reasoner';
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      return;
    }

    chrome.storage.local.set({ [MODEL_STORAGE_KEY]: normalizedModel });
  }

  function updateGraderModelSelection() {
    if (!state.root) {
      return;
    }

    const modelSelect = state.root.querySelector('[data-xxt-role="model"]');
    if (!modelSelect) {
      return;
    }

    if (!GRADER_MODELS.includes(state.grader.model)) {
      state.grader.model = 'deepseek-reasoner';
    }

    modelSelect.value = state.grader.model;
  }

  function handleGraderModelChange() {
    if (!state.root) {
      return;
    }

    const modelSelect = state.root.querySelector('[data-xxt-role="model"]');
    const model = modelSelect ? modelSelect.value : 'deepseek-reasoner';
    state.grader.model = GRADER_MODELS.includes(model) ? model : 'deepseek-reasoner';
    saveStoredModel(state.grader.model);
    setGraderStatus(
      state.grader.model === 'deepseek-reasoner'
        ? '已切换为 DeepSeek Pro / Reasoner。'
        : '已切换为 DeepSeek Flash / Chat。',
      ''
    );
  }

  function loadStoredApiKey() {
    return new Promise((resolve) => {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
        resolve('');
        return;
      }

      chrome.storage.local.get({ [API_KEY_STORAGE_KEY]: '' }, (result) => {
        resolve(String(result && result[API_KEY_STORAGE_KEY] ? result[API_KEY_STORAGE_KEY] : '').trim());
      });
    });
  }

  function saveStoredApiKey(apiKey) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || !apiKey) {
      return;
    }

    chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey });
  }

  function clearStoredApiKey() {
    state.grader.apiKey = '';
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(API_KEY_STORAGE_KEY);
    }
    updateGraderKeyHint();
  }

  function updateGraderKeyHint() {
    if (!state.root) {
      return;
    }

    const apiKeyInput = state.root.querySelector('[data-xxt-role="api-key"]');
    if (!apiKeyInput) {
      return;
    }

    apiKeyInput.value = '';
    apiKeyInput.placeholder = state.grader.apiKey
      ? '已保存密钥，可直接批改；输入新密钥可替换'
      : 'sk-...';
  }

  function toggleGraderPanel() {
    if (!state.root) {
      return;
    }

    const graderPanel = state.root.querySelector('[data-xxt-role="grader"]');
    const entryButton = state.root.querySelector('[data-xxt-action="toggle-grader"]');
    if (!graderPanel || !entryButton) {
      return;
    }

    const shouldOpen = graderPanel.hidden;
    graderPanel.hidden = !shouldOpen;
    state.grader.opened = shouldOpen;
    entryButton.textContent = shouldOpen ? '收起批改' : '作业批改';

    const systemPrompt = state.root.querySelector('[data-xxt-role="system-prompt"]');
    if (systemPrompt && !systemPrompt.value) {
      systemPrompt.value = DEEPSEEK_DEFAULT_SYSTEM_PROMPT;
    }

    if (shouldOpen) {
      state.quiz.manualPausedKey = getContentKey();
      stopQuizController('批改面板已打开，暂停试题自动跳转。', { silent: true });
      setActionStatus('作业批改面板已打开，试题自动跳转已暂停。');
      setGraderStatus(
        state.grader.apiKey
          ? 'API 密钥已持久化保存，可以直接开始批改。'
          : '请填写 DeepSeek API 密钥后开始批改。',
        ''
      );
    } else {
      setActionStatus('作业批改面板已收起；试题自动跳转仍暂停，点击“重新识别”可恢复。');
    }
  }

  async function startGrading() {
    if (state.grader.running) {
      return;
    }

    if (state.lastDetectedType !== 'quiz') {
      setGraderStatus('当前页面不是已识别的试题/作业页面。', 'error');
      return;
    }

    const apiKeyInput = state.root.querySelector('[data-xxt-role="api-key"]');
    const modelSelect = state.root.querySelector('[data-xxt-role="model"]');
    const systemPromptInput = state.root.querySelector('[data-xxt-role="system-prompt"]');

    const typedApiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
    const apiKey = typedApiKey || state.grader.apiKey;
    const model = modelSelect ? modelSelect.value : 'deepseek-reasoner';
    const systemPrompt = systemPromptInput && systemPromptInput.value.trim()
      ? systemPromptInput.value.trim()
      : DEEPSEEK_DEFAULT_SYSTEM_PROMPT;

    if (!apiKey) {
      setGraderStatus('请先填写 DeepSeek API 密钥。', 'error');
      showToast('请先填写 DeepSeek API 密钥。', 'warning');
      return;
    }

    const questions = extractQuizQuestions();
    if (!questions.length) {
      setGraderStatus('没有提取到可发送的题目。', 'error');
      showToast('没有提取到可发送的题目。', 'danger');
      return;
    }

    const requestKey = getContentKey();
    const batches = chunkArray(questions, GRADER_BATCH_SIZE);
    const runButton = state.root.querySelector('[data-xxt-action="run-grader"]');

    state.grader.running = true;
    state.grader.apiKey = apiKey;
    state.grader.model = model;
    saveStoredApiKey(apiKey);
    saveStoredModel(model);
    if (typedApiKey && apiKeyInput) {
      updateGraderKeyHint();
    }
    if (runButton) {
      runButton.disabled = true;
    }

    let completedCount = 0;

    try {
      for (let index = 0; index < batches.length; index += 1) {
        if (getContentKey() !== requestKey) {
          throw new Error('页面已切换，批改流程已停止。');
        }

        const batch = batches[index];
        setGraderStatus(
          `正在批改第 ${index + 1}/${batches.length} 批，共 ${completedCount}/${questions.length} 道已完成。`,
          ''
        );

        const response = await requestDeepSeekGrade({
          apiKey,
          model,
          systemPrompt,
          questions: batch.map(toApiQuestion)
        });

        if (getContentKey() !== requestKey) {
          throw new Error('页面已切换，批改结果未应用。');
        }

        const parsedAnswers = parseDeepSeekAnswers(response.content, batch);
        const appliedCount = applyGraderAnswers(parsedAnswers, batch);
        completedCount += appliedCount || batch.length;

        setGraderStatus(
          `已完成 ${Math.min(completedCount, questions.length)}/${questions.length} 道题。`,
          ''
        );
      }

      setGraderStatus(`批改完成，共处理 ${questions.length} 道题。`, 'success');
      showToast(`作业批改完成，共处理 ${questions.length} 道题。`, 'success');
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      setGraderStatus(`批改失败：${message}`, 'error');
      showToast('作业批改失败，请查看悬浮框状态。', 'danger');
      console.warn('[学习通助手] 作业批改失败：', message);
    } finally {
      state.grader.running = false;
      if (runButton) {
        runButton.disabled = false;
      }
    }
  }

  function extractQuizQuestions() {
    const documents = getQuizDocuments();
    const questions = [];
    const seenIds = new Set();

    for (const doc of documents) {
      const singleChoiceQuestions = Array.from(doc.querySelectorAll('.singleQuesId'));
      const roots = singleChoiceQuestions.length > 0
        ? singleChoiceQuestions
        : Array.from(doc.querySelectorAll('.TiMu.newTiMu'));

      for (const root of roots) {
        const optionElements = Array.from(root.querySelectorAll('li[qid]'));
        const firstOption = optionElements[0] || null;
        const qid = String(
          root.getAttribute('data')
          || (root.id ? root.id.replace(/^question/, '') : '')
          || (firstOption ? firstOption.getAttribute('qid') : '')
          || `question_${questions.length + 1}`
        );

        if (seenIds.has(qid)) {
          continue;
        }

        seenIds.add(qid);
        const stemElement = root.querySelector('.Zy_TItle .fontLabel')
          || root.querySelector('.Zy_TItle')
          || root;
        const stem = normalizeText(stemElement.textContent || '');
        const options = optionElements.map((element) => {
          const keyElement = element.querySelector('.num_option[data], .num_option');
          const key = normalizeOptionKey(
            keyElement && keyElement.getAttribute('data')
              ? keyElement.getAttribute('data')
              : (keyElement ? keyElement.textContent : '')
          );
          const textElement = element.querySelector('a.after');
          const text = normalizeText(textElement ? textElement.textContent : element.textContent);
          return { key, text, element };
        }).filter((option) => option.key);

        const answerInput = root.querySelector(`input[id="answer${qid}"], input[name="answer${qid}"]`);
        const typeElement = root.querySelector('.newZy_TItle');
        const typeText = normalizeText(typeElement ? typeElement.textContent : '');
        const qtype = firstOption ? String(firstOption.getAttribute('qtype') || '') : '';

        let type = 'single';
        if (/多选|多项/.test(typeText) || qtype === '1') {
          type = 'multiple';
        } else if (/判断/.test(typeText) || qtype === '2') {
          type = 'truefalse';
        } else if (/填空|简答|论述/.test(typeText) && options.length === 0) {
          type = 'text';
        }

        questions.push({
          id: qid,
          type,
          stem,
          options,
          element: root,
          document: doc,
          answerInput
        });
      }
    }

    return questions;
  }

  function getQuizDocuments() {
    const frame = document.querySelector('#iframe');
    const rootDocument = frame ? getFrameDocument(frame) : document;
    return rootDocument ? collectDocuments(rootDocument) : [document];
  }

  function toApiQuestion(question) {
    return {
      id: question.id,
      type: question.type,
      stem: question.stem,
      options: question.options.map((option) => ({
        key: option.key,
        text: option.text
      }))
    };
  }

  function chunkArray(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  function requestDeepSeekGrade(payload) {
    return new Promise((resolve, reject) => {
      if (!isExtensionRuntimeAvailable()) {
        reject(new Error('扩展后台不可用。'));
        return;
      }

      chrome.runtime.sendMessage({
        type: 'xxt-deepseek-grade',
        apiKey: payload.apiKey,
        model: payload.model,
        systemPrompt: payload.systemPrompt,
        questions: payload.questions
      }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || String(runtimeError)));
          return;
        }

        if (!response || !response.ok) {
          reject(new Error(response && response.error ? response.error : 'DeepSeek 请求失败。'));
          return;
        }

        resolve(response);
      });
    });
  }

  function parseDeepSeekAnswers(content, questions) {
    const text = String(content || '').trim();
    if (!text) {
      throw new Error('DeepSeek 返回了空内容。');
    }

    const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const jsonText = codeFenceMatch ? codeFenceMatch[1].trim() : text;
    const objectStart = jsonText.indexOf('{');
    const arrayStart = jsonText.indexOf('[');
    let start = -1;
    let end = -1;

    if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) {
      start = objectStart;
      end = jsonText.lastIndexOf('}');
    } else if (arrayStart >= 0) {
      start = arrayStart;
      end = jsonText.lastIndexOf(']');
    }

    if (start < 0 || end <= start) {
      throw new Error('DeepSeek 返回内容不是有效 JSON。');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText.slice(start, end + 1));
    } catch (error) {
      throw new Error('DeepSeek 返回 JSON 解析失败。');
    }

    const rawAnswers = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed.answers) ? parsed.answers : []);

    if (!rawAnswers.length) {
      throw new Error('DeepSeek 返回结果中没有 answers。');
    }

    return rawAnswers.map((item, index) => {
      const fallbackQuestion = questions[index];
      const id = String(item && item.id ? item.id : (fallbackQuestion ? fallbackQuestion.id : ''));
      const answer = item && Object.prototype.hasOwnProperty.call(item, 'answer')
        ? item.answer
        : '';
      const reason = truncateChineseReason(item && item.reason ? item.reason : 'AI 判断结果。', 50);
      return { id, answer, reason };
    }).filter((item) => item.id);
  }

  function applyGraderAnswers(answers, questions) {
    const questionMap = new Map(questions.map((question) => [String(question.id), question]));
    let appliedCount = 0;

    for (const item of answers) {
      const question = questionMap.get(String(item.id));
      if (!question) {
        continue;
      }

      const currentKeys = readCurrentAnswerKeys(question);
      const correctKeys = normalizeAnswerKeys(item.answer, question);

      if (question.options.length > 0) {
        applyChoiceAnswer(question, correctKeys, currentKeys);
      } else {
        applyTextAnswer(question, item.answer);
      }

      addQuestionReason(question, item.reason);
      appliedCount += 1;
    }

    return appliedCount;
  }

  function applyChoiceAnswer(question, correctKeys, previousKeys) {
    const optionMap = new Map(question.options.map((option) => [option.key, option]));
    const effectiveCorrectKeys = question.type === 'multiple'
      ? correctKeys
      : correctKeys.slice(0, 1);

    if (question.type === 'multiple') {
      for (const option of question.options) {
        const shouldSelect = effectiveCorrectKeys.includes(option.key);
        const wasSelected = previousKeys.includes(option.key);
        if (shouldSelect !== wasSelected) {
          option.element.click();
        }
      }
    } else {
      const targetKey = effectiveCorrectKeys[0];
      const targetOption = optionMap.get(targetKey);

      for (const option of question.options) {
        if (option.key !== targetKey && previousKeys.includes(option.key)) {
          option.element.click();
        }
      }

      if (targetOption && !previousKeys.includes(targetKey)) {
        targetOption.element.click();
      }

      forceSingleChoiceSelection(question, targetKey, optionMap);
    }

    const wrongPreviouslySelected = previousKeys.filter((key) => !effectiveCorrectKeys.includes(key));
    for (const option of question.options) {
      option.element.classList.remove('xxt-ai-correct', 'xxt-ai-wrong');
      if (effectiveCorrectKeys.includes(option.key)) {
        option.element.classList.add('xxt-ai-correct');
      }
      if (wrongPreviouslySelected.includes(option.key)) {
        option.element.classList.add('xxt-ai-wrong');
      }
    }
  }

  function forceSingleChoiceSelection(question, targetKey, optionMap) {
    if (!targetKey) {
      return;
    }

    const currentKeys = readCurrentAnswerKeys(question);
    const visuallySelectedKeys = question.options
      .filter((option) => {
        const numberElement = option.element.querySelector('.num_option, .num_option_dx');
        return numberElement
          && (numberElement.classList.contains('check_answer') || numberElement.classList.contains('check_answer_dx'));
      })
      .map((option) => option.key);

    if (currentKeys.length === 1
      && currentKeys[0] === targetKey
      && visuallySelectedKeys.length === 1
      && visuallySelectedKeys[0] === targetKey) {
      return;
    }

    for (const option of question.options) {
      const numberElement = option.element.querySelector('.num_option, .num_option_dx');
      if (numberElement) {
        numberElement.classList.remove('check_answer', 'check_answer_dx');
      }
      option.element.setAttribute('aria-checked', 'false');
      option.element.setAttribute('aria-pressed', 'false');
    }

    const targetOption = optionMap.get(targetKey);
    if (targetOption) {
      const targetNumber = targetOption.element.querySelector('.num_option, .num_option_dx');
      if (targetNumber) {
        targetNumber.classList.add('check_answer');
      }
      targetOption.element.setAttribute('aria-checked', 'true');
      targetOption.element.setAttribute('aria-pressed', 'true');
    }

    if (question.answerInput) {
      question.answerInput.value = targetKey;
      const EventConstructor = question.document.defaultView
        ? question.document.defaultView.Event
        : Event;
      question.answerInput.dispatchEvent(new EventConstructor('change', { bubbles: true }));
    }
  }

  function applyTextAnswer(question, rawAnswer) {
    const input = question.element.querySelector(
      'textarea:not([style*="display:none"]), input[type="text"]:not([readonly]), input:not([type])'
    );

    if (!input) {
      return;
    }

    const value = Array.isArray(rawAnswer)
      ? rawAnswer.join('')
      : String(rawAnswer || '');
    input.value = value;
    const EventConstructor = question.document.defaultView
      ? question.document.defaultView.Event
      : Event;
    input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    input.dispatchEvent(new EventConstructor('change', { bubbles: true }));
  }

  function readCurrentAnswerKeys(question) {
    const input = question.answerInput
      || question.element.querySelector(`input[id="answer${question.id}"], input[name="answer${question.id}"]`);
    return normalizeAnswerKeys(input ? input.value : '', question);
  }

  function normalizeAnswerKeys(value, question) {
    const rawValues = Array.isArray(value) ? value : [value];
    const keys = [];

    for (const rawValue of rawValues) {
      const text = String(rawValue || '').trim();
      if (!text) {
        continue;
      }

      if (question.options.length === 0) {
        keys.push(text);
        continue;
      }

      const parts = text.split(/[\s,，、;；|]+/).filter(Boolean);
      for (const part of parts) {
        const key = normalizeOptionKey(part);
        if (key && !keys.includes(key)) {
          keys.push(key);
        }
      }
    }

    return keys;
  }

  function normalizeOptionKey(value) {
    const match = String(value || '').trim().match(/[A-Za-z]/);
    return match ? match[0].toUpperCase() : '';
  }

  function addQuestionReason(question, reason) {
    if (!question.element || !question.document) {
      return;
    }

    let reasonElement = question.element.querySelector('.xxt-ai-reason');
    if (!reasonElement) {
      reasonElement = question.document.createElement('div');
      reasonElement.className = 'xxt-ai-reason';
      question.element.appendChild(reasonElement);
    }

    reasonElement.textContent = truncateChineseReason(reason, 50);
  }

  function truncateChineseReason(value, maxLength) {
    const text = normalizeText(value);
    const characters = Array.from(text);
    return characters.length <= maxLength
      ? text
      : characters.slice(0, maxLength).join('');
  }

  function setGraderStatus(message, tone) {
    if (!state.root) {
      return;
    }

    const statusElement = state.root.querySelector('[data-xxt-role="grader-status"]');
    if (!statusElement) {
      return;
    }

    statusElement.textContent = message;
    statusElement.dataset.tone = tone || '';
  }

  function scheduleBlankAction(key) {
    if (!state.settings.autoNextOnBlank) {
      setActionStatus('已识别为空白页；自动跳转当前已暂停。');
      hideCountdown();
      return;
    }

    if (state.pendingActionKey === key) {
      return;
    }

    if (state.lastClickedKey === key) {
      setActionStatus('本页已经自动点击过“下一节”，等待页面切换。');
      return;
    }

    cancelPendingAction('准备新的自动跳转', { silent: true });

    const delay = normalizeDelay(state.settings.delayMs);
    const totalSeconds = Math.max(1, Math.ceil(delay / 1000));
    let remainingSeconds = totalSeconds;

    state.pendingActionKey = key;
    updateCountdown(remainingSeconds);
    setActionStatus('已识别为空白页，倒计时结束后自动点击“下一节”。');
    showToast(`识别为空白页，${remainingSeconds} 秒后自动点击“下一节”。`, 'warning', true, true);

    state.countdownTimer = window.setInterval(() => {
      remainingSeconds -= 1;

      if (remainingSeconds > 0) {
        updateCountdown(remainingSeconds);
        showToast(`识别为空白页，${remainingSeconds} 秒后自动点击“下一节”。`, 'warning', true, true);
      }
    }, 1000);

    state.actionTimer = window.setTimeout(() => {
      clearActionTimers();
      performNextClick(key);
    }, delay);
  }

  function updateCountdown(seconds) {
    if (!state.root) {
      return;
    }

    const countdown = state.root.querySelector('[data-xxt-role="countdown"]');
    const number = state.root.querySelector('[data-xxt-role="countdown-number"]');

    if (countdown) {
      countdown.hidden = false;
    }

    if (number) {
      number.textContent = String(Math.max(0, seconds));
    }
  }

  function hideCountdown() {
    if (!state.root) {
      return;
    }

    const countdown = state.root.querySelector('[data-xxt-role="countdown"]');
    if (countdown) {
      countdown.hidden = true;
    }
  }

  function clearActionTimers() {
    window.clearTimeout(state.actionTimer);
    window.clearInterval(state.countdownTimer);
    state.actionTimer = null;
    state.countdownTimer = null;
  }

  function cancelPendingAction(reason, options = {}) {
    const hadPendingAction = Boolean(
      state.pendingActionKey || state.actionTimer || state.countdownTimer
    );

    clearActionTimers();
    state.pendingActionKey = '';
    hideCountdown();

    if (hadPendingAction && !options.silent && reason) {
      setActionStatus(reason);
    }
  }

  function performNextClick(key) {
    state.pendingActionKey = '';

    if (!state.settings.enabled || !state.settings.autoNextOnBlank) {
      setActionStatus('自动跳转已关闭，本次点击已取消。');
      return;
    }

    if (getContentKey() !== key) {
      setActionStatus('页面已经切换，本次点击已取消。');
      return;
    }

    const latestResult = detectCurrentPage();
    if (latestResult.type !== 'blank') {
      setActionStatus('重新识别后页面不再是空白页，已取消点击。');
      scheduleDetection('自动点击前重新识别', 0);
      return;
    }

    const nextButton = document.querySelector('#prevNextFocusNext');
    if (!nextButton) {
      setActionStatus('没有找到“下一节”按钮。');
      showToast('没有找到“下一节”按钮。', 'danger');
      return;
    }

    if (!isNextButtonClickable(nextButton)) {
      setActionStatus('“下一节”当前不可点击。');
      showToast('“下一节”当前不可点击。', 'danger');
      return;
    }

    state.lastClickedKey = key;
    setActionStatus('已自动点击“下一节”，正在等待页面切换。');
    hideCountdown();
    showToast('已自动点击“下一节”。', 'success');
    nextButton.click();
  }

  function isNextButtonClickable(button) {
    if (!button || !button.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(button);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
      return false;
    }

    if (button.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    const className = String(button.className || '');
    if (/(?:^|\s)(disabled|disable|is-disabled|prevNextFocusDisable)(?:\s|$)/i.test(className)) {
      return false;
    }

    return true;
  }

  function showToast(message, tone = 'info', persist = false, showCancel = false) {
    if (!state.root) {
      return;
    }

    const toast = state.root.querySelector('[data-xxt-role="toast"]');
    const text = state.root.querySelector('[data-xxt-role="toast-text"]');
    const cancelButton = state.root.querySelector('[data-xxt-action="cancel"]');

    if (!toast || !text) {
      return;
    }

    window.clearTimeout(state.toastTimer);
    toast.dataset.tone = tone;
    if (text.textContent !== message) {
      text.textContent = message;
    }

    if (cancelButton) {
      cancelButton.hidden = !showCancel;
    }

    toast.classList.add('xxt-toast--visible');

    if (!persist) {
      state.toastTimer = window.setTimeout(hideToast, 3500);
    }
  }

  function hideToast() {
    if (!state.root) {
      return;
    }

    const toast = state.root.querySelector('[data-xxt-role="toast"]');
    if (toast) {
      toast.classList.remove('xxt-toast--visible');
    }
  }
})();















