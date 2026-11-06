import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withFetch, withInterceptorsFromDi } from '@angular/common/http';

// Open http://localhost:4200/?xhr to run the same app with the XHR backend (control).
export const useXhr = new URLSearchParams(location.search).has('xhr');

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    // Same as the application in the original report.
    // Removing withFetch() (= XHR backend) makes DevTools show every response again.
    provideHttpClient(withInterceptorsFromDi(), ...(useXhr ? [] : [withFetch()])),
  ],
};
