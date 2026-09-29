'use strict';

const PROBE_MESSAGE = 'xxt-probe-document-frames';
const SCROLL_MESSAGE = 'xxt-scroll-document-frames';
const DEEPSEEK_MESSAGE = 'xxt-deepseek-grade';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return undefined;
  }

  if (message.type === DEEPSEEK_MESSAGE) {
    handleDeepSeekGrade(message)
      .then((response) => sendResponse({ ok: true, ...response }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error && error.message ? error.message : error)
        });
      });
    return true;
  }

  if (message.type !== PROBE_MESSAGE && message.type !== SCROLL_MESSAGE) {
    return undefined;
  }

  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (typeof tabId !== 'number') {
    sendResponse({ ok: false, error: 'Missing tab id' });
    return undefined;
  }

  const mode = message.type === SCROLL_MESSAGE ? 'scroll' : 'probe';

  chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      return;
    }

    const frameIds = (frames || [])
      .filter((frame) => isViewerFrameUrl(frame.url))
      .map((frame) => frame.frameId);

    const target = frameIds.length > 0
      ? { tabId, frameIds }
      : { tabId, allFrames: true };

    chrome.scripting.executeScript({
      target,
      func: runDocumentFrameOperation,
      args: [mode]
    }).then((results) => {
      sendResponse({
        ok: true,
        requestId: message.requestId || '',
        results: results.map((item) => ({
          frameId: item.frameId,
          documentId: item.documentId,
          result: item.result
        }))
      });
    }).catch((error) => {
      sendResponse({
        ok: false,
        requestId: message.requestId || '',
        error: String(error && error.message ? error.message : error)
      });
    });
  });

  return true;
});

async function handleDeepSeekGrade(message) {
  const apiKey = String(message.apiKey || '').trim();
  const model = String(message.model || 'deepseek-reasoner').trim();
  const systemPrompt = String(message.systemPrompt || '').trim();
  const questions = Array.isArray(message.questions) ? message.questions : [];

  if (!apiKey) {
    throw new Error('缺少 DeepSeek API 密钥。');
  }

  if (!systemPrompt) {
    throw new Error('缺少系统提示词。');
  }

  if (!questions.length) {
    throw new Error('没有可发送的题目。');
  }

  const body = {
    model: model || 'deepseek-reasoner',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `请批改以下题目。只根据题干和选项作答，不要参考用户已有选择。严格返回 JSON。type 不是 multiple 的题，answer 必须且只能有一个选项字母。\n${JSON.stringify(questions)}`
      }
    ],
    stream: false,
    max_tokens: 16000
  };

  if (body.model === 'deepseek-chat') {
    body.temperature = 0;
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const rawText = await response.text();
  let data = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const messageText = data && data.error && data.error.message
      ? data.error.message
      : `DeepSeek HTTP ${response.status}`;
    throw new Error(messageText);
  }

  const content = data
    && data.choices
    && data.choices[0]
    && data.choices[0].message
    ? data.choices[0].message.content
    : '';

  if (!content) {
    throw new Error('DeepSeek 返回内容为空。');
  }

  return {
    content,
    usage: data.usage || null
  };
}

function isViewerFrameUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;

    const isPanViewer = host === 'pan-yz.chaoxing.com' && /\/screen\//i.test(path);
    const isSameOriginScreen = host === 'mooc1.jjxy.zufe.edu.cn'
      && /\/mooc-ans\/screen\/file/i.test(path);

    return isPanViewer || isSameOriginScreen;
  } catch (error) {
    return false;
  }
}

function runDocumentFrameOperation(mode) {
  const host = String(location.hostname || '').toLowerCase();
  const path = String(location.pathname || '');
  const isPanViewer = host === 'pan-yz.chaoxing.com' && /\/screen\//i.test(path);
  const isSameOriginScreen = host === 'mooc1.jjxy.zufe.edu.cn'
    && /\/mooc-ans\/screen\/file/i.test(path)
    && document.querySelectorAll('.pageNum, .anchor').length > 0;
  const isViewer = isPanViewer || isSameOriginScreen;

  if (!isViewer) {
    return {
      isViewer: false,
      href: location.href
    };
  }

  const html = document.documentElement;
  const body = document.body;
  const scrollHeight = Math.max(
    Number(html ? html.scrollHeight : 0) || 0,
    Number(body ? body.scrollHeight : 0) || 0
  );
  const clientHeight = Number(html && html.clientHeight)
    || Number(window.innerHeight)
    || 0;
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);

  if (mode === 'scroll') {
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
  }

  const scrollTop = Math.max(
    Number(window.scrollY) || 0,
    Number(html ? html.scrollTop : 0) || 0,
    Number(body ? body.scrollTop : 0) || 0
  );
  const pageCount = document.querySelectorAll('.pageNum, .anchor, [id^="anchor"]').length;
  const imageCount = document.images.length;
  const ready = document.readyState === 'complete'
    && (pageCount > 0 || imageCount > 0)
    && scrollHeight > clientHeight + 50;

  return {
    isViewer: true,
    href: location.href,
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
