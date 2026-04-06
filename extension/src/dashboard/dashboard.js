const THEME_STORAGE_KEY = 'dashboardUiTheme';

const toggleBtn = document.getElementById('toggleBtn');
const hostInput = document.getElementById('hostInput');
const portInput = document.getElementById('portInput');
const errorText = document.getElementById('errorText');
const selectorTestText = document.getElementById('selectorTestText');
const inputSelectorInput = document.getElementById('inputSelectorInput');
const sendButtonSelectorInput = document.getElementById('sendButtonSelectorInput');
const messageBlockSelectorInput = document.getElementById('messageBlockSelectorInput');
const sourceCiteSelectorInput = document.getElementById('sourceCiteSelectorInput');
const testSelectorsBtn = document.getElementById('testSelectorsBtn');
const saveSelectorsBtn = document.getElementById('saveSelectorsBtn');
const resetSelectorsBtn = document.getElementById('resetSelectorsBtn');
const bridgeStatus = document.getElementById('bridgeStatus');
const statusLabel = document.getElementById('statusLabel');

function resolveTheme(preference) {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference === 'dark' ? 'dark' : 'light';
}

function updateThemeButtons(preference) {
  document.querySelectorAll('.theme-switch__btn').forEach((btn) => {
    const v = btn.getAttribute('data-theme-value');
    btn.classList.toggle('is-active', v === preference);
  });
}

function applyThemePreference(preference, { persist } = { persist: false }) {
  document.documentElement.setAttribute('data-theme-preference', preference);
  document.documentElement.setAttribute('data-theme', resolveTheme(preference));
  updateThemeButtons(preference);
  if (persist) {
    chrome.storage.local.set({ [THEME_STORAGE_KEY]: preference });
  }
}

async function initTheme() {
  const stored = await chrome.storage.local.get(THEME_STORAGE_KEY);
  const raw = stored?.[THEME_STORAGE_KEY];
  const preference =
    raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
  applyThemePreference(preference, { persist: false });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const pref = document.documentElement.getAttribute('data-theme-preference') || 'system';
    if (pref === 'system') {
      document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    }
  });

  document.querySelectorAll('.theme-switch__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-theme-value');
      if (v === 'light' || v === 'dark' || v === 'system') {
        applyThemePreference(v, { persist: true });
      }
    });
  });
}

function setBridgeStatus(state) {
  if (!bridgeStatus || !statusLabel) return;

  bridgeStatus.classList.remove('status-pill--off', 'status-pill--ok', 'status-pill--wait', 'status-pill--busy');

  const enabled = Boolean(state?.enabled);
  const wsState = typeof state?.wsState === 'string' ? state.wsState : '';
  const connecting = Boolean(state?.connecting);

  if (!enabled) {
    bridgeStatus.classList.add('status-pill--off');
    statusLabel.textContent = 'Мост выключен';
    return;
  }

  if (connecting || wsState === 'CONNECTING') {
    bridgeStatus.classList.add('status-pill--busy');
    statusLabel.textContent = 'Подключение к Python…';
    return;
  }

  if (wsState === 'OPEN') {
    bridgeStatus.classList.add('status-pill--ok');
    statusLabel.textContent = 'Связь с Python установлена';
    return;
  }

  bridgeStatus.classList.add('status-pill--wait');
  statusLabel.textContent = 'Ожидание сервера Python…';
}

function render(state) {
  const enabled = Boolean(state?.enabled);
  const canEdit = Boolean(state?.canEditConnection);
  const canEditSelectors = Boolean(state?.canEditSelectors);
  hostInput.value = state?.wsHost || hostInput.value || '127.0.0.1';
  portInput.value = String(state?.wsPort || portInput.value || '8765');
  hostInput.disabled = !canEdit;
  portInput.disabled = !canEdit;
  const selectors = state?.deepseekSelectors || {};
  inputSelectorInput.value = selectors.inputSelector || '';
  sendButtonSelectorInput.value = selectors.sendButtonSelector || '';
  messageBlockSelectorInput.value = selectors.messageBlockSelector || '';
  sourceCiteSelectorInput.value = selectors.sourceCiteSelector || '';
  inputSelectorInput.disabled = !canEditSelectors;
  sendButtonSelectorInput.disabled = !canEditSelectors;
  messageBlockSelectorInput.disabled = !canEditSelectors;
  sourceCiteSelectorInput.disabled = !canEditSelectors;
  saveSelectorsBtn.disabled = !canEditSelectors;
  resetSelectorsBtn.disabled = !canEditSelectors;
  testSelectorsBtn.disabled = !canEditSelectors;

  const labelEl = toggleBtn.querySelector('.cta__label');
  if (enabled) {
    if (labelEl) labelEl.textContent = 'Отключить';
    toggleBtn.classList.remove('connect');
    toggleBtn.classList.add('disconnect');
  } else {
    if (labelEl) labelEl.textContent = 'Соединить';
    toggleBtn.classList.remove('disconnect');
    toggleBtn.classList.add('connect');
  }

  setBridgeStatus(state);
}

function requestState() {
  chrome.runtime.sendMessage({ type: 'bridge_get_state' }, (response) => {
    render(response);
  });
}

function getSelectorsFromInputs() {
  return {
    inputSelector: inputSelectorInput.value.trim(),
    sendButtonSelector: sendButtonSelectorInput.value.trim(),
    messageBlockSelector: messageBlockSelectorInput.value.trim(),
    sourceCiteSelector: sourceCiteSelectorInput.value.trim()
  };
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

toggleBtn.addEventListener('click', () => {
  errorText.textContent = '';
  selectorTestText.textContent = '';
  const labelEl = toggleBtn.querySelector('.cta__label');
  const label = labelEl ? labelEl.textContent.trim().toLowerCase() : '';
  const shouldEnable = label === 'соединить';
  const host = normalizeHost(hostInput.value);
  const port = normalizePort(portInput.value);
  if (shouldEnable && (!host || !port)) {
    errorText.textContent = 'Проверь адрес и порт';
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'bridge_set_enabled',
      enabled: shouldEnable,
      connection: { wsHost: hostInput.value, wsPort: portInput.value }
    },
    (response) => {
      if (!response?.ok) {
        errorText.textContent = response?.error || 'Не удалось применить настройки';
      }
      render(response?.state || response);
    }
  );
});

testSelectorsBtn.addEventListener('click', () => {
  errorText.textContent = '';
  selectorTestText.textContent = 'Проверка...';
  chrome.runtime.sendMessage(
    { type: 'bridge_test_selectors', selectors: getSelectorsFromInputs() },
    (response) => {
      if (!response?.ok) {
        selectorTestText.textContent = response?.error || 'Проверка не удалась';
        return;
      }
      const r = response.report || {};
      selectorTestText.textContent =
        `Поле ввода: ${r.inputSelectorCount}, ` +
        `Кнопка отправки: ${r.sendButtonSelectorCount}, ` +
        `Блок ответа: ${r.messageBlockSelectorCount}, ` +
        `Цитаты: ${r.sourceCiteSelectorCount}`;
    }
  );
});

saveSelectorsBtn.addEventListener('click', () => {
  errorText.textContent = '';
  selectorTestText.textContent = '';
  chrome.runtime.sendMessage(
    { type: 'bridge_set_selectors', selectors: getSelectorsFromInputs() },
    (response) => {
      if (!response?.ok) {
        errorText.textContent = response?.error || 'Не удалось сохранить селекторы';
      }
      if (response?.state) render(response.state);
    }
  );
});

resetSelectorsBtn.addEventListener('click', () => {
  errorText.textContent = '';
  selectorTestText.textContent = '';
  chrome.runtime.sendMessage({ type: 'bridge_reset_selectors' }, (response) => {
    if (!response?.ok) {
      errorText.textContent = response?.error || 'Не удалось сбросить селекторы';
    }
    if (response?.state) render(response.state);
  });
});

void initTheme().then(() => {
  requestState();
});
window.addEventListener('focus', requestState);
