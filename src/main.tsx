import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { defaults } from '../shared/config.mjs';
import { calibrationSource } from '../tests/fixtures/calibration.js';
import { RuntimeClient } from './runtime';
import { download, readProject, saveProject } from './project';
import type { Settings, Stats, Version, Vision } from './types';
import './styles.css';

type Phase =
  | 'idle'
  | 'connecting'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'exporting'
  | 'capturing'
  | 'loading';
const phaseText: Record<Phase, string> = {
  idle: '準備完了',
  connecting: '接続を確認中',
  generating: 'Qwen がモデルを制作中',
  validating: '形状とGLBを検証中',
  repairing: 'コードを自動修復中（1回）',
  exporting: 'GLBを書き出し中',
  capturing: '3方向の画像を撮影中',
  loading: 'プレビューを準備中',
};
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    cube: (
      <>
        <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
        <path d="m4 7.5 8 4.5 8-4.5M12 12v9M8 5.3l8 4.5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    down: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
      </>
    ),
    settings: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <path d="M8 3v6M16 9v6M9 15v6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    undo: (
      <>
        <path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" />
      </>
    ),
    folder: <path d="M3 7V4h6l3 3h9v13H3Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.cube}
    </svg>
  );
}
function App() {
  const [settings, setSettings] = useState<Settings>({ ...defaults });
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const token = useRef('');
  const [models, setModels] = useState<string[]>([]);
  const [vision, setVision] = useState<Vision | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionNote, setConnectionNote] = useState('');
  const [prompt, setPrompt] = useState('');
  const [reference, setReference] = useState<string | null>(null);
  const [visual, setVisual] = useState(false);
  const [autoRepair, setAutoRepair] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(0);
  const [history, setHistory] = useState<Version[]>([]);
  const [index, setIndex] = useState(-1);
  const [wire, setWire] = useState(false);
  const [grid, setGrid] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [seed, setSeed] = useState(42);
  const [view, setView] = useState('iso');
  const viewer = useRef<HTMLDivElement>(null);
  const active = useRef<RuntimeClient | null>(null);
  const candidate = useRef<RuntimeClient | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    imageInput = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const busyRef = useRef(false);
  const glbCache = useRef<{ id: string; buffer: ArrayBuffer } | null>(null);
  const current = history[index];
  const busy = phase !== 'idle';

  useEffect(() => {
    fetch('/api/session')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        token.current = data.token;
        setSettings(data.settings);
        setHasKey(data.hasApiKey);
        setVision(data.vision);
        setSessionReady(true);
      })
      .catch((e) => setError(e.message));
    return () => {
      operation.current++;
      controller.current?.abort();
      active.current?.destroy();
      candidate.current?.destroy();
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startTime.current) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [busy]);

  async function api(path: string, body: unknown, signal?: AbortSignal, method = 'POST') {
    const res = await fetch('/api/' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': token.current },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json();
    if (!res.ok)
      throw Object.assign(new Error(data.error || 'API通信に失敗しました。'), {
        code: data.code,
        details: data.details,
      });
    return data;
  }
  function begin(next: Phase) {
    if (busyRef.current) throw new Error('別の処理を実行中です。');
    busyRef.current = true;
    const id = ++operation.current;
    controller.current = new AbortController();
    startTime.current = Date.now();
    setElapsed(0);
    setPhase(next);
    setError('');
    setNotice('');
    return id;
  }
  function valid(id: number) {
    if (id !== operation.current || controller.current?.signal.aborted)
      throw new DOMException('停止しました', 'AbortError');
  }
  function finish(id: number) {
    if (id === operation.current) {
      busyRef.current = false;
      setPhase('idle');
      controller.current = null;
    }
  }
  function report(e: any, id: number) {
    if (id === operation.current && e.name !== 'AbortError')
      setError(e.message || '処理に失敗しました。');
  }
  async function applySettings(signal?: AbortSignal) {
    const data = await api(
      'settings',
      { ...settings, ...(key ? { apiKey: key } : {}) },
      signal,
      'PUT',
    );
    setSettings(data.settings);
    setHasKey(data.hasApiKey);
    setKey('');
    setVision(data.vision);
    return data.settings as Settings;
  }
  function changeSetting(name: keyof Settings, value: string | number) {
    setSettings((s) => ({ ...s, [name]: value }));
    if (name === 'baseUrl' || name === 'model') {
      setConnected(false);
      setVision(null);
      setConnectionNote('');
      setSettings((s) => ({ ...s, reasoningEffort: 'default' }));
    }
  }
  async function connection(action: 'save' | 'models' | 'test' | 'vision' | 'clearKey') {
    const id = begin('connecting');
    try {
      if (action === 'clearKey') {
        const d = await api(
          'settings',
          { ...settings, apiKey: '' },
          controller.current!.signal,
          'PUT',
        );
        setHasKey(false);
        setKey('');
        setVision(d.vision);
        setNotice('APIキーをセッションから削除しました。');
        return;
      }
      let config = await applySettings(controller.current!.signal);
      valid(id);
      if (action === 'save') {
        setNotice('設定を保存しました。APIキーはサーバーのメモリ内だけに保持します。');
        return;
      }
      if (action === 'models' || action === 'test') {
        const data = await api('models', {}, controller.current!.signal);
        valid(id);
        setModels(data.models);
        if (!data.models.length) throw new Error('モデル一覧が空です。');
        if (!config.model || !data.models.includes(config.model)) {
          config = { ...config, model: data.models[0] };
          const d = await api('settings', config, controller.current!.signal, 'PUT');
          setSettings(d.settings);
          setVision(d.vision);
        }
        if (action === 'models') {
          setConnectionNote(`${data.models.length}件のモデルを取得しました`);
          return;
        }
      }
      const data = await api(
        'test',
        action === 'vision' ? { image: makeProbeImage() } : {},
        controller.current!.signal,
      );
      valid(id);
      setConnected(true);
      setVision(data.vision);
      setConnectionNote(
        action === 'vision'
          ? `画像応答: ${data.answer.trim()}（青色の確認画像）`
          : `応答確認済み · ${(data.elapsedMs / 1000).toFixed(2)}秒 · ${data.answer.trim()}`,
      );
    } catch (e) {
      report(e, id);
    } finally {
      finish(id);
    }
  }
  function makeProbeImage() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#1946e6';
    ctx.fillRect(0, 0, 64, 64);
    return c.toDataURL('image/png');
  }

  async function prepare(source: string, modelSeed: number, config: Settings, id: number) {
    valid(id);
    const client = new RuntimeClient(viewer.current!, source, modelSeed, config);
    candidate.current = client;
    try {
      const stats = await client.ready;
      valid(id);
      let buffer: ArrayBuffer | undefined;
      if (!stats.warnings.length) {
        const result = await client.call<{ buffer: ArrayBuffer; roundtrip: Stats }>(
          'export',
          {},
          config.runtimeSeconds * 1000,
        );
        buffer = result.buffer;
      }
      valid(id);
      return { client, stats, buffer };
    } catch (e) {
      client.destroy();
      if (candidate.current === client) candidate.current = null;
      throw e;
    }
  }
  function commit(prepared: Awaited<ReturnType<typeof prepare>>, version: Version) {
    const previous = active.current;
    active.current = prepared.client;
    candidate.current = null;
    prepared.client.activate();
    prepared.client.onFatal = (e) => {
      setError(e.message);
      active.current = null;
    };
    // Ask for disposal while yielding briefly, then terminate the old worker.
    if (previous) {
      previous.onFatal = undefined;
      previous
        .call('dispose', {}, 1000)
        .catch(() => {})
        .finally(() => previous.destroy());
    }
    glbCache.current = prepared.buffer ? { id: version.id, buffer: prepared.buffer } : null;
    setWire(false);
    setGrid(true);
    setView('iso');
  }
  async function generate(revise: boolean) {
    if (!prompt.trim()) {
      setError('作りたいモデルの説明を入力してください。');
      return;
    }
    const id = begin('generating');
    try {
      const config = await applySettings(controller.current!.signal);
      valid(id);
      let images: string[] = reference ? [reference] : [];
      if (revise && visual && active.current) {
        setPhase('capturing');
        images = [...images, ...(await active.current.call<string[]>('capture'))];
        valid(id);
      }
      let source = revise ? current?.source : undefined,
        repairError: string | undefined,
        repaired = false;
      let totalMs = 0;
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      const modelSeed = revise && current ? current.seed : seed;
      for (let attempt = 0; attempt <= (autoRepair ? 1 : 0); attempt++) {
        setPhase(attempt ? 'repairing' : 'generating');
        let result;
        try {
          result = await api(
            'generate',
            { prompt, source, images, error: repairError, seed: modelSeed },
            controller.current!.signal,
          );
        } catch (e: any) {
          valid(id);
          if (
            e.code !== 'contract' ||
            !e.details?.rejectedSource ||
            attempt >= (autoRepair ? 1 : 0)
          )
            throw e;
          source = e.details.rejectedSource;
          repairError = e.message;
          repaired = true;
          totalMs += e.details.elapsedMs || 0;
          for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const)
            usage[k] += e.details.usage?.[k] || 0;
          continue;
        }
        valid(id);
        source = result.source;
        totalMs += result.elapsedMs;
        for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const)
          usage[k] += result.usage?.[k] || 0;
        setPhase('validating');
        try {
          const prepared = await prepare(source!, modelSeed, config, id);
          valid(id);
          const version: Version = {
            id: crypto.randomUUID(),
            source: source!,
            prompt,
            seed: modelSeed,
            stats: prepared.stats,
            createdAt: new Date().toISOString(),
            model: result.model,
            elapsedMs: totalMs,
            usage,
            images,
            repaired,
          };
          commit(prepared, version);
          const next = [...history.slice(0, index + 1), version].slice(-20);
          setHistory(next);
          setIndex(next.length - 1);
          setConnected(true);
          setNotice(
            repaired
              ? '自動修復後にモデルとGLB再読込を確認しました。'
              : prepared.stats.warnings.length
                ? 'プレビューを更新しました。GLB互換性のメッセージを確認してください。'
                : 'モデルを生成しました。GLBの保存と再読込も確認済みです。',
          );
          return;
        } catch (e: any) {
          valid(id);
          if (attempt >= (autoRepair ? 1 : 0)) throw e;
          repaired = true;
          repairError = String(e.message).slice(0, 4000);
        }
      }
    } catch (e) {
      report(e, id);
    } finally {
      finish(id);
    }
  }
  async function loadSource(
    source: string,
    label: string,
    version?: Version,
    historyIndex?: number,
  ) {
    const id = begin('loading');
    try {
      const prepared = await prepare(source, version?.seed ?? seed, settings, id);
      valid(id);
      const nextVersion: Version = version
        ? { ...version, stats: prepared.stats }
        : {
            id: crypto.randomUUID(),
            source,
            prompt: label,
            seed,
            stats: prepared.stats,
            createdAt: new Date().toISOString(),
            model: 'local-calibration',
          };
      commit(prepared, nextVersion);
      if (historyIndex !== undefined) {
        setHistory((h) => h.map((v, i) => (i === historyIndex ? nextVersion : v)));
        setIndex(historyIndex);
      } else {
        const next = [...history.slice(0, index + 1), nextVersion].slice(-20);
        setHistory(next);
        setIndex(next.length - 1);
      }
      setNotice(
        'プレビューを表示しました。' +
          (prepared.buffer
            ? 'GLB再読込の寸法・部品・テクスチャ検査も通過しました。'
            : 'GLB互換性を確認してください。'),
      );
    } catch (e) {
      report(e, id);
    } finally {
      finish(id);
    }
  }
  async function openProject(file?: File) {
    if (!file) return;
    const id = begin('loading');
    try {
      const project = await readProject(file);
      valid(id);
      const v = project.versions[project.index];
      const prepared = await prepare(v.source, v.seed, settings, id);
      valid(id);
      const versions = project.versions.map((item) => ({ ...item, stats: prepared.stats }));
      versions[project.index].stats = prepared.stats;
      commit(prepared, versions[project.index]);
      setHistory(versions);
      setIndex(project.index);
      setSeed(v.seed);
      setPrompt(v.prompt);
      setNotice('プロジェクトを復元しました。選択中の版を検証済みです。');
    } catch (e) {
      report(e, id);
    } finally {
      finish(id);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function saveGlb() {
    if (!current) return;
    const id = begin('exporting');
    try {
      let buffer = glbCache.current?.id === current.id ? glbCache.current.buffer : undefined;
      if (!buffer) {
        if (!active.current) throw new Error('「再表示」でプレビューを復元してください。');
        buffer = (await active.current.call('export', {}, settings.runtimeSeconds * 1000)).buffer;
      }
      valid(id);
      download(buffer!, `model-v${index + 1}.glb`, 'model/gltf-binary');
      setNotice(
        `v${index + 1} のGLBを保存しました（${(buffer!.byteLength / 1024).toFixed(0)} KB）。`,
      );
    } catch (e) {
      report(e, id);
    } finally {
      finish(id);
    }
  }
  async function stop() {
    const wasLocal = ['capturing', 'exporting'].includes(phase);
    ++operation.current;
    controller.current?.abort();
    controller.current = null;
    candidate.current?.destroy();
    candidate.current = null;
    if (wasLocal) {
      active.current?.destroy();
      active.current = null;
    }
    setNotice('停止しています…');
    try {
      await api('cancel', {});
      setNotice('処理を停止しました。最後に成功したモデルとソースは保持されています。');
    } catch {
      setError('サーバーへの停止通知に失敗しました。進行中の通信は切断しました。');
    } finally {
      busyRef.current = false;
      setPhase('idle');
    }
  }
  async function control(type: string, data: object) {
    if (busy || !active.current) return;
    try {
      await active.current.call(type, data, settings.runtimeSeconds * 1000);
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function addImage(file?: File) {
    if (!file) return;
    try {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
        file.size > 10 * 1024 * 1024
      )
        throw new Error('参照画像はPNG/JPEG/WebP、10MB以下にしてください。');
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bitmap.width * scale));
      c.height = Math.max(1, Math.round(bitmap.height * scale));
      c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
      bitmap.close();
      setReference(c.toDataURL('image/jpeg', 0.85));
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (imageInput.current) imageInput.current.value = '';
    }
  }
  function saveArchive() {
    try {
      saveProject(history, index);
      setNotice('ソース・履歴・seed・参照画像をプロジェクトに保存しました。');
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Icon name="cube" size={25} />
          </div>
          <div>
            LLM <span>Prefab maker</span>
          </div>
          <span className="local-badge">LOCAL</span>
        </div>
        <div className="header-actions">
          <span className={`connection ${connected ? 'online' : ''}`}>
            <i />
            {connected ? 'Qwen 接続済み' : '接続未確認'}
          </span>
          <button className="quiet" disabled={busy} onClick={() => fileInput.current?.click()}>
            <Icon name="folder" />
            プロジェクトを開く
          </button>
        </div>
      </header>
      <main className="workspace">
        <aside className="sidebar">
          <section className="panel prompt-panel">
            <div className="section-heading">
              <h2>
                <span className="step">01</span>プロンプト
              </h2>
              <span className="caption">PROMPT</span>
            </div>
            <label className="sr-only" htmlFor="prompt">
              モデルの説明・追加指示
            </label>
            <div className="prompt-wrap">
              <textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                maxLength={16000}
                placeholder={
                  '例：丸い天板と3本の脚を持つ、\n明るい木目のサイドテーブル。\n天板の直径は50cm、高さは45cm。'
                }
              />
              <div className="prompt-bottom">
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => imageInput.current?.click()}
                >
                  <Icon name="image" size={16} />
                  {reference ? '参照画像を変更' : '参照画像を追加'}
                </button>
                <span>{prompt.length.toLocaleString()} / 16,000</span>
              </div>
            </div>
            {reference && (
              <div className="reference">
                <img src={reference} alt="生成に送る参照画像" />
                <span>参照画像 · Qwenへ送信</span>
                <button
                  disabled={busy}
                  aria-label="参照画像を削除"
                  onClick={() => setReference(null)}
                >
                  ×
                </button>
              </div>
            )}
            <div className="generate-actions">
              <button
                className="primary"
                disabled={busy || !sessionReady || !prompt.trim()}
                onClick={() => generate(false)}
              >
                モデルを生成
                <Icon name="arrow" />
              </button>
              <button
                className="secondary"
                disabled={busy || !current || !prompt.trim()}
                onClick={() => generate(true)}
              >
                追加指示で修正
              </button>
            </div>
            <div className="options">
              <label>
                <input
                  type="checkbox"
                  checked={visual}
                  disabled={busy || !current}
                  onChange={(e) => setVisual(e.target.checked)}
                />
                プレビュー3方向を見せて修正
              </label>
              <span className={`tiny-tag ${vision ? 'good' : ''}`}>
                {vision ? '画像API確認済み' : '画像対応は設定で確認'}
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={autoRepair}
                  disabled={busy}
                  onChange={(e) => setAutoRepair(e.target.checked)}
                />
                実行エラーを1回まで自動修復
              </label>
            </div>
            <div className={`job-status ${busy ? 'working' : ''}`} role="status">
              <span className={busy ? 'spinner' : 'status-dot'} />
              <div>
                <strong>{phaseText[phase]}</strong>
                <small>
                  {busy
                    ? `${elapsed}秒経過 · 完成したコードを受信してから描画します`
                    : current
                      ? `v${index + 1} · ${current.model}`
                      : '生成すると、ここに制作の状態が表示されます'}
                </small>
              </div>
              {busy && (
                <button className="stop" onClick={stop}>
                  <Icon name="stop" size={14} />
                  停止
                </button>
              )}
            </div>
            {error && (
              <div className="message error" role="alert">
                <strong>処理を完了できませんでした</strong>
                <span>{error}</span>
                <button aria-label="エラーを閉じる" onClick={() => setError('')}>
                  ×
                </button>
              </div>
            )}
            {notice && (
              <div className="message success" role="status">
                {notice}
              </div>
            )}
            {history.length > 0 && (
              <div className="history">
                <div className="history-heading">
                  <span>制作履歴</span>
                  <button
                    disabled={busy || index <= 0}
                    onClick={() =>
                      loadSource(history[index - 1].source, '', history[index - 1], index - 1)
                    }
                  >
                    <Icon name="undo" size={13} />
                    ひとつ戻す
                  </button>
                </div>
                <div className="history-list">
                  {history.map((v, i) => (
                    <button
                      key={v.id}
                      title={v.prompt}
                      className={i === index ? 'selected' : ''}
                      disabled={busy}
                      onClick={() => loadSource(v.source, '', v, i)}
                    >
                      <span>v{String(i + 1).padStart(2, '0')}</span>
                      <b>{v.prompt}</b>
                      {v.repaired && <small>修復</small>}
                      {i === index && <Icon name="check" size={14} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
          <section className="panel settings-panel">
            <div className="section-heading">
              <h2>
                <span className="step">02</span>モデルに接続
              </h2>
              <Icon name="settings" size={17} />
            </div>
            <fieldset disabled={busy || !sessionReady}>
              <label>
                Base URL
                <input
                  value={settings.baseUrl}
                  onChange={(e) => changeSetting('baseUrl', e.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="field-title">
                <label htmlFor="model">Model ID</label>
                <button className="text-button" onClick={() => connection('models')}>
                  一覧を取得 ↻
                </button>
              </div>
              <input
                id="model"
                value={settings.model}
                list="models"
                onChange={(e) => changeSetting('model', e.target.value)}
                spellCheck={false}
              />
              <datalist id="models">
                {models.map((m) => (
                  <option value={m} key={m} />
                ))}
              </datalist>
              <label>
                API Key <span className="optional">任意 · セッション中のみ保持</span>
                <input
                  type="password"
                  value={key}
                  autoComplete="off"
                  placeholder={
                    hasKey ? 'サーバーに設定済み（変更時のみ入力）' : '認証なしの場合は空欄'
                  }
                  onChange={(e) => {
                    setKey(e.target.value);
                    setConnected(false);
                  }}
                />
              </label>
              {hasKey && (
                <button className="text-button" onClick={() => connection('clearKey')}>
                  保持しているキーを削除
                </button>
              )}
              <div className="connection-buttons">
                <button onClick={() => connection('test')}>接続テスト</button>
                <button onClick={() => connection('vision')}>
                  <Icon name="image" size={14} />
                  画像を確認
                </button>
                <button title="設定を保存" onClick={() => connection('save')}>
                  <Icon name="check" size={16} />
                </button>
              </div>
              <p className="field-note">テスト時に短い推論を実行します。</p>
              {connectionNote && <div className="connection-result">{connectionNote}</div>}
              <details>
                <summary>
                  詳細設定<span>トークン・実行予算・seed</span>
                </summary>
                <div className="advanced-grid">
                  {(
                    [
                      ['maxTokens', '出力トークン上限', 256, 262144, 256],
                      ['timeoutSeconds', 'API待機時間（秒）', 5, 1800, 1],
                      ['temperature', 'Temperature', 0, 2, 0.05],
                      ['runtimeSeconds', '実行時間（秒）', 2, 120, 1],
                      ['maxTriangles', '三角形数の上限', 1000, 2000000, 1000],
                      ['maxMeshes', 'メッシュ数の上限', 10, 10000, 10],
                      ['maxTextureSize', 'テクスチャ上限（px）', 128, 4096, 128],
                    ] as const
                  ).map(([name, label, min, max, step]) => (
                    <label key={name}>
                      {label}
                      <input
                        type="number"
                        min={min}
                        max={max}
                        step={step}
                        value={settings[name]}
                        onChange={(e) => changeSetting(name, Number(e.target.value))}
                      />
                    </label>
                  ))}
                  <label>
                    生成seed
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      value={seed}
                      onChange={(e) =>
                        setSeed(
                          Math.max(
                            0,
                            Math.min(2147483647, Math.floor(Number(e.target.value) || 0)),
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Reasoning
                    <select
                      value={settings.reasoningEffort}
                      onChange={(e) => changeSetting('reasoningEffort', e.target.value)}
                    >
                      <option value="low">low（指定WSで検証済み）</option>
                      <option value="default">API既定・指定しない</option>
                    </select>
                  </label>
                </div>
                <p className="field-note">
                  生成は1件ずつ実行。APIキー以外の設定をローカルに保存します。
                </p>
              </details>
            </fieldset>
          </section>
        </aside>
        <section className="preview-panel">
          <div className="preview-heading">
            <div>
              <span className="step">03</span>
              <h2>プレビュー</h2>
              <span className="caption">3D VIEWPORT</span>
            </div>
            <div className="preview-tools">
              <button
                className={showCode ? 'active' : ''}
                disabled={!current}
                onClick={() => setShowCode(!showCode)}
              >
                <Icon name="code" size={16} />
                コード
              </button>
              <span className="unit">m · Y-up</span>
            </div>
          </div>
          <div className="viewport-area">
            <div className="viewport" ref={viewer} />
            {!current && (
              <div className="empty-state">
                <button
                  className="empty-cube"
                  aria-label="校正モデルを試す"
                  disabled={busy}
                  onClick={() =>
                    loadSource(calibrationSource, '校正モデル · 1m立方体・色・階層・テクスチャ')
                  }
                >
                  <Icon name="cube" size={65} />
                </button>
              </div>
            )}
            {busy && ['loading', 'validating', 'repairing'].includes(phase) && (
              <div className="viewport-progress">
                <span className="spinner" />
                {phaseText[phase]}
              </div>
            )}
            {current && (
              <>
                <div className="view-switch">
                  {[
                    ['iso', '全体'],
                    ['front', '正面'],
                    ['side', '側面'],
                    ['top', '上面'],
                  ].map(([v, label]) => (
                    <button
                      key={v}
                      disabled={busy}
                      className={view === v ? 'active' : ''}
                      onClick={() => {
                        setView(v);
                        control('view', { view: v });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="viewport-label">
                  <i />
                  <span>v{String(index + 1).padStart(2, '0')}</span>
                  <b>{current.prompt.slice(0, 32)}</b>
                </div>
                <div className="viewport-bottom">
                  <div className="view-toggles">
                    <button
                      className={grid ? 'active' : ''}
                      disabled={busy}
                      onClick={() => {
                        setGrid(!grid);
                        control('grid', { enabled: !grid });
                      }}
                    >
                      グリッド
                    </button>
                    <button
                      className={wire ? 'active' : ''}
                      disabled={busy}
                      onClick={() => {
                        setWire(!wire);
                        control('wireframe', { enabled: !wire });
                      }}
                    >
                      ワイヤー
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => loadSource(current.source, '', current, index)}
                    >
                      再表示
                    </button>
                  </div>
                  <span>ドラッグ: 回転 · スクロール: ズーム · 右ドラッグ: 移動</span>
                </div>
              </>
            )}
            <div className="axis" aria-hidden="true">
              <span className="y">Y</span>
              <span className="x">X</span>
              <span className="z">Z</span>
            </div>
            {showCode && current && (
              <div className="code-panel">
                <div>
                  <b>createModel.js</b>
                  <button
                    onClick={() => download(current.source, 'createModel.js', 'text/javascript')}
                  >
                    ソースを保存 ↓
                  </button>
                  <button onClick={() => setShowCode(false)}>閉じる ×</button>
                </div>
                <pre>
                  <code>{current.source}</code>
                </pre>
              </div>
            )}
          </div>
          <div className="model-info">
            <div>
              <small>
                寸法 <span>W × H × D</span>
              </small>
              <strong>
                {current ? current.stats.size.map((n) => n.toFixed(3)).join(' × ') : '— × — × —'}{' '}
                <em>m</em>
              </strong>
            </div>
            <div>
              <small>三角形</small>
              <strong>{current?.stats.triangles.toLocaleString() ?? '—'}</strong>
            </div>
            <div>
              <small>メッシュ</small>
              <strong>{current?.stats.meshes ?? '—'}</strong>
            </div>
            <div>
              <small>生成時間 / トークン</small>
              <strong>
                {current?.elapsedMs ? `${(current.elapsedMs / 1000).toFixed(1)}s` : '—'}
                <em> / {current?.usage?.total_tokens?.toLocaleString() ?? '—'}</em>
              </strong>
            </div>
          </div>
          {current?.stats.warnings.length ? (
            <div className="export-warnings">
              <b>GLB保存には変換が必要です</b>
              {current.stats.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
          ) : null}
          <footer className="export-bar">
            <div>
              <Icon name="check" size={17} />
              <span>
                {current
                  ? 'ソースから再編集できる、静的3Dモデル'
                  : 'GLBで出力可能'}
                <small>モデル本体のみを出力 · Blenderなどで編集できます</small>
              </span>
            </div>
            <div>
              <button disabled={!current || busy} onClick={saveArchive}>
                <Icon name="folder" />
                プロジェクト保存
              </button>
              <button
                className="export-button"
                disabled={!current || busy || !!current?.stats.warnings.length}
                onClick={saveGlb}
              >
                <Icon name="down" />
                GLBを保存
              </button>
            </div>
          </footer>
        </section>
      </main>
      <div className="app-footer">
        <span>
          LLM PREFAB MAKER <b> / </b> LOCAL WORKSPACE
        </span>
        <span>three.js r180 · 静的モデル · 生成コードを隔離実行</span>
      </div>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept=".qmodel,.zip"
        onChange={(e) => openProject(e.target.files?.[0])}
      />
      <input
        hidden
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => addImage(e.target.files?.[0])}
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
