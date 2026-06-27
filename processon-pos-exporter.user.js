// ==UserScript==
// @name         ProcessOn POS Exporter
// @namespace    local.processon.pos.exporter
// @version      0.1.0
// @description  Export accessible ProcessOn mind-map data as a .pos schema file.
// @match        https://www.processon.com/view/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CHART_DEF_IDS_API_PATH = '/api/personal/canvas/get/template/chartdefids';
  const DEF_API_PATH = '/api/personal/diagraming/get/template/def';

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

  async function getDefinitionId(chartId) {
    const url = new URL(CHART_DEF_IDS_API_PATH, location.origin);
    url.searchParams.set('chartId', chartId);
    url.searchParams.set('template', 'true');

    const raw = await requestJson(url.toString());
    if (raw.code && String(raw.code) !== '200') {
      throw new Error(raw.msg ? `画布接口返回失败：${raw.msg}` : `画布接口返回失败：code=${raw.code}`);
    }

    const data = raw.data || {};
    const canvases = [
      ...(Array.isArray(data.chartCanvas) ? data.chartCanvas : []),
      ...(Array.isArray(data.chartDefIds) ? data.chartDefIds : []),
    ];
    const mainCanvasId = data.mainCanvasId || chartId;
    const canvas = canvases.find((item) => item && item.canvasId === mainCanvasId && item.definitionId)
      || canvases.find((item) => item && item.definitionId);
    const defId = canvas ? canvas.definitionId : '';

    if (!defId) {
      throw new Error('画布接口响应中没有找到可用的 definitionId');
    }

    return defId;
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

  function normalizeMind(elements) {
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

  function normalizeFlow(elements) {
    return {
      ...elements,
      version: Number.isFinite(Number(elements.version)) ? Number(elements.version) : 0,
      page: elements.page && typeof elements.page === 'object' ? elements.page : {},
      elements: elements.elements && typeof elements.elements === 'object' ? elements.elements : {},
      comments: Array.isArray(elements.comments) ? elements.comments : [],
      plugins: elements.plugins && typeof elements.plugins === 'object' ? elements.plugins : {},
      aiContainers: Array.isArray(elements.aiContainers) ? elements.aiContainers : [],
      insertPageOpts: elements.insertPageOpts && typeof elements.insertPageOpts === 'object' ? elements.insertPageOpts : {},
      postPayment: elements.postPayment && typeof elements.postPayment === 'object' ? elements.postPayment : {},
    };
  }

  function normalizeElements(elements) {
    if (!elements || typeof elements !== 'object') {
      throw new Error('data.def 解析后不是对象');
    }

    if (Array.isArray(elements.children) || elements.structure) {
      return {
        elements: normalizeMind(elements),
        category: 'mind_free',
        title: elements.title || 'ProcessOn Export',
      };
    }

    if (elements.page && elements.elements) {
      return {
        elements: normalizeFlow(elements),
        category: 'flow',
        title: 'ProcessOn Export',
      };
    }

    throw new Error('暂不支持的 ProcessOn schema：未识别到 mind 或 flow 结构');
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
        elements: normalized.elements,
      },
      meta: {
        exportTime: timestamp,
        member: '',
        diagramInfo: {
          creator: '',
          created: timestamp,
          modified: timestamp,
          title,
          category: normalized.category,
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
      const defId = await getDefinitionId(chartId);

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
