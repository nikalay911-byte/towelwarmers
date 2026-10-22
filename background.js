/*
 * «Остатки Ника 41» — service worker (Manifest V3).
 * Задачи: открыть/вернуть вкладку прайса, держать бейдж с числом найденных позиций.
 * Разрешения сведены к «storage»: вкладку запоминаем по id, а не по URL (иначе нужно «tabs»).
 */
'use strict';

var APP_URL = chrome.runtime.getURL('app/index.html');
var TAB_KEY = 'priceTabId';

function getStore(keys) {
  return new Promise(function (resolve) { chrome.storage.local.get(keys, resolve); });
}
function setStore(obj) {
  return new Promise(function (resolve) { chrome.storage.local.set(obj, resolve); });
}

function activate(tabId) {
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab) { resolve(false); return; }
      chrome.tabs.update(tabId, { active: true }, function () {
        if (tab.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true });
        resolve(true);
      });
    });
  });
}

function openPrice(focusSearch) {
  return getStore([TAB_KEY]).then(function (st) {
    var id = st && st[TAB_KEY];
    return (id ? activate(id) : Promise.resolve(false)).then(function (ok) {
      if (ok) {
        if (focusSearch) chrome.tabs.sendMessage(id, { type: 'focus-search' }).catch(function () { });
        return;
      }
      var url = APP_URL + (focusSearch ? '?focus=1' : '');
      return chrome.tabs.create({ url: url, active: true }).then(function (tab) {
        var o = {}; o[TAB_KEY] = tab.id;
        return setStore(o);
      });
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') chrome.tabs.create({ url: APP_URL, active: true });
  getStore(['badge']).then(function (r) { setBadge(r && r.badge); });
});

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'open-price' || command === 'open-price-focus-search') {
    openPrice(command === 'open-price-focus-search');
  }
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'badge') {
    setBadge(msg.text || '');
    setStore({ badge: msg.text || '' });
    if (sender.tab && sender.tab.id !== undefined) {
      var o = {}; o[TAB_KEY] = sender.tab.id; setStore(o);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'open-price') {
    openPrice(!!msg.focusSearch);
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  getStore([TAB_KEY]).then(function (st) {
    if (st && st[TAB_KEY] === tabId) chrome.storage.local.remove(TAB_KEY);
  });
});

function setBadge(text) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#0e7c66' });
    chrome.action.setBadgeText({ text: text ? String(text).slice(0, 5) : '' });
  } catch (e) { /* не расширение — молчим */ }
}
