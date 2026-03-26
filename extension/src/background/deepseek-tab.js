import { DEEPSEEK_URL, TASK_TIMEOUT_MS_DEFAULT } from './constants.js';
import { tryExtractJson } from './json-utils.js';

export const DEFAULT_DEEPSEEK_SELECTORS = {
  inputSelector: 'textarea[placeholder*="DeepSeek" i], textarea[placeholder*="Message" i], textarea._27c9245',
  sendButtonSelector: 'div._7436101[role="button"][aria-disabled="false"]',
  messageBlockSelector: '.ds-markdown',
  sourceCiteSelector: '.ds-markdown-cite'
};

function mergeSelectors(selectors = {}) {
  return { ...DEFAULT_DEEPSEEK_SELECTORS, ...(selectors || {}) };
}

export async function createDeepSeekTab() {
  const tab = await chrome.tabs.create({ url: DEEPSEEK_URL, active: true });
  return tab;
}

export async function activateDeepSeekTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // ignore
  }
}

export async function waitForTabReady(tabId, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.readyState
      });
      if (result === 'complete') return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function ensureNewChat(tabId, selectors = {}) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const maybeNewChat = Array.from(document.querySelectorAll('button, a')).find((el) => {
          const text = (el.innerText || '').trim().toLowerCase();
          return text.includes('new chat') || text.includes('новый чат');
        });
        if (maybeNewChat && typeof maybeNewChat.click === 'function') {
          maybeNewChat.click();
        }
      }
    });
  } catch {
    // ignore
  }
}

export async function clearDeepSeekMessages(tabId, selectors = {}) {
  const merged = mergeSelectors(selectors);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (messageBlockSelector) => {
        const selector = messageBlockSelector || '.ds-markdown';
        const nodes = document.querySelectorAll(selector);
        nodes.forEach((el) => el.remove());
      },
      args: [merged.messageBlockSelector]
    });
  } catch {
    // ignore
  }
}

export async function sendPromptToDeepSeek(tabId, promptText, selectors = {}) {
  const merged = mergeSelectors(selectors);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text, selectorConfig) => {
      const inputSelector = selectorConfig?.inputSelector || '';
      const sendButtonSelector = selectorConfig?.sendButtonSelector || '';
      const preferred = inputSelector ? document.querySelector(inputSelector) : null;

      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        if (!rect) return false;
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (el.disabled) return false;
        return true;
      };

      const pickFirstVisible = (arr) => {
        for (const el of arr) {
          if (isVisible(el) && !el.disabled) return el;
        }
        return null;
      };

      const candidatesTextareas = Array.from(document.querySelectorAll('textarea'));
      const candidatesEditable = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      const candidatesTextbox = Array.from(document.querySelectorAll('[role="textbox"]'));

      let input = preferred && isVisible(preferred) ? preferred : null;
      input =
        input ||
        pickFirstVisible(candidatesTextareas) ||
        pickFirstVisible(candidatesEditable) ||
        pickFirstVisible(candidatesTextbox);

      if (!input) {
        throw new Error(
          '[DeepSeek][sendPromptToDeepSeek] input not found (maybe not logged in / page not ready).'
        );
      }

      const tag = (input.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') {
        input.value = text;
      } else {
        input.innerText = text;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));

      try {
        input.focus();
      } catch {
        // ignore
      }

      let sendButton = sendButtonSelector ? document.querySelector(sendButtonSelector) : null;
      if (!sendButton) {
        sendButton = document.querySelector('div._7436101[role="button"][aria-disabled="false"]') || null;
      }

      if (!sendButton) {
        const sendButtonCandidates = Array.from(
          document.querySelectorAll('button, div[role="button"], [role="button"]')
        );
        sendButton = sendButtonCandidates.find((el) => {
          const text = (el.innerText || '').trim().toLowerCase();
          const ariaDisabled = el.getAttribute('aria-disabled');
          const disabled =
            ariaDisabled === 'true' || ariaDisabled === 'disabled' || el.disabled === true;
          if (disabled) return false;
          if (el.getAttribute('disabled')) return false;
          if (text.includes('send') || text.includes('отправ') || text.includes('submit')) return true;
          if (el.getAttribute('role') === 'button') return ariaDisabled === 'false';
          return false;
        });
      }

      if (sendButton && typeof sendButton.click === 'function') {
        try {
          sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        } catch {
          // ignore
        }
        sendButton.click();
        return;
      }

      const evtInit = {
        key: 'Enter',
        code: 'Enter',
        which: 13,
        keyCode: 13,
        bubbles: true,
        cancelable: true
      };
      input.dispatchEvent(new KeyboardEvent('keydown', evtInit));
      input.dispatchEvent(new KeyboardEvent('keypress', evtInit));
      input.dispatchEvent(new KeyboardEvent('keyup', evtInit));
    },
    args: [promptText, merged]
  });
}

export async function waitForAiResponse(
  tabId,
  { timeoutMs = TASK_TIMEOUT_MS_DEFAULT, fromIndex = 0, selectors = {} } = {}
) {
  const merged = mergeSelectors(selectors);
  const start = Date.now();
  let lastText = '';

  while (Date.now() - start < timeoutMs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selectorConfig) => {
          const messageBlockSelector = selectorConfig?.messageBlockSelector || '.ds-markdown';
          const sourceCiteSelector = selectorConfig?.sourceCiteSelector || '.ds-markdown-cite';
          const blocks = Array.from(document.querySelectorAll(messageBlockSelector));
          const lastBlock = blocks[blocks.length - 1];
          const extractCleanText = (el) => {
            if (!el) return '';
            const clone = el.cloneNode(true);
            clone.querySelectorAll(sourceCiteSelector).forEach((n) => n.remove());
            clone.querySelectorAll('svg, button').forEach((n) => n.remove());
            const txt = (clone.innerText || clone.textContent || '').trim();
            return txt;
          };

          const extractSources = (el) => {
            if (!el) return [];
            const urls = new Set();

            el.querySelectorAll(`a[href] ${sourceCiteSelector}`).forEach((cite) => {
              const a = cite.closest('a[href]');
              const href = a ? a.getAttribute('href') : null;
              if (href && (href.startsWith('http://') || href.startsWith('https://'))) urls.add(href);
            });

            el.querySelectorAll('a[href]').forEach((a) => {
              const href = a.getAttribute('href');
              if (href && (href.startsWith('http://') || href.startsWith('https://'))) urls.add(href);
            });

            return Array.from(urls);
          };

          return {
            total: blocks.length,
            text: lastBlock ? extractCleanText(lastBlock) : '',
            sources: lastBlock ? extractSources(lastBlock) : []
          };
        },
        args: [merged]
      });

      const total = result && typeof result.total === 'number' ? result.total : 0;
      if (total > fromIndex) {
        const text = (result && result.text) || '';
        if (text && text !== lastText) {
          lastText = text;
          const json = tryExtractJson(text);
          if (json) {
            const sources = Array.isArray(result.sources) ? result.sources : [];
            return { json, sources };
          }
        }
      }
    } catch {
      // ignore
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  throw new Error('Таймаут ожидания ответа от DeepSeek.');
}

export async function getDeepSeekMessageCount(tabId, selectors = {}) {
  const merged = mergeSelectors(selectors);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (messageBlockSelector) => document.querySelectorAll(messageBlockSelector || '.ds-markdown').length,
    args: [merged.messageBlockSelector]
  });
  return typeof result === 'number' ? result : 0;
}

export async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // ignore
  }
}

