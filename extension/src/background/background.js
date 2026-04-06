import { DEEPSEEK_URL } from './constants.js';
import { extractResultFromDeepSeekJson } from './json-utils.js';
import { buildDirectAnswerPrompt } from './prompts.js';
import {
  DEFAULT_DEEPSEEK_SELECTORS,
  activateDeepSeekTab,
  closeTab,
  createDeepSeekTab,
  ensureNewChat,
  getDeepSeekMessageCount,
  sendPromptToDeepSeek,
  waitForAiResponse,
  waitForTabReady,
  clearDeepSeekMessages
} from './deepseek-tab.js';

const DEFAULT_PYTHON_WS_HOST = '127.0.0.1';
const DEFAULT_PYTHON_WS_PORT = 8765;
const BRIDGE_ENABLED_KEY = 'bridgeEnabled';
const BRIDGE_WS_HOST_KEY = 'bridgeWsHost';
const BRIDGE_WS_PORT_KEY = 'bridgeWsPort';
const BRIDGE_SELECTORS_KEY = 'bridgeDeepseekSelectors';
const BRIDGE_REUSE_TAB_ID_KEY = 'bridgeReuseDeepseekTabId';

let pythonWs = null;
let pythonWsConnecting = false;
let activeTaskCount = 0;
const pendingTasks = [];
let lastRefusedLogAt = 0;
let reconnectTimerId = null;
let connectWatchdogTimerId = null;
let bridgeEnabled = false;
let pythonWsHost = DEFAULT_PYTHON_WS_HOST;
let pythonWsPort = DEFAULT_PYTHON_WS_PORT;
let deepseekSelectors = { ...DEFAULT_DEEPSEEK_SELECTORS };

let persistentDeepSeekTabId = null;

const RECONNECT_INTERVAL_MS = 1000;
const CONNECT_STUCK_TIMEOUT_MS = 5000;
const CONNECT_TICK_MS = 1000;
const MAX_PARALLEL_TASKS = 1;
const LOG_PREFIX = '[DeepSeek][bridge]';

function getWsStateLabel(ws) {
  if (!ws) return 'NONE';
  if (ws.readyState === WebSocket.CONNECTING) return 'CONNECTING';
  if (ws.readyState === WebSocket.OPEN) return 'OPEN';
  if (ws.readyState === WebSocket.CLOSING) return 'CLOSING';
  if (ws.readyState === WebSocket.CLOSED) return 'CLOSED';
  return 'UNKNOWN';
}

function getPythonWsUrl() {
  return `ws://${pythonWsHost}:${pythonWsPort}`;
}

function normalizeHost(host) {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (!trimmed) return null;
  return trimmed;
}

function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function normalizeSelectorValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function normalizeSelectorConfig(config = {}) {
  return {
    inputSelector: normalizeSelectorValue(config.inputSelector) || DEFAULT_DEEPSEEK_SELECTORS.inputSelector,
    sendButtonSelector:
      normalizeSelectorValue(config.sendButtonSelector) || DEFAULT_DEEPSEEK_SELECTORS.sendButtonSelector,
    messageBlockSelector:
      normalizeSelectorValue(config.messageBlockSelector) || DEFAULT_DEEPSEEK_SELECTORS.messageBlockSelector,
    sourceCiteSelector:
      normalizeSelectorValue(config.sourceCiteSelector) || DEFAULT_DEEPSEEK_SELECTORS.sourceCiteSelector
  };
}

function clearReconnectTimer() {
  if (reconnectTimerId) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

function clearConnectWatchdog() {
  if (connectWatchdogTimerId) {
    clearTimeout(connectWatchdogTimerId);
    connectWatchdogTimerId = null;
  }
}

function scheduleReconnect() {
  if (!bridgeEnabled) return;
  clearReconnectTimer();
  reconnectTimerId = setTimeout(() => {
    reconnectTimerId = null;
    connectPythonWs();
  }, RECONNECT_INTERVAL_MS);
}

function disconnectPythonWs() {
  clearReconnectTimer();
  clearConnectWatchdog();
  pythonWsConnecting = false;
  if (pythonWs) {
    try {
      pythonWs.close();
    } catch {
      // ignore
    }
  }
  pythonWs = null;
}

function rejectPendingTasksOnDisable() {
  while (pendingTasks.length > 0) {
    const taskMsg = pendingTasks.shift();
    const requestId = taskMsg?.requestId;
    if (!requestId) continue;
    postPython({
      type: 'deepseek_task_result',
      requestId,
      ok: false,
      error: 'bridge_disabled',
      message: 'Мост отключён в панели расширения'
    });
  }
}

function getBridgeState() {
  return {
    enabled: bridgeEnabled,
    busy: activeTaskCount > 0,
    activeTaskCount,
    pendingTaskCount: pendingTasks.length,
    wsHost: pythonWsHost,
    wsPort: pythonWsPort,
    canEditConnection: !bridgeEnabled,
    canEditSelectors: !bridgeEnabled,
    deepseekSelectors,
    defaultDeepseekSelectors: DEFAULT_DEEPSEEK_SELECTORS,
    wsState: getWsStateLabel(pythonWs),
    connecting: pythonWsConnecting,
    reuseDeepseekTabId: persistentDeepSeekTabId
  };
}

async function updateActionState() {
  const state = getBridgeState();
  let badgeText = 'OFF';
  let badgeColor = '#6b7280';
  let title = 'DeepSeek Bridge: отключен';

  if (state.enabled) {
    badgeText = 'ON';
    badgeColor = '#b45309';
    title = 'DeepSeek Bridge: подключается к Python...';
    if (state.wsState === 'OPEN') {
      badgeText = 'DS';
      badgeColor = '#15803d';
      const reuseHint = state.reuseDeepseekTabId != null ? ' reuse-вкладка' : '';
      title =
        state.activeTaskCount > 0
          ? `DeepSeek Bridge: выполняет ${state.activeTaskCount}, очередь ${state.pendingTaskCount}`
          : `DeepSeek Bridge: готов (может открывать DeepSeek)${reuseHint}`;
    }
  }

  try {
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor });
    await chrome.action.setTitle({ title });
  } catch {
    // ignore
  }
}

async function setBridgeEnabled(nextEnabled, connection = null) {
  if (!bridgeEnabled && Boolean(nextEnabled) && connection) {
    const nextHost = normalizeHost(connection.wsHost);
    const nextPort = normalizePort(connection.wsPort);
    if (!nextHost || !nextPort) {
      throw new Error('Некорректные параметры подключения моста');
    }
    pythonWsHost = nextHost;
    pythonWsPort = nextPort;
    await chrome.storage.local.set({
      [BRIDGE_WS_HOST_KEY]: pythonWsHost,
      [BRIDGE_WS_PORT_KEY]: pythonWsPort
    });
  }

  bridgeEnabled = Boolean(nextEnabled);
  await chrome.storage.local.set({ [BRIDGE_ENABLED_KEY]: bridgeEnabled });

  if (bridgeEnabled) {
    connectPythonWs();
  } else {
    rejectPendingTasksOnDisable();
    disconnectPythonWs();
    // eslint-disable-next-line no-void
    void closePersistentReuseTab();
  }

  await updateActionState();
  return getBridgeState();
}

async function initBridgeEnabledState() {
  try {
    const saved = await chrome.storage.local.get([
      BRIDGE_ENABLED_KEY,
      BRIDGE_WS_HOST_KEY,
      BRIDGE_WS_PORT_KEY,
      BRIDGE_SELECTORS_KEY
    ]);
    if (typeof saved?.[BRIDGE_ENABLED_KEY] === 'boolean') {
      bridgeEnabled = saved[BRIDGE_ENABLED_KEY];
    } else {
      bridgeEnabled = false;
      await chrome.storage.local.set({ [BRIDGE_ENABLED_KEY]: bridgeEnabled });
    }

    const host = normalizeHost(saved?.[BRIDGE_WS_HOST_KEY]);
    const port = normalizePort(saved?.[BRIDGE_WS_PORT_KEY]);
    pythonWsHost = host || DEFAULT_PYTHON_WS_HOST;
    pythonWsPort = port || DEFAULT_PYTHON_WS_PORT;
    await chrome.storage.local.set({
      [BRIDGE_WS_HOST_KEY]: pythonWsHost,
      [BRIDGE_WS_PORT_KEY]: pythonWsPort
    });
    deepseekSelectors = normalizeSelectorConfig(saved?.[BRIDGE_SELECTORS_KEY] || {});
    await chrome.storage.local.set({ [BRIDGE_SELECTORS_KEY]: deepseekSelectors });
  } catch {
    bridgeEnabled = false;
    pythonWsHost = DEFAULT_PYTHON_WS_HOST;
    pythonWsPort = DEFAULT_PYTHON_WS_PORT;
    deepseekSelectors = { ...DEFAULT_DEEPSEEK_SELECTORS };
  }

  if (bridgeEnabled) connectPythonWs();
  await restoreReuseTabFromStorage();
  await updateActionState();
}

async function restoreReuseTabFromStorage() {
  if (persistentDeepSeekTabId != null) return;
  try {
    const saved = await chrome.storage.local.get(BRIDGE_REUSE_TAB_ID_KEY);
    const id = saved?.[BRIDGE_REUSE_TAB_ID_KEY];
    if (typeof id !== 'number') return;
    await chrome.tabs.get(id);
    persistentDeepSeekTabId = id;
    console.debug(`${LOG_PREFIX} восстановлена reuse-вкладка из storage`, { tabId: id });
  } catch {
    persistentDeepSeekTabId = null;
    await chrome.storage.local.remove(BRIDGE_REUSE_TAB_ID_KEY);
  }
}

async function persistReuseTabId(tabId) {
  persistentDeepSeekTabId = tabId;
  await chrome.storage.local.set({ [BRIDGE_REUSE_TAB_ID_KEY]: tabId });
}

function extractTaskText(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (typeof payload.task === 'string' && payload.task.trim()) return payload.task.trim();
  if (typeof payload.prompt === 'string' && payload.prompt.trim()) return payload.prompt.trim();

  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    const last = payload.messages[payload.messages.length - 1];
    if (last && typeof last.content === 'string' && last.content.trim()) return last.content.trim();
  }

  return '';
}

function postPython(message) {
  try {
    if (pythonWs && pythonWs.readyState === WebSocket.OPEN) {
      pythonWs.send(JSON.stringify(message));
    }
  } catch {
    // ignore
  }
}

function processPendingTasks() {
  while (bridgeEnabled && activeTaskCount < MAX_PARALLEL_TASKS && pendingTasks.length > 0) {
    const nextTask = pendingTasks.shift();
    if (!nextTask) break;
    // eslint-disable-next-line no-void
    void executeDeepSeekTask(nextTask);
  }
}

function enqueueTask(taskMsg) {
  const requestId = taskMsg?.requestId;
  pendingTasks.push(taskMsg);
  console.debug(`${LOG_PREFIX} задача поставлена в очередь`, {
    requestId,
    pendingTaskCount: pendingTasks.length,
    activeTaskCount
  });
  processPendingTasks();
  // eslint-disable-next-line no-void
  void updateActionState();
}

async function getPersistentTabIfValid() {
  if (persistentDeepSeekTabId == null) {
    await restoreReuseTabFromStorage();
  }
  if (persistentDeepSeekTabId == null) return null;
  try {
    await chrome.tabs.get(persistentDeepSeekTabId);
    return persistentDeepSeekTabId;
  } catch {
    persistentDeepSeekTabId = null;
    await chrome.storage.local.remove(BRIDGE_REUSE_TAB_ID_KEY);
    return null;
  }
}

async function closePersistentReuseTab() {
  if (persistentDeepSeekTabId == null) return;
  const id = persistentDeepSeekTabId;
  persistentDeepSeekTabId = null;
  try {
    await chrome.storage.local.remove(BRIDGE_REUSE_TAB_ID_KEY);
  } catch {
    // ignore
  }
  await closeTab(id);
}

async function executeDeepSeekTask(taskMsg) {
  const requestId = taskMsg?.requestId;
  const payload = taskMsg?.payload;

  if (!requestId) return;
  console.debug(`${LOG_PREFIX} задача взята из очереди`, { requestId, pendingTaskCount: pendingTasks.length });
  if (!bridgeEnabled) {
    console.debug(`${LOG_PREFIX} задача отклонена: мост отключен`, { requestId });
    postPython({
      type: 'deepseek_task_result',
      requestId,
      ok: false,
      error: 'bridge_disabled',
      message: 'Мост отключён в панели расширения'
    });
    return;
  }

  const taskText = extractTaskText(payload);
  if (!taskText) {
    console.debug(`${LOG_PREFIX} задача отклонена: некорректный запрос`, { requestId });
    postPython({
      type: 'deepseek_task_result',
      requestId,
      ok: false,
      error: 'bad_request',
      message: 'Missing task/prompt/messages'
    });
    return;
  }

  const timeoutMs =
    payload && typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0 ? payload.timeoutMs : 60_000;

  const reuseDeepseekTab = Boolean(payload?.reuseDeepseekTab);

  activeTaskCount += 1;
  // eslint-disable-next-line no-void
  void updateActionState();
  console.debug(`${LOG_PREFIX} задача запущена`, {
    requestId,
    timeoutMs,
    taskLength: taskText.length,
    activeTaskCount,
    maxParallel: MAX_PARALLEL_TASKS,
    reuseDeepseekTab
  });
  let tabId = null;
  try {
    let baseCount = 0;

    if (reuseDeepseekTab) {
      const existingTab = await getPersistentTabIfValid();
      if (existingTab != null) {
        tabId = existingTab;
        console.debug(`${LOG_PREFIX} повторное использование вкладки`, { requestId, tabId });
        await activateDeepSeekTab(tabId);
        await waitForTabReady(tabId, 15_000);
        await activateDeepSeekTab(tabId);
        baseCount = await getDeepSeekMessageCount(tabId, deepseekSelectors);
        console.debug(`${LOG_PREFIX} базовая длина чата (тот же диалог)`, { requestId, baseCount });
      } else {
        tabId = (await createDeepSeekTab()).id;
        await persistReuseTabId(tabId);
        console.debug(`${LOG_PREFIX} вкладка создана (режим reuse)`, { requestId, tabId });
        await activateDeepSeekTab(tabId);
        await waitForTabReady(tabId, 15_000);
        await activateDeepSeekTab(tabId);
        await ensureNewChat(tabId, deepseekSelectors);
        console.debug(`${LOG_PREFIX} новый чат подготовлен`, { requestId, tabId });
        await clearDeepSeekMessages(tabId, deepseekSelectors);
        console.debug(`${LOG_PREFIX} видимые сообщения очищены`, { requestId, tabId });
        baseCount = await getDeepSeekMessageCount(tabId, deepseekSelectors);
        console.debug(`${LOG_PREFIX} зафиксирована базовая длина чата`, { requestId, baseCount });
      }
    } else {
      if (persistentDeepSeekTabId != null) {
        await closePersistentReuseTab();
      }
      tabId = (await createDeepSeekTab()).id;
      console.debug(`${LOG_PREFIX} вкладка создана`, { requestId, tabId });
      await activateDeepSeekTab(tabId);
      await waitForTabReady(tabId, 15_000);
      await activateDeepSeekTab(tabId);
      await ensureNewChat(tabId, deepseekSelectors);
      console.debug(`${LOG_PREFIX} новый чат подготовлен`, { requestId, tabId });
      await clearDeepSeekMessages(tabId, deepseekSelectors);
      console.debug(`${LOG_PREFIX} видимые сообщения очищены`, { requestId, tabId });
      baseCount = await getDeepSeekMessageCount(tabId, deepseekSelectors);
      console.debug(`${LOG_PREFIX} зафиксирована базовая длина чата`, { requestId, baseCount });
    }

    const prompt = buildDirectAnswerPrompt(taskText);
    console.debug(`${LOG_PREFIX} промпт подготовлен`, { requestId, promptLength: prompt.length });
    await sendPromptToDeepSeek(tabId, prompt, deepseekSelectors);
    console.debug(`${LOG_PREFIX} промпт отправлен`, { requestId, tabId });

    const ai = await waitForAiResponse(tabId, { timeoutMs, fromIndex: baseCount, selectors: deepseekSelectors });
    console.debug(`${LOG_PREFIX} ответ ИИ получен`, { requestId });
    const parsedJson = ai?.json;
    const sources = Array.isArray(ai?.sources) ? ai.sources : [];
    const result = extractResultFromDeepSeekJson(parsedJson);
    console.debug(`${LOG_PREFIX} ответ ИИ разобран`, {
      requestId,
      hasParsedJson: Boolean(parsedJson),
      sourcesCount: sources.length,
      hasResult: Boolean(result)
    });

    if (!result) {
      console.debug(`${LOG_PREFIX} задача завершилась с ошибкой: не удалось извлечь результат`, { requestId });
      postPython({
        type: 'deepseek_task_result',
        requestId,
        ok: false,
        error: 'no_result',
        message: 'DeepSeek returned JSON but could not extract result',
        parsedJson
      });
      return;
    }

    postPython({
      type: 'deepseek_task_result',
      requestId,
      ok: true,
      result,
      parsedJson,
      sources
    });
    console.debug(`${LOG_PREFIX} результат отправлен в Python`, { requestId, resultLength: result.length });
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'DeepSeek error';
    console.error(`${LOG_PREFIX} задача завершилась с ошибкой`, { requestId, message });
    postPython({
      type: 'deepseek_task_result',
      requestId,
      ok: false,
      error: 'deepseek_error',
      message
    });
  } finally {
    activeTaskCount = Math.max(0, activeTaskCount - 1);
    if (!reuseDeepseekTab && tabId != null) {
      console.debug(`${LOG_PREFIX} очистка: закрытие вкладки`, { requestId, tabId });
      await closeTab(tabId);
    } else if (reuseDeepseekTab) {
      console.debug(`${LOG_PREFIX} вкладка оставлена открытой (reuse)`, { requestId, tabId });
    }
    console.debug(`${LOG_PREFIX} задача завершена`, { requestId, activeTaskCount });
    processPendingTasks();
    // eslint-disable-next-line no-void
    void updateActionState();
  }
}

function connectPythonWs() {
  if (!bridgeEnabled) return;
  if (pythonWs && pythonWs.readyState === WebSocket.OPEN) return;
  if (pythonWs && pythonWs.readyState === WebSocket.CONNECTING) return;
  if (pythonWsConnecting) return;
  pythonWsConnecting = true;
  clearReconnectTimer();
  // eslint-disable-next-line no-void
  void updateActionState();
  const wsUrl = getPythonWsUrl();
  console.debug(`[DeepSeek][ws] попытка подключения -> ${wsUrl}`);

  try {
    const ws = new WebSocket(wsUrl);
    pythonWs = ws;
    clearConnectWatchdog();
    connectWatchdogTimerId = setTimeout(() => {
      if (pythonWs === ws && ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, CONNECT_STUCK_TIMEOUT_MS);

    ws.onopen = () => {
      clearConnectWatchdog();
      pythonWsConnecting = false;
      console.debug('[DeepSeek][ws] подключено');
      // eslint-disable-next-line no-void
      void updateActionState();
      postPython({ type: 'hello', client: 'extension', version: '0.1.0', url: DEEPSEEK_URL });
    };

    ws.onerror = () => {
      clearConnectWatchdog();
      pythonWsConnecting = false;
      // eslint-disable-next-line no-void
      void updateActionState();
      const now = Date.now();
      if (now - lastRefusedLogAt > 30_000) {
        lastRefusedLogAt = now;
        console.debug(`[DeepSeek][ws] не удается подключиться к ${wsUrl} (python еще не запущен?)`);
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      clearConnectWatchdog();
      pythonWsConnecting = false;
      console.debug('[DeepSeek][ws] соединение закрыто, переподключение через 1 сек');
      pythonWs = null;
      // eslint-disable-next-line no-void
      void updateActionState();
      scheduleReconnect();
    };

    ws.onmessage = (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch {
        // ignore
      }

      if (msg?.type === 'deepseek_close_reuse_tab') {
        const requestId = msg.requestId;
        if (typeof requestId !== 'string' || !requestId) return;
        console.debug(`${LOG_PREFIX} запрос закрытия reuse-вкладки из Python`, { requestId });
        void (async () => {
          try {
            await closePersistentReuseTab();
            postPython({
              type: 'deepseek_close_reuse_tab_result',
              requestId,
              ok: true
            });
          } catch (e) {
            const message = e && e.message ? String(e.message) : String(e);
            postPython({
              type: 'deepseek_close_reuse_tab_result',
              requestId,
              ok: false,
              error: 'close_failed',
              message
            });
          }
        })();
        return;
      }

      if (!msg || msg.type !== 'deepseek_task') return;
      console.debug(`${LOG_PREFIX} задача получена`, { requestId: msg.requestId });
      enqueueTask(msg);
    };
  } catch {
    clearConnectWatchdog();
    pythonWsConnecting = false;
    // eslint-disable-next-line no-void
    void updateActionState();
    scheduleReconnect();
  }
}

setInterval(() => {
  if (bridgeEnabled && (!pythonWs || pythonWs.readyState !== WebSocket.OPEN)) {
    console.debug(`[DeepSeek][ws] тик state=${getWsStateLabel(pythonWs)} connecting=${pythonWsConnecting}`);
    connectPythonWs();
  }
}, CONNECT_TICK_MS);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (persistentDeepSeekTabId == null || tabId !== persistentDeepSeekTabId) return;
  persistentDeepSeekTabId = null;
  console.debug(`${LOG_PREFIX} reuse-вкладка закрыта пользователем`, { tabId });
  // eslint-disable-next-line no-void
  void chrome.storage.local.remove(BRIDGE_REUSE_TAB_ID_KEY);
  // eslint-disable-next-line no-void
  void updateActionState();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge_get_state') {
    sendResponse(getBridgeState());
    return;
  }

  if (message?.type === 'bridge_close_reuse_tab') {
    void closePersistentReuseTab()
      .then(() => sendResponse({ ok: true, state: getBridgeState() }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: e?.message || 'Не удалось закрыть вкладку',
          state: getBridgeState()
        })
      );
    return true;
  }

  if (message?.type === 'bridge_set_enabled') {
    const nextEnabled = Boolean(message.enabled);
    const connection =
      message?.connection && typeof message.connection === 'object' ? message.connection : null;
    // eslint-disable-next-line no-void
    void setBridgeEnabled(nextEnabled, connection)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || 'Не удалось применить параметры подключения',
          state: getBridgeState()
        })
      );
    return true;
  }

  if (message?.type === 'bridge_set_selectors') {
    if (bridgeEnabled) {
      sendResponse({ ok: false, error: 'Отключи мост перед изменением селекторов', state: getBridgeState() });
      return;
    }
    try {
      deepseekSelectors = normalizeSelectorConfig(message?.selectors || {});
      // eslint-disable-next-line no-void
      void chrome.storage.local.set({ [BRIDGE_SELECTORS_KEY]: deepseekSelectors });
      sendResponse({ ok: true, selectors: deepseekSelectors, state: getBridgeState() });
    } catch {
      sendResponse({ ok: false, error: 'Некорректные селекторы', state: getBridgeState() });
    }
    return;
  }

  if (message?.type === 'bridge_reset_selectors') {
    if (bridgeEnabled) {
      sendResponse({ ok: false, error: 'Отключи мост перед сбросом селекторов', state: getBridgeState() });
      return;
    }
    deepseekSelectors = { ...DEFAULT_DEEPSEEK_SELECTORS };
    // eslint-disable-next-line no-void
    void chrome.storage.local.set({ [BRIDGE_SELECTORS_KEY]: deepseekSelectors });
    sendResponse({ ok: true, selectors: deepseekSelectors, state: getBridgeState() });
    return;
  }

  if (message?.type === 'bridge_test_selectors') {
    const inputSelectors = normalizeSelectorConfig(message?.selectors || {});
    // eslint-disable-next-line no-void
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: 'https://chat.deepseek.com/*' });
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: 'Открой вкладку https://chat.deepseek.com и повтори проверку' });
          return;
        }
        const tabId = tabs[0].id;
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (selectors) => {
            const HIGHLIGHT_ATTR = 'data-deepseek-bridge-highlight';
            document.querySelectorAll(`[${HIGHLIGHT_ATTR}="1"]`).forEach((el) => el.remove());

            const makeLabel = (targetEl, text) => {
              const rect = targetEl.getBoundingClientRect();
              const label = document.createElement('div');
              label.setAttribute(HIGHLIGHT_ATTR, '1');
              label.textContent = `Локальный мост DeepSeek: ${text}`;
              label.style.position = 'fixed';
              label.style.left = `${Math.max(4, rect.left)}px`;
              label.style.top = `${Math.max(4, rect.top - 22)}px`;
              label.style.zIndex = '2147483647';
              label.style.padding = '2px 6px';
              label.style.borderRadius = '4px';
              label.style.fontSize = '11px';
              label.style.fontWeight = '700';
              label.style.background = '#ff0000';
              label.style.color = '#fff';
              label.style.pointerEvents = 'none';
              document.documentElement.appendChild(label);
            };

            const highlightFirst = (selector, label) => {
              if (!selector) return { count: 0, highlighted: false };
              let nodes = [];
              try {
                nodes = Array.from(document.querySelectorAll(selector));
              } catch {
                return { count: -1, highlighted: false };
              }
              if (nodes.length === 0) return { count: 0, highlighted: false };
              const el = nodes[0];
              const rect = el.getBoundingClientRect();
              const box = document.createElement('div');
              box.setAttribute(HIGHLIGHT_ATTR, '1');
              box.style.position = 'fixed';
              box.style.left = `${rect.left}px`;
              box.style.top = `${rect.top}px`;
              box.style.width = `${rect.width}px`;
              box.style.height = `${rect.height}px`;
              box.style.zIndex = '2147483646';
              box.style.border = '3px solid #ff0000';
              box.style.borderRadius = '6px';
              box.style.boxShadow = '0 0 0 2px rgba(255,0,0,0.25)';
              box.style.pointerEvents = 'none';
              document.documentElement.appendChild(box);
              makeLabel(el, label);
              return { count: nodes.length, highlighted: true };
            };

            const countSafe = (selector) => {
              if (!selector) return 0;
              try {
                return document.querySelectorAll(selector).length;
              } catch {
                return -1;
              }
            };
            const inputRes = highlightFirst(selectors.inputSelector, 'поле ввода');
            const sendRes = highlightFirst(selectors.sendButtonSelector, 'кнопка отправки');
            const msgRes = highlightFirst(selectors.messageBlockSelector, 'блок ответа');
            const citeRes = highlightFirst(selectors.sourceCiteSelector, 'цитаты');
            return {
              inputSelectorCount: countSafe(selectors.inputSelector),
              sendButtonSelectorCount: countSafe(selectors.sendButtonSelector),
              messageBlockSelectorCount: countSafe(selectors.messageBlockSelector),
              sourceCiteSelectorCount: countSafe(selectors.sourceCiteSelector),
              highlighted: {
                input: inputRes.highlighted,
                send: sendRes.highlighted,
                message: msgRes.highlighted,
                cite: citeRes.highlighted
              }
            };
          },
          args: [inputSelectors]
        });
        sendResponse({ ok: true, report: result || null, testedTabId: tabId });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'Ошибка проверки селекторов' });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // eslint-disable-next-line no-void
  void initBridgeEnabledState();
});
chrome.runtime.onStartup?.addListener(() => {
  // eslint-disable-next-line no-void
  void initBridgeEnabledState();
});
// eslint-disable-next-line no-void
void initBridgeEnabledState();

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/dashboard.html');

chrome.action.onClicked.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((t) => t.url === DASHBOARD_URL);
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
    await chrome.tabs.create({ url: DASHBOARD_URL });
  } catch {
    // ignore
  }
});

