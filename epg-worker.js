// epg-worker.js — Web Worker for downloading, decompressing, and parsing XMLTV EPG
/* global self, importScripts, TextDecoder */

const CORS_PROXIES = [
  { label: 'codetabs',     build: u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
  { label: 'allorigins',   build: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) }
];

let pakoLoaded = false;
function ensurePako() {
  if (pakoLoaded && typeof self.pako !== 'undefined') return true;
  try {
    importScripts('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js');
    pakoLoaded = typeof self.pako !== 'undefined';
    return pakoLoaded;
  } catch (err) {
    console.warn('[EPG-Worker] Failed to load pako:', err);
    return false;
  }
}

async function fetchWithTimeout(url, timeoutMs = 45000, asBinary = false) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return asBinary ? await res.arrayBuffer() : await res.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Превышен таймаут загрузки');
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

/** Fetch EPG through CORS proxies to prevent browser CORS errors */
async function fetchCascade(url, asBinary = false) {
  let lastErr = null;

  // Always route through CORS proxies first (required for external EPG sources)
  for (const proxy of CORS_PROXIES) {
    try {
      const pUrl = proxy.build(url);
      const res = await fetchWithTimeout(pUrl, 45000, asBinary);
      if (res) return res;
    } catch (e) {
      lastErr = e;
    }
  }

  // For uncompressed text, also try AllOrigins /get endpoint
  if (!asBinary) {
    try {
      const jsonProxyUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent(url);
      const jsonText = await fetchWithTimeout(jsonProxyUrl, 45000, false);
      const parsed = JSON.parse(jsonText);
      if (parsed && parsed.contents) return parsed.contents;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Все CORS-прокси для загрузки EPG недоступны');
}

/** Parse XMLTV date string: "YYYYMMDDHHmmss +HHMM" -> ms timestamp */
function parseXMLTVDate(str) {
  if (!str) return null;
  const m = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, tz] = m;
  let offsetMs = 0;
  if (tz) {
    const sign = tz[0] === '-' ? -1 : 1;
    const oh = parseInt(tz.slice(1, 3), 10);
    const om = parseInt(tz.slice(3, 5), 10);
    offsetMs = sign * (oh * 60 + om) * 60000;
  }
  const utcMs = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  return utcMs - offsetMs;
}

/**
 * Fast streaming/regex parser for XMLTV content.
 * Filters programmes to [now - 6h, now + 48h] to avoid multi-hundred megabyte memory footprint.
 */
function parseXMLTVFast(xmlText, nowTs) {
  const channels = [];
  const programmes = Object.create(null);
  const now = nowTs || Date.now();
  const minTime = now - 6 * 3600 * 1000;
  const maxTime = now + 48 * 3600 * 1000;

  // 1. Extract <channel> tags
  const chRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let m;
  while ((m = chRe.exec(xmlText)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const idM = attrs.match(/id="([^"]+)"/i);
    if (!idM) continue;
    const id = idM[1].trim();

    const names = [];
    const nameRe = /<display-name[^>]*>([\s\S]*?)<\/display-name>/gi;
    let nm;
    while ((nm = nameRe.exec(body)) !== null) {
      const val = nm[1].replace(/<!\[CDATA\[(.*?)\]\]>/gi, '$1').trim();
      if (val) names.push(val);
    }

    const iconM = body.match(/<icon\s+src="([^"]+)"/i);
    const icon = iconM ? iconM[1].trim() : '';

    channels.push({ id, names, icon });
  }

  // 2. Extract <programme> tags (order of attributes can vary)
  const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  while ((m = progRe.exec(xmlText)) !== null) {
    const attrs = m[1];
    const body = m[2];

    const chM = attrs.match(/channel="([^"]+)"/i);
    const startM = attrs.match(/start="([^"]+)"/i);
    const stopM = attrs.match(/stop="([^"]+)"/i);
    if (!chM || !startM || !stopM) continue;

    const chId = chM[1].trim();
    const start = parseXMLTVDate(startM[1]);
    const stop = parseXMLTVDate(stopM[1]);
    if (!start || !stop) continue;

    // Filter to relevant time window
    if (stop < minTime || start > maxTime) continue;

    const titleM = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleM) continue;
    const title = titleM[1].replace(/<!\[CDATA\[(.*?)\]\]>/gi, '$1').trim();
    if (!title) continue;

    const descM = body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/i);
    const desc = descM ? descM[1].replace(/<!\[CDATA\[(.*?)\]\]>/gi, '$1').trim() : '';

    if (!programmes[chId]) programmes[chId] = [];
    programmes[chId].push({ start, stop, title, desc });
  }

  // Sort each channel's programmes by start time
  for (const chId in programmes) {
    programmes[chId].sort((a, b) => a.start - b.start);
  }

  return { channels, programmes };
}

self.addEventListener('message', async event => {
  const data = event.data || {};
  if (data.type !== 'LOAD_EPG') return;

  const { isLowPerf, now } = data;
  const sources = data.sources || [];

  let successSource = null;
  let parsedResult = null;

  for (let i = 0; i < sources.length; i++) {
    const srcUrl = sources[i];
    const isGz = srcUrl.toLowerCase().includes('.gz') && !isLowPerf;

    self.postMessage({
      type: 'PROGRESS',
      message: `Загрузка источника ${i + 1}/${sources.length} (${isLowPerf ? 'Слабое устройство' : (isGz ? '.gz' : '.xml')})...`,
      sourceUrl: srcUrl
    });

    try {
      let xmlText = '';
      if (isGz) {
        if (!ensurePako()) throw new Error('Библиотека pako недоступна для распаковки .gz');
        self.postMessage({ type: 'PROGRESS', message: 'Скачивание сжатого архива EPG...', sourceUrl: srcUrl });
        const buf = await fetchCascade(srcUrl, true);

        self.postMessage({ type: 'PROGRESS', message: 'Декомпрессия EPG архива в памяти...', sourceUrl: srcUrl });
        const inflated = self.pako.inflate(new Uint8Array(buf));
        xmlText = new TextDecoder('utf-8').decode(inflated);
      } else {
        self.postMessage({ type: 'PROGRESS', message: 'Скачивание XML программы...', sourceUrl: srcUrl });
        xmlText = await fetchCascade(srcUrl, false);
      }

      if (!xmlText || xmlText.length < 500) {
        throw new Error('Пустой или некорректный ответ XMLTV');
      }

      self.postMessage({ type: 'PROGRESS', message: 'Парсинг расписания передач...', sourceUrl: srcUrl });
      parsedResult = parseXMLTVFast(xmlText, now);

      if (parsedResult.channels.length === 0 && Object.keys(parsedResult.programmes).length === 0) {
        throw new Error('В файле не найдено расписание передач');
      }

      successSource = srcUrl;
      break; // Success! Stop fallback loop
    } catch (err) {
      console.warn(`[EPG-Worker] Source failed (${srcUrl}):`, err.message);
      self.postMessage({
        type: 'PROGRESS',
        message: `Ошибка источника ${i + 1}: ${err.message}. Пробуем следующий...`
      });
    }
  }

  if (successSource && parsedResult) {
    self.postMessage({
      type: 'SUCCESS',
      channels: parsedResult.channels,
      programmes: parsedResult.programmes,
      sourceUrl: successSource,
      isLowPerf: !!isLowPerf
    });
  } else {
    self.postMessage({
      type: 'ERROR',
      message: 'Все источники EPG недоступны. Проверьте сеть или используйте Режим слабого устройства.'
    });
  }
});
