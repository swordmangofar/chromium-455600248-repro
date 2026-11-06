import { Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { useXhr } from './app.config';

interface StockResponse {
  items: { sku: string; warehouse: string; available: number }[];
}

@Component({
  selector: 'app-root',
  template: `
    <h1>crbug.com/455600248: Angular HttpClient + withFetch()</h1>
    <p>
      HttpClient backend: <b>{{ useXhr ? 'XHR (control)' : 'fetch (withFetch())' }}</b> &middot;
      <a [href]="useXhr ? '/' : '/?xhr'">switch to {{ useXhr ? 'fetch' : 'XHR' }}</a>
    </p>
    <ol>
      <li>Open DevTools &rarr; Network.</li>
      <li>Click a button below.</li>
      <li>Select a <code>stock</code> request &rarr; Response / Preview.</li>
    </ol>
    <p>
      With fetch, DevTools shows <i>"Failed to load response data: No data found for resource with
      given identifier"</i>, even though the app received the full JSON below.
    </p>
    <button id="load" (click)="load(1)">POST /api/b2b/v2/stock</button>
    <button id="load10" (click)="load(10)">&times; 10</button>
    <pre>{{ log().join('\\n') }}</pre>
  `,
  styles: `
    :host { display: block; font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
    button { font: inherit; padding: .45rem .9rem; margin-right: .4rem; border-radius: 8px; border: 1px solid #0a66d8; background: #0a66d8; color: #fff; cursor: pointer; }
    pre { font-size: 12px; }
  `,
})
export class App {
  private readonly http = inject(HttpClient);
  protected readonly useXhr = useXhr;
  protected readonly log = signal<string[]>([]);

  async load(times: number) {
    for (let i = 0; i < times; i++) {
      const res = await lastValueFrom(
        this.http.post<StockResponse>('/api/b2b/v2/stock', { search: 'PRODUCT', mc: '8019227374674' }),
      );
      const time = new Date().toISOString().slice(11, 23);
      this.log.update((lines) => [`${time}  app received ${res.items.length} items`, ...lines]);
    }
  }
}
