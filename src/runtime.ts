import type { Settings, Stats } from './types';
const sandbox = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src blob: data:; img-src data: blob:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'"><style>html,body,canvas{margin:0;width:100%;height:100%;display:block;overflow:hidden;touch-action:none}</style></head><body><canvas></canvas><script>
addEventListener('message', function boot(e) {
  if (e.source !== parent || !e.data?.boot || !e.ports[0]) return;
  removeEventListener('message', boot);
  const parentPort = e.ports[0]; const channel = new MessageChannel();
  const blob = new Blob([e.data.worker], {type:'text/javascript'});
  const url = URL.createObjectURL(blob); const worker = new Worker(url); URL.revokeObjectURL(url);
  worker.postMessage({port:channel.port1}, [channel.port1]);
  worker.onerror = event => { parentPort.postMessage({fatal: event.message || 'Workerの起動に失敗しました。'}); };
  channel.port2.onmessage = event => { const msg = event.data; parentPort.postMessage(msg, msg.result?.buffer instanceof ArrayBuffer ? [msg.result.buffer] : []); };
  parentPort.onmessage = event => {
    if (event.data.type === 'terminate') { worker.terminate(); channel.port2.close(); parentPort.close(); return; }
    channel.port2.postMessage(event.data);
  };
  const canvas = document.querySelector('canvas'); const offscreen = canvas.transferControlToOffscreen();
  offscreen.width = Math.min(2400, innerWidth * devicePixelRatio); offscreen.height = Math.min(1600, innerHeight * devicePixelRatio);
  channel.port2.postMessage({id:1,type:'init',data:{...e.data.init,canvas:offscreen}}, [offscreen]);
  let pointer;
  canvas.onpointerdown = e => { pointer = {x:e.clientX,y:e.clientY,pan:e.button===2 || e.shiftKey}; canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = e => { if(!pointer)return; channel.port2.postMessage({id:0,type:pointer.pan?'pan':'orbit',data:{dx:e.clientX-pointer.x,dy:e.clientY-pointer.y}}); pointer.x=e.clientX;pointer.y=e.clientY; };
  canvas.onpointerup = canvas.onpointercancel = () => {pointer=null;};
  canvas.oncontextmenu = e => e.preventDefault();
  canvas.onwheel = e => { e.preventDefault(); channel.port2.postMessage({id:0,type:'zoom',data:{delta:Math.max(-100,Math.min(100,e.deltaY))}}); };
  addEventListener('resize',()=>channel.port2.postMessage({id:0,type:'resize',data:{width:innerWidth*devicePixelRatio,height:innerHeight*devicePixelRatio}}));
});
</script></body></html>`;
let workerSource: Promise<string> | undefined;
export class RuntimeClient {
  iframe: HTMLIFrameElement;
  private port: MessagePort;
  private pending = new Map<
    number,
    { resolve: (x: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private next = 2;
  private dead = false;
  readonly ready: Promise<Stats>;
  onFatal?: (error: Error) => void;
  constructor(container: HTMLElement, source: string, seed: number, settings: Settings) {
    this.iframe = document.createElement('iframe');
    this.iframe.title = '3Dモデルプレビュー';
    this.iframe.sandbox.add('allow-scripts');
    this.iframe.className = 'runtime-frame candidate';
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = ({ data }) => {
      if (data.fatal) {
        this.fail(new Error(data.fatal));
        return;
      }
      const item = this.pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(data.id);
      data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
    };
    this.ready = this.track<Stats>(1, settings.runtimeSeconds * 1000);
    this.iframe.onload = async () => {
      try {
        workerSource ??= fetch('/runtime-worker.js').then((r) => {
          if (!r.ok) throw new Error('実行環境を読み込めません。ビルドを確認してください。');
          return r.text();
        });
        const worker = await workerSource;
        if (this.dead) return;
        this.iframe.contentWindow!.postMessage(
          { boot: true, worker, init: { source, seed, settings } },
          '*',
          [channel.port2],
        );
      } catch (e) {
        workerSource = undefined;
        this.fail(e as Error);
      }
    };
    this.iframe.srcdoc = sandbox;
    container.appendChild(this.iframe);
  }
  private track<T>(id: number, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            '実行時間の上限に達したため、Workerを停止しました。形状を簡単にするか実行時間を増やしてください。',
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  private fail(error: Error) {
    this.onFatal?.(error);
    this.destroy(error);
  }
  call<T = any>(type: string, data: object = {}, timeout = 30000): Promise<T> {
    if (this.dead)
      return Promise.reject(new Error('プレビューは停止中です。「再表示」を押してください。'));
    const id = this.next++;
    const promise = this.track<T>(id, timeout);
    this.port.postMessage({ id, type, data });
    return promise;
  }
  activate() {
    this.iframe.classList.remove('candidate');
  }
  destroy(reason = new Error('処理を停止しました。')) {
    if (this.dead) return;
    this.dead = true;
    this.port.postMessage({ type: 'terminate' });
    this.port.close();
    this.iframe.remove();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }
}
