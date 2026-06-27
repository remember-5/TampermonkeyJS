// ==UserScript==
// @name         ProcessOn POS Exporter
// @namespace    local.processon.pos.exporter
// @version      0.1.0
// @description  Export accessible ProcessOn mind-map data as a .pos schema file.
// @match        https://www.processon.com/view/*
// @connect      www.processon.com
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CHART_DEF_IDS_API_PATH = '/api/personal/canvas/get/template/chartdefids';
  const DEF_API_PATH = '/api/personal/diagraming/get/template/def';
  const DEFAULT_DEF_IDS = {
    '6367f3360e3e74618c36fb6e': '64abbb3d7621310f823d04d6',
  };

  function getChartId() {
    const match = location.pathname.match(/\/view\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function nowText() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return [
      d.getFullYear(),
      '-',
      pad(d.getMonth() + 1),
      '-',
      pad(d.getDate()),
      ' ',
      pad(d.getHours()),
      ':',
      pad(d.getMinutes()),
      ':',
      pad(d.getSeconds()),
    ].join('');
  }

  function safeFilename(name) {
    return String(name || 'processon-export')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'processon-export';
  }

  function collectDefIdCandidates(chartId) {
    const candidates = new Set();

    const saved = GM_getValue(`defId:${chartId}`, '');
    if (saved) candidates.add(saved);

    if (DEFAULT_DEF_IDS[chartId]) candidates.add(DEFAULT_DEF_IDS[chartId]);

    for (const entry of performance.getEntriesByType('resource')) {
      try {
        const url = new URL(entry.name);
        if (url.pathname === DEF_API_PATH && url.searchParams.get('chartId') === chartId) {
          const defId = url.searchParams.get('defId');
          if (defId) candidates.add(defId);
        }
      } catch (_) {
        // Ignore non-URL performance entries.
      }
    }

    const html = document.documentElement ? document.documentElement.innerHTML : '';
    const regex = /defId["'=:\s]+([a-f0-9]{24})/gi;
    let match;
    while ((match = regex.exec(html))) {
      candidates.add(match[1]);
    }

    return Array.from(candidates);
  }

  function getDefIdFromPrompt(chartId) {
    const candidates = collectDefIdCandidates(chartId);
    const defaultDefId = candidates[0] || '';
    const message = defaultDefId
      ? '确认或修改 defId：'
      : '请输入 defId。可以从接口 URL 的 defId 参数复制：';
    const defId = prompt(message, defaultDefId);
    if (!defId) return '';

    const normalized = defId.trim();
    GM_setValue(`defId:${chartId}`, normalized);
    return normalized;
  }

  async function getDefIdFromApi(chartId) {
    const url = new URL(CHART_DEF_IDS_API_PATH, location.origin);
    url.searchParams.set('chartId', chartId);
    url.searchParams.set('template', 'true');

    const raw = await requestJson(url.toString());
    if (raw.code && String(raw.code) !== '200') {
      throw new Error(raw.msg ? `画布接口返回失败：${raw.msg}` : `画布接口返回失败：code=${raw.code}`);
    }

    const data = raw.data || {};
    const fromMainCanvas = data.mainCanvasId;
    const fromChartCanvas = Array.isArray(data.chartCanvas)
      ? data.chartCanvas.find((item) => item && item.canvasId === chartId && item.definitionId)
      : null;
    const fromChartDefIds = Array.isArray(data.chartDefIds)
      ? data.chartDefIds.find((item) => item && item.canvasId === chartId && item.definitionId)
      : null;

    const defId = fromMainCanvas
      || (fromChartCanvas && fromChartCanvas.definitionId)
      || (fromChartDefIds && fromChartDefIds.definitionId)
      || '';

    if (!defId) {
      throw new Error('画布接口响应中没有找到 definitionId/mainCanvasId');
    }

    GM_setValue(`defId:${chartId}`, defId);
    return defId;
  }

  async function getDefId(chartId) {
    try {
      return await getDefIdFromApi(chartId);
    } catch (error) {
      console.warn('[ProcessOn POS Exporter] 自动获取 defId 失败，回退到手动输入', error);
      return getDefIdFromPrompt(chartId);
    }
  }

  async function requestJson(url) {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!response.ok) {
      throw new Error(`请求失败：HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`响应不是合法 JSON：${error.message}`);
    }
  }

  function normalizeNode(node) {
    if (!node || typeof node !== 'object') return node;

    if (!Array.isArray(node.children)) node.children = [];
    node.children.forEach(normalizeNode);

    if (node.callout == null) node.callout = [];
    if (node.summaries == null && node.parent === 'root') node.summaries = [];

    return node;
  }

  function normalizeElements(elements) {
    const normalized = { ...elements };

    normalized.id = normalized.id || 'root';
    normalized.title = normalized.title || 'ProcessOn Export';
    normalized.root = normalized.root !== false;
    normalized.structure = normalized.structure || 'mind_right';
    normalized.editorVersion = normalized.editorVersion || 'V2';
    normalized.showWatermark = normalized.showWatermark === true;
    normalized.watermark = normalized.watermark || '';
    normalized.note = normalized.note || '';
    normalized.freeChildren = Array.isArray(normalized.freeChildren) ? normalized.freeChildren : [];
    normalized.comments = Array.isArray(normalized.comments) ? normalized.comments : [];
    normalized.callout = Array.isArray(normalized.callout) ? normalized.callout : [];
    normalized.lines = normalized.lines && typeof normalized.lines === 'object' ? normalized.lines : {};
    normalized.tags = Array.isArray(normalized.tags) ? normalized.tags : [];
    normalized.children = Array.isArray(normalized.children) ? normalized.children : [];
    normalized.textAutoWrapWidth = normalized.textAutoWrapWidth || 900;
    normalized.version = Number.isFinite(Number(normalized.version)) ? Number(normalized.version) : 0;

    if (!normalized.theme) normalized.theme = 'default';
    if (!normalized.data || typeof normalized.data !== 'object') normalized.data = {};
    if (normalized.data['right-content-index'] == null) {
      normalized.data['right-content-index'] = normalized.children.length;
    }

    normalized.children.forEach(normalizeNode);
    return normalized;
  }

  function buildPos(raw, chartId, defId) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('接口响应为空或格式错误');
    }

    if (raw.code && String(raw.code) !== '200') {
      throw new Error(raw.msg ? `接口返回失败：${raw.msg}` : `接口返回失败：code=${raw.code}`);
    }

    const defText = raw.data && raw.data.def;
    if (!defText || typeof defText !== 'string') {
      throw new Error('接口响应中没有 data.def');
    }

    let elements;
    try {
      elements = JSON.parse(defText);
    } catch (error) {
      throw new Error(`data.def 不是合法 JSON：${error.message}`);
    }

    const normalized = normalizeElements(elements);
    const title = normalized.title || `ProcessOn-${chartId}`;
    const timestamp = nowText();

    return {
      diagram: {
        elements: normalized,
      },
      meta: {
        exportTime: timestamp,
        member: '',
        diagramInfo: {
          creator: '',
          created: timestamp,
          modified: timestamp,
          title,
          category: normalized.structure && normalized.structure.startsWith('mind') ? 'mind_free' : 'mind_free',
        },
        id: chartId,
        cloneId: defId,
        type: 'ProcessOn Schema File',
        version: '5.0',
      },
    };
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportPos() {
    const chartId = getChartId();
    if (!chartId) {
      alert('没有从当前 URL 中识别到 chartId。');
      return;
    }

    setButtonBusy(true);

    try {
      const defId = await getDefId(chartId);
      if (!defId) return;

      const url = new URL(DEF_API_PATH, location.origin);
      url.searchParams.set('defId', defId);
      url.searchParams.set('chartId', chartId);
      url.searchParams.set('template', 'true');

      const raw = await requestJson(url.toString());
      const pos = buildPos(raw, chartId, defId);
      const title = pos.meta.diagramInfo.title;
      downloadJson(`${safeFilename(title)}.pos`, pos);
    } catch (error) {
      console.error('[ProcessOn POS Exporter]', error);
      alert(error.message || String(error));
    } finally {
      setButtonBusy(false);
    }
  }

  function setButtonBusy(busy) {
    const button = document.querySelector('#processon-pos-exporter-button');
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? '导出中...' : '导出 POS';
  }

  function installButton() {
    if (document.querySelector('#processon-pos-exporter-button')) return;

    const button = document.createElement('button');
    button.id = 'processon-pos-exporter-button';
    button.type = 'button';
    button.textContent = '导出 POS';
    button.addEventListener('click', exportPos);

    Object.assign(button.style, {
      position: 'fixed',
      right: '20px',
      bottom: '24px',
      zIndex: '2147483647',
      padding: '9px 14px',
      border: '1px solid rgba(0, 0, 0, 0.16)',
      borderRadius: '6px',
      background: '#1677ff',
      color: '#fff',
      fontSize: '14px',
      lineHeight: '20px',
      fontFamily: 'Arial, sans-serif',
      boxShadow: '0 6px 18px rgba(0, 0, 0, 0.16)',
      cursor: 'pointer',
    });

    document.body.appendChild(button);
  }

  GM_registerMenuCommand('导出当前 ProcessOn 为 .pos', exportPos);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installButton, { once: true });
  } else {
    installButton();
  }
})();
