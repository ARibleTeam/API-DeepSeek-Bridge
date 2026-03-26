const toggleBtn = document.getElementById('toggleBtn');
const selectorsToggleBtn = document.getElementById('selectorsToggleBtn');
const selectorsSection = document.getElementById('selectorsSection');
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
let selectorsVisible = false;

function renderSelectorsVisibility() {
  selectorsSection.classList.toggle('collapsed', !selectorsVisible);
  selectorsToggleBtn.textContent = selectorsVisible
    ? 'Скрыть настройки селекторов'
    : 'Показать настройки селекторов';
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

  if (enabled) {
    toggleBtn.textContent = 'Отключить';
    toggleBtn.classList.remove('connect');
    toggleBtn.classList.add('disconnect');
    return;
  }

  toggleBtn.textContent = 'Соединить';
  toggleBtn.classList.remove('disconnect');
  toggleBtn.classList.add('connect');
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
  const shouldEnable = toggleBtn.textContent.trim().toLowerCase() === 'соединить';
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

requestState();

selectorsToggleBtn.addEventListener('click', () => {
  selectorsVisible = !selectorsVisible;
  renderSelectorsVisibility();
});

renderSelectorsVisibility();
